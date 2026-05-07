/**
 * POST /api/ai/generate-listing
 *
 * BIZZ-1177: AI-drevet boligannonce-generator. Samler BBR, VUR, energimærke
 * og ejerdata for en ejendom og bygger en Claude-prompt til at generere
 * en dansk boligannonce. Streamer svar via SSE.
 *
 * @param body.bfe      - BFE-nummer for ejendommen
 * @param body.adresse  - Fuld adressestreng (til kontekst i annoncen)
 * @param body.tone     - Annonce-tone: 'luksus' | 'familievenlig' | 'investor' | 'erhverv'
 * @returns SSE stream med { t } tekst-chunks og [DONE]
 *
 * @retention Ingen data persisteres — ren AI-generation.
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import {
  fetchComparableSales,
  formatComparablesForPrompt,
  type BoligaPropertyType,
} from '@/app/lib/boliga';
import { fetchNearbyPois, formatPoisForPrompt } from '@/app/lib/nearbyPoi';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** Tone-valg for annoncen */
type ListingTone = 'luksus' | 'familievenlig' | 'investor' | 'erhverv';

/** Request body */
interface GenerateListingBody {
  bfe: number;
  adresse: string;
  tone: ListingTone;
  /** Postnummer — bruges til Boliga sammenlignelige salg (BIZZ-1180) */
  postnummer?: number;
  /** Boligareal i m² — bruges til at finde sammenlignelige (BIZZ-1180) */
  areal?: number;
  /** Boligtype for Boliga søgning (BIZZ-1180) */
  boligtype?: BoligaPropertyType;
  /** Latitude for nærområde-lookup (BIZZ-1181) */
  lat?: number;
  /** Longitude for nærområde-lookup (BIZZ-1181) */
  lon?: number;
}

/** Chunk-størrelse for SSE-streaming (tegn) */
const CHUNK_SIZE = 30;

/** Tone-beskrivelser til system prompt */
const TONE_DESCRIPTIONS: Record<ListingTone, string> = {
  luksus:
    'Eksklusiv og raffineret tone. Brug ord som "udsøgt", "enestående", "premium beliggenhed". Fremhæv luksus-detaljer, materialer og udsigt.',
  familievenlig:
    'Varm og indbydende tone. Fremhæv børnevenlige kvaliteter, nærhed til skoler/legepladser, trygge omgivelser og fællesskab.',
  investor:
    'Faktabaseret og analytisk tone. Fokusér på afkastpotentiale, kvadratmeterpris, area-development, lejepotentiale og værdiudvikling.',
  erhverv:
    'Professionel og saglig tone. Fremhæv beliggenhed ift. transport, synlighed, indretningsfleksibilitet og praktisk infrastruktur.',
};

/**
 * Bygger system prompt for annoncegenerering.
 *
 * @param tone - Valgt annonce-tone
 * @returns System prompt
 */
function buildSystemPrompt(tone: ListingTone): string {
  return `Du er en erfaren dansk ejendomsmægler der skriver professionelle boligannoncer.

TONE: ${TONE_DESCRIPTIONS[tone]}

STRUKTUR (brug denne rækkefølge):
1. **Overskrift** — max 10 ord, fængende og specifik for boligen
2. **Intro** — 2-3 sætninger der fanger læseren og sætter stemningen
3. **Rumbeskrivelse** — beskriv de vigtigste rum baseret på BBR-data (antal værelser, areal, etage)
4. **Beliggenhed** — beskriv nærområdet, transport, indkøb baseret på adressen
5. **Praktisk info** — energimærke, opførelsesår, ejendomsværdi, grundværdi
6. **Afslutning** — opfordring til kontakt/fremvisning

REGLER:
- Skriv på korrekt dansk — ingen anglicismer
- Fakta-først: brug de konkrete tal du modtager, opfind aldrig data
- Maks 500 ord
- Skriv i 2. person ("din nye bolig", "du vil elske")
- Skriv udelukkende annonceteksten — ingen kommentarer, forbehold eller meta-tekst
- Hvis data mangler for et felt, spring det over i stedet for at skrive "ukendt"
- Formatér med markdown (## for overskrift, **fed** for fremhævelser)`;
}

/**
 * Henter ejendomsdata fra interne API-routes server-side.
 * Bruger intern fetch med cookie-forwarding for auth.
 *
 * @param bfe - BFE-nummer
 * @param host - Request host (for intern URL-opbygning)
 * @param cookie - Cookie-header (for auth-forwarding)
 * @returns Samlet ejendomsdata som tekst til prompt
 */
