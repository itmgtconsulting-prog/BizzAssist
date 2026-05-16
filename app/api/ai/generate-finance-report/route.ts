/**
 * POST /api/ai/generate-finance-report
 *
 * BIZZ-1557: AI-genereret teknisk ejendomsbeskrivelse til finansierings-brug
 * (bank/realkredit). Samler BBR, vurdering, tinglysning hæftelser/servitutter,
 * energimærke og plandata for en ejendom og bygger en Claude-prompt til at
 * generere en finansieringsrapport. Streamer svar via SSE.
 *
 * Følger samme mønster som /api/ai/generate-listing (BIZZ-1177) men med
 * fokus på finansiering frem for salg.
 *
 * @param body.bfe      - BFE-nummer for ejendommen
 * @param body.adresse  - Fuld adressestreng
 * @param body.tone     - Rapport-tone: 'realkredit' | 'bankraadgiver' | 'memo'
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

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Rapport-tone-valg */
type FinanceReportTone = 'realkredit' | 'bankraadgiver' | 'memo';

/** Request body */
interface GenerateFinanceReportBody {
  bfe: number;
  adresse: string;
  tone: FinanceReportTone;
}

/** Tone-beskrivelser til system prompt */
const TONE_DESCRIPTIONS: Record<FinanceReportTone, string> = {
  realkredit:
    'Formel, struktureret rapport. Brug overskrifter, tabeller-lignende oversigter og fagsprog egnet til realkreditselskab. Saglig og objektiv tone.',
  bankraadgiver:
    'Samtaleform med key-points fremhævet. Bankrådgiveren skal hurtigt kunne identificere risici og styrker. Brug korte afsnit og fed-markerede konklusioner.',
  memo: 'Kort, bullet-baseret internt memo. Max 400 ord. Fokuser på faktuelle data + risiko-flags. Ingen indledning eller afslutning.',
};

/**
 * Bygger system prompt for finansieringsrapport.
 *
 * @param tone - Valgt rapport-tone
 * @returns System prompt
 */
function buildSystemPrompt(tone: FinanceReportTone): string {
  return `Du er en ejendomsanalytiker der skriver tekniske finansieringsrapporter for danske banker og realkreditselskaber.

Tone: ${TONE_DESCRIPTIONS[tone]}

Rapporten skal indeholde følgende sektioner (kun dem med relevant data):
1. **Identifikation** — adresse, BFE, kommune, zone-status
2. **Tekniske data** — opførelsesår, areal, materialer, energimærke, opvarmning
3. **Vurdering & skat** — offentlig ejendomsværdi, grundværdi, vurderingsår, foreløbig vurdering hvis nyere
4. **Tinglyste forhold** — eksisterende hæftelser (pantebreve), seneste handel, ejer-andele
5. **Servitutter & belastninger** — typer + kort vurdering (værdi-neutral / værdi-reducerende / kræver vurderer)
6. **Plan- og lokalforhold** — lokalplan, bevaringsværdi, klima-risiko hvis relevant
7. **Risiko-flag** — kort sammenfatning til banken: "Ingen vurderingsproblemer" eller liste over forhøjet risiko (servitut/energimærke/bevaringsværdig/kystnær)
8. **Disclaimer** — "Genereret YYYY-MM-DD baseret på offentlige data fra BBR/VUR/Tinglysning. Erstatter ikke en valuar-vurdering."

VIGTIGT:
- Skriv KUN på dansk
- Vær faktuelt nøjagtig — opfind ALDRIG data der ikke er angivet
- Markér FORELØBIG vurdering tydeligt med "(foreløbig)"
- For hæftelser: angiv konkret beløb og kreditor hvis kendt
- Brug markdown med ## overskrifter og **fed** til key-points`;
}

/**
 * Henter ejendomsdata server-side via interne API-routes.
 *
 * @param bfe - BFE-nummer
 * @param host - Request host (til intern fetch)
 * @param cookie - Cookie til auth
 * @returns Sammensat ejendomskontekst til Claude
 */
async function fetchPropertyContext(bfe: number, host: string, cookie: string): Promise<string> {
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const base = `${proto}://${host}`;
  const headers = { cookie };

  // Parallel fetch af alle data-kilder (non-blocking — fejl ignoreres pr. kilde)
  const [bbrRes, vurRes, forelobigRes, energiRes] = await Promise.allSettled([
    fetch(`${base}/api/ejendom/${bfe}`, { headers, signal: AbortSignal.timeout(8000) }),
    fetch(`${base}/api/vurdering?bfeNummer=${bfe}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`${base}/api/vurdering-forelobig?bfeNummer=${bfe}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`${base}/api/energimaerke?bfeNummer=${bfe}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    }),
  ]);

  const parts: string[] = [];

  // BBR — bygnings- og arealdata
  if (bbrRes.status === 'fulfilled' && bbrRes.value.ok) {
    try {
      const data = await bbrRes.value.json();
      const er = data?.ejendomsrelationer?.[0];
      const lines: string[] = [];
      if (er?.bfeNummer) lines.push(`BFE: ${er.bfeNummer}`);
      if (er?.kommunenavn) lines.push(`Kommune: ${er.kommunenavn}`);
      if (er?.ejerlavskode) lines.push(`Ejerlav: ${er.ejerlavskode}`);
      if (er?.matrikelnummer) lines.push(`Matrikelnummer: ${er.matrikelnummer}`);

      const b = data?.bygninger?.[0];
      if (b) {
        if (b.opfoerelsesaar) lines.push(`Opført: ${b.opfoerelsesaar}`);
        if (b.ombygningsaar) lines.push(`Ombygget: ${b.ombygningsaar}`);
        if (b.samletBygningsareal) lines.push(`Bygningsareal: ${b.samletBygningsareal} m²`);
        if (b.samletBoligareal) lines.push(`Boligareal: ${b.samletBoligareal} m²`);
        if (b.samletErhvervsareal) lines.push(`Erhvervsareal: ${b.samletErhvervsareal} m²`);
        if (b.antalEtager) lines.push(`Antal etager: ${b.antalEtager}`);
        if (b.ydervaegMateriale) lines.push(`Ydervæg: ${b.ydervaegMateriale}`);
        if (b.tagMateriale) lines.push(`Tag: ${b.tagMateriale}`);
        if (b.opvarmningsform) lines.push(`Opvarmning: ${b.opvarmningsform}`);
        if (b.supplerendeVarme) lines.push(`Supplerende varme: ${b.supplerendeVarme}`);
        if (b.vandforsyning) lines.push(`Vandforsyning: ${b.vandforsyning}`);
        if (b.bevaringsvaerdighed) lines.push(`Bevaringsværdi: ${b.bevaringsvaerdighed}`);
        if (b.fredning) lines.push(`Fredning: ${b.fredning}`);
      }
      if (lines.length > 0) parts.push(`BBR — tekniske data:\n${lines.join('\n')}`);
    } catch {
      /* ignore */
    }
  }

  // Vurdering — officiel
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
          v.estimereretGrundskyld
            ? `Estimeret årlig grundskyld: ${fmt(v.estimereretGrundskyld)} DKK`
            : null,
        ].filter(Boolean);
        parts.push(`OFFENTLIG VURDERING:\n${lines.join('\n')}`);
      }
    } catch {
      /* ignore */
    }
  }

  // Foreløbig vurdering
  if (forelobigRes.status === 'fulfilled' && forelobigRes.value.ok) {
    try {
      const data = await forelobigRes.value.json();
      const fv = data?.forelobige?.[0];
      if (fv) {
        const fmt = (n: number | null) => (n != null ? n.toLocaleString('da-DK') : null);
        const lines = [
          `Vurderingsår (foreløbig): ${fv.vurderingsaar}`,
          fv.ejendomsvaerdi != null
            ? `Foreløbig ejendomsværdi: ${fmt(fv.ejendomsvaerdi)} DKK`
            : 'Foreløbig ejendomsværdi: fastsættes ikke (erhverv)',
          fv.grundvaerdi != null ? `Foreløbig grundværdi: ${fmt(fv.grundvaerdi)} DKK` : null,
          fv.grundskyld != null ? `Foreløbig grundskyld: ${fmt(fv.grundskyld)} DKK/år` : null,
          fv.totalSkat != null ? `Total ejendomsskat: ${fmt(fv.totalSkat)} DKK/år` : null,
        ].filter(Boolean);
        parts.push(`FORELØBIG VURDERING (markeres tydeligt i rapporten):\n${lines.join('\n')}`);
      }
    } catch {
      /* ignore */
    }
  }

  // Energimærke
  if (energiRes.status === 'fulfilled' && energiRes.value.ok) {
    try {
      const data = await energiRes.value.json();
      const em = data?.maerker?.[0];
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
 * POST handler — genererer finansieringsrapport via Claude (SSE-streaming).
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

  let body: GenerateFinanceReportBody;
  try {
    body = (await request.json()) as GenerateFinanceReportBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.bfe || !body.adresse || !body.tone) {
    return NextResponse.json({ error: 'Mangler bfe, adresse eller tone' }, { status: 400 });
  }

  const validTones: FinanceReportTone[] = ['realkredit', 'bankraadgiver', 'memo'];
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
    logger.error('[ai/generate-finance-report] Ejendomsdata fetch fejl:', err);
    propertyContext = 'Ingen yderligere ejendomsdata tilgængelig.';
  }

  const today = new Date().toISOString().slice(0, 10);
  const userMessage = `Generer en finansieringsrapport for denne ejendom:

ADRESSE: ${body.adresse}
BFE: ${body.bfe}
RAPPORTDATO: ${today}

${propertyContext}

Skriv rapporten i "${body.tone}" tone. Husk disclaimer nederst med dagens dato.`;

  /* ── SSE stream ── */
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sse = (data: string): void => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        const client = new Anthropic({ apiKey });
        const claudeStream = client.messages.stream(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 3072,
            system: buildSystemPrompt(body.tone),
            messages: [{ role: 'user', content: userMessage }],
          },
          { signal: AbortSignal.timeout(50000) }
        );

        for await (const event of claudeStream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            sse(JSON.stringify({ t: event.delta.text }));
          }
        }

        sse('[DONE]');
        controller.close();
      } catch (err) {
        logger.error('[ai/generate-finance-report] Claude fejl:', err);
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