async function fetchPropertyContext(bfe: number, host: string, cookie: string): Promise<string> {
  const base = host.startsWith('localhost') ? `http://${host}` : `https://${host}`;
  const headers = { cookie };
  const timeout = AbortSignal.timeout(10000);

  // Parallel fetch af BBR, vurdering og energimærke
  const [vurRes, energiRes] = await Promise.allSettled([
    fetch(`${base}/api/vurdering?bfeNummer=${bfe}`, { headers, signal: timeout }),
    fetch(`${base}/api/energimaerke?bfeNummer=${bfe}`, { headers, signal: timeout }),
  ]);

  const parts: string[] = [];

  // Vurdering
  if (vurRes.status === 'fulfilled' && vurRes.value.ok) {
    try {
      const data = await vurRes.value.json();
      const v = data?.vurdering;
      if (v) {
        const fmt = (n: number | null) => (n != null ? n.toLocaleString('da-DK') : null);
        const lines = [
          `Ejendomsværdi: ${fmt(v.ejendomsvaerdi) ?? 'ikke vurderet'} DKK`,
          `Grundværdi: ${fmt(v.grundvaerdi) ?? 'ikke vurderet'} DKK`,
          v.vurderingsaar ? `Vurderingsår: ${v.vurderingsaar}` : null,
        ].filter(Boolean);
        parts.push(`VURDERING:\n${lines.join('\n')}`);
      }
    } catch {
      /* ignore */
    }
  }

  // Energimærke
  if (energiRes.status === 'fulfilled' && energiRes.value.ok) {
    try {
      const data = await energiRes.value.json();
      const em = data?.energimaerker?.[0];
      if (em) {
        const lines = [
          `Energimærke: ${em.energimaerke ?? 'ukendt'}`,
          em.gyldigTil ? `Gyldigt til: ${em.gyldigTil}` : null,
        ].filter(Boolean);
        parts.push(`ENERGIMÆRKE:\n${lines.join('\n')}`);
      }
    } catch {
      /* ignore */
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : 'Ingen yderligere ejendomsdata tilgængelig.';
}

/**
 * POST handler — genererer boligannonce via Claude.
 *
 * @param request - POST request med bfe, adresse, tone
 * @returns SSE stream
 */
export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'AI utilgængelig' }, { status: 503 });
  }

  let body: GenerateListingBody;
  try {
    body = (await request.json()) as GenerateListingBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.bfe || !body.adresse || !body.tone) {
    return NextResponse.json({ error: 'Mangler bfe, adresse eller tone' }, { status: 400 });
  }

  const validTones: ListingTone[] = ['luksus', 'familievenlig', 'investor', 'erhverv'];
  if (!validTones.includes(body.tone)) {
    return NextResponse.json({ error: 'Ugyldig tone' }, { status: 400 });
  }

  // Hent ejendomsdata server-side
  const reqHost = request.headers.get('host') ?? 'localhost:3000';
  const cookie = request.headers.get('cookie') ?? '';

  let propertyContext: string;
  try {
    propertyContext = await fetchPropertyContext(body.bfe, reqHost, cookie);
  } catch (err) {
    logger.error('[ai/generate-listing] Ejendomsdata fetch fejl:', err);
    propertyContext = 'Ingen yderligere ejendomsdata tilgængelig.';
  }

  // BIZZ-1181: Hent nærområde-data fra OpenStreetMap (non-blocking)
  let poiContext = '';
  if (body.lat && body.lon) {
    try {
      const pois = await fetchNearbyPois(body.lat, body.lon);
      poiContext = formatPoisForPrompt(pois);
    } catch (err) {
      logger.warn('[ai/generate-listing] POI fetch fejl:', err);
    }
  }

  // BIZZ-1180: Hent sammenlignelige salg fra Boliga (non-blocking)
  let comparablesContext = '';
  if (body.postnummer) {
    try {
      const arealMargin = body.areal ? Math.round(body.areal * 0.3) : undefined;
      const sales = await fetchComparableSales({
        zipCode: body.postnummer,
        propertyType: body.boligtype,
        minSqm: body.areal && arealMargin ? body.areal - arealMargin : undefined,
        maxSqm: body.areal && arealMargin ? body.areal + arealMargin : undefined,
        limit: 5,
      });
      comparablesContext = formatComparablesForPrompt(sales);
    } catch (err) {
      logger.warn('[ai/generate-listing] Boliga fetch fejl:', err);
    }
  }

  const userMessage = `Skriv en boligannonce for denne ejendom:

ADRESSE: ${body.adresse}
BFE: ${body.bfe}

${propertyContext}
${poiContext ? `\n${poiContext}\n` : ''}
${comparablesContext ? `\n${comparablesContext}\n` : ''}
Skriv annoncen i "${body.tone}" tone.${comparablesContext ? ' Brug de sammenlignelige salg som kontekst for prisniveau og positionering — kopiér IKKE deres tekst.' : ''}`;

  /* ── SSE stream ── */
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sse = (data: string): void => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 2048,
            system: buildSystemPrompt(body.tone),
            messages: [{ role: 'user', content: userMessage }],
          },
          { signal: AbortSignal.timeout(20000) }
        );

        const textBlock = response.content.find((b) => b.type === 'text');
        if (textBlock && textBlock.type === 'text') {
          for (let i = 0; i < textBlock.text.length; i += CHUNK_SIZE) {
            sse(JSON.stringify({ t: textBlock.text.slice(i, i + CHUNK_SIZE) }));
          }
        }

        sse('[DONE]');
        controller.close();
      } catch (err) {
        logger.error('[ai/generate-listing] Claude fejl:', err);
        sse(JSON.stringify({ error: 'Ekstern API fejl' }));
        sse('[DONE]');
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
