/**
 * POST /api/tinglysning/extract-akt
 *
 * AI-ekstraktion af struktureret data fra indskannede tinglysningsakter.
 * Downloader PDF via S2S, sender sider til Claude Vision, returnerer
 * struktureret JSON med ejerskifter, købesum, parter, vilkår.
 *
 * Cache-first: hvis akt allerede er ekstraheret, returnér cached resultat.
 * Kører kun én gang per ejendom/akt-kombination.
 *
 * @param bfe - BFE-nummer
 * @param aktNavn - Akt-filnavn (fra EjendomStamoplysningerHent)
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import * as Sentry from '@sentry/nextjs';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { recordAiUsage } from '@/app/lib/aiTracking';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const maxDuration = 120; // PDF kan være 100+ sider — Claude Vision tager tid

// ─── Types ──────────────────────────────────────────────────────────────────

/** Udtrukkent ejerskifte/handel fra scannet akt. */
export interface ExtractedHandel {
  dato: string | null;
  dokumentType: string | null;
  koeber: { navn: string; adresse: string | null; cpr: string | null; cvr: string | null }[];
  saelger: { navn: string; adresse: string | null }[];
  koebesum: number | null;
  kontantKoebesum: number | null;
  valuta: string;
  stempelafgift: number | null;
  matrikel: string | null;
  adresse: string | null;
  areal: number | null;
  vilkaar: string | null;
  anmelder: string | null;
  sideNr: number | null;
}

/** Udtrukkent hæftelse/pantebrev fra scannet akt. */
export interface ExtractedHaeftelse {
  type: string | null;
  kreditor: string | null;
  debitor: string | null;
  beloeb: number | null;
  rente: string | null;
  dato: string | null;
  status: string | null;
  sideNr: number | null;
}

/** Udtrukkent servitut-tekst fra scannet akt. */
export interface ExtractedServitut {
  type: string | null;
  beskrivelse: string | null;
  dato: string | null;
  paataleberettiget: string | null;
  sideNr: number | null;
}

/** Komplet ekstraktion fra en indskannet akt. */
export interface AktExtraction {
  bfe: number;
  aktNavn: string;
  handler: ExtractedHandel[];
  haeftelser: ExtractedHaeftelse[];
  servitutter: ExtractedServitut[];
  ejendomsInfo: {
    matrikel: string | null;
    adresse: string | null;
    areal: number | null;
    kommune: string | null;
    ejerlav: string | null;
  };
  antalSider: number;
  extractedAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Hent admin Supabase client (service_role — bypasser RLS). */
function getAdmin() {
  return createAdminClient();
}

/** Tjek cache — returnér cached extraction hvis den eksisterer. */
async function getCached(bfe: number, aktNavn: string): Promise<AktExtraction | null> {
  try {
    const admin = getAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from('tinglysning_akt_extraction')
      .select('extraction')
      .eq('bfe_nummer', bfe)
      .eq('akt_navn', aktNavn)
      .maybeSingle();
    if (error) logger.warn('[extract-akt] Cache read error:', error.message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data as any)?.extraction as AktExtraction) ?? null;
  } catch (err) {
    logger.warn('[extract-akt] Cache read exception:', err);
    return null;
  }
}

/** Gem extraction i cache. */
async function saveCache(bfe: number, aktNavn: string, extraction: AktExtraction): Promise<void> {
  try {
    const admin = getAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upsertError } = await (admin as any).from('tinglysning_akt_extraction').upsert(
      {
        bfe_nummer: bfe,
        akt_navn: aktNavn,
        extraction,
        extracted_at: new Date().toISOString(),
      },
      { onConflict: 'bfe_nummer,akt_navn' }
    );
    if (upsertError) {
      logger.error('[extract-akt] Cache upsert error:', upsertError.message, upsertError.code);
    }
  } catch (err) {
    logger.error('[extract-akt] Cache save failed:', err);
  }
}

/** Download akt-PDF via intern API. */
async function downloadAktPdf(
  aktNavn: string,
  host: string,
  cookie: string
): Promise<Buffer | null> {
  try {
    const base = host.startsWith('localhost') ? `http://${host}` : `https://${host}`;
    const res = await fetch(
      `${base}/api/tinglysning/indskannede-akter/download?aktNavn=${encodeURIComponent(aktNavn)}`,
      { headers: { cookie }, signal: AbortSignal.timeout(120000) }
    );
    if (!res.ok || !res.headers.get('content-type')?.includes('pdf')) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// ─── AI Extraction ──────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Du er en ekspert i danske tinglysningsdokumenter. Analysér denne indskannede tingbogsakt GRUNDIGT og udtræk AL struktureret data.

VIGTIGT: Tingbogsakter indeholder HELE ejendommens historie — typisk 50-150 sider med ALLE ejerskifter, pantbreve og servitutter fra ejendommens oprindelse til i dag. Du SKAL finde ALLE ejerskifter — ikke kun det nyeste.

Typiske dokumenttyper du skal lede efter:
- SKØDE (endeligt skøde, betinget skøde, auktionsskøde)
- KØBEKONTRAKT
- ARVEUDLÆG / BOOPGØRELSE
- GAVEBREV
Hvert ejerskifte har typisk en ny side med "GENPART" eller "ENDELIGT SKØDE" som overskrift.

Returnér ET JSON-objekt med disse 4 sektioner:

{
  "ejendomsInfo": {
    "matrikel": "29ck",
    "adresse": "Søbyvej 11, 2650 Hvidovre",
    "areal": 633,
    "kommune": "Hvidovre",
    "ejerlav": "Hvidovre By, Strandmark"
  },
  "handler": [
    {
      "dato": "2003-04-24",
      "dokumentType": "SKØDE",
      "koeber": [{"navn": "Jakob Juul Rasmussen", "adresse": "Vigerslevvej 46B, 2.th, 2500 Valby", "cpr": null, "cvr": null}],
      "saelger": [{"navn": "Martin Knudsen", "adresse": "Søbyvej 11, 2650 Hvidovre"}],
      "koebesum": 1775000,
      "kontantKoebesum": 1775000,
      "valuta": "DKK",
      "stempelafgift": 12000,
      "matrikel": "29ck",
      "adresse": "Søbyvej 11, 2650 Hvidovre",
      "areal": 633,
      "vilkaar": "Lige sameje. Ejendommen sælges som den er med bygninger, installationer, hegn, træer mv.",
      "anmelder": "Jan Anker Rasmussen, Advokat, Købmagergade 45, 1150 København K",
      "sideNr": 1
    }
  ],
  "haeftelser": [
    {
      "type": "Realkreditpantebrev",
      "kreditor": "TOTALKREDIT A/S",
      "debitor": "Jakob Juul Rasmussen",
      "beloeb": 4640000,
      "rente": "variabel",
      "dato": "2020-04-17",
      "status": "gældende",
      "sideNr": null
    }
  ],
  "servitutter": [
    {
      "type": "Forsyningsledninger",
      "beskrivelse": "Dok om forsynings-/afløbsledninger mv",
      "dato": "1934-09-21",
      "paataleberettiget": null,
      "sideNr": null
    }
  ]
}

REGLER:
- Scan ALLE sider grundigt — akten indeholder ejendommens HELE historie (ofte 100+ sider)
- Udtræk ALLE handler/ejerskifter — der er typisk 3-8 ejerskifter i en akt
- Kig efter GENPART-overskrifter, nye stempelafgift-beløb, nye navne — det indikerer nyt ejerskifte
- Dato i ISO format (YYYY-MM-DD). Brug dit bedste skøn for gamle datoer
- Købesum som heltal i DKK (null hvis ikke angivet)
- CPR-numre maskeres: kun de første 6 cifre + "****"
- Gamle håndskrevne/maskinskrevne dokumenter: gør dit bedste, marker usikre felter med null
- INKLUDÉR også handler hvor du kun kan se dato + navn men ikke købesum
- Returnér KUN valid JSON. Ingen forklaring, ingen markdown.`;

async function extractWithAI(
  pdfBase64: string,
  apiKey: string
): Promise<{
  handler: ExtractedHandel[];
  haeftelser: ExtractedHaeftelse[];
  servitutter: ExtractedServitut[];
  ejendomsInfo: AktExtraction['ejendomsInfo'];
  inputTokens: number;
  outputTokens: number;
}> {
  const client = new Anthropic({ apiKey });

  const res = await client.messages.create(
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    },
    { signal: AbortSignal.timeout(90000) }
  );

  // Gem token-usage for debitering
  const inputTokens = res.usage?.input_tokens ?? 0;
  const outputTokens = res.usage?.output_tokens ?? 0;

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Parse JSON fra response — håndter markdown code blocks
  const jsonStr = text
    .replace(/```json?\n?/g, '')
    .replace(/```/g, '')
    .trim();
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      handler: parsed.handler ?? [],
      haeftelser: parsed.haeftelser ?? [],
      servitutter: parsed.servitutter ?? [],
      ejendomsInfo: parsed.ejendomsInfo ?? {
        matrikel: null,
        adresse: null,
        areal: null,
        kommune: null,
        ejerlav: null,
      },
      inputTokens,
      outputTokens,
    };
  } catch {
    logger.warn('[extract-akt] JSON parse failed:', jsonStr.slice(0, 200));
    return {
      handler: [],
      haeftelser: [],
      servitutter: [],
      ejendomsInfo: { matrikel: null, adresse: null, areal: null, kommune: null, ejerlav: null },
      inputTokens,
      outputTokens,
    };
  }
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const limited = await checkRateLimit(req, heavyRateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const gateResult = await assertAiAllowed(auth.userId);
  if (gateResult) return gateResult;

  let body: { bfe: number; aktNavn: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { bfe, aktNavn } = body;
  if (!bfe || !aktNavn) {
    return NextResponse.json({ error: 'bfe og aktNavn er påkrævet' }, { status: 400 });
  }

  // Cache-check — returnér cached resultat hvis det eksisterer
  const cached = await getCached(bfe, aktNavn);
  if (cached) {
    return NextResponse.json({ ...cached, fromCache: true });
  }

  // Download PDF
  const host = req.headers.get('host') ?? 'localhost:3000';
  const cookie = req.headers.get('cookie') ?? '';
  const pdfBuffer = await downloadAktPdf(aktNavn, host, cookie);

  if (!pdfBuffer || pdfBuffer.length < 1000) {
    return NextResponse.json(
      { error: 'Kunne ikke downloade indskannet akt — S2S fejl eller akt ikke fundet' },
      { status: 502 }
    );
  }

  // AI extraction
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Claude API key ikke konfigureret' }, { status: 503 });
  }

  try {
    logger.log(
      `[extract-akt] Extracting BFE ${bfe}, akt ${aktNavn} (${Math.round(pdfBuffer.length / 1024)} KB)`
    );

    const pdfBase64 = pdfBuffer.toString('base64');
    const result = await extractWithAI(pdfBase64, apiKey);

    const extraction: AktExtraction = {
      bfe,
      aktNavn,
      handler: result.handler,
      haeftelser: result.haeftelser,
      servitutter: result.servitutter,
      ejendomsInfo: result.ejendomsInfo,
      antalSider: 0,
      extractedAt: new Date().toISOString(),
    };

    // Gem i cache
    await saveCache(bfe, aktNavn, extraction);

    // BIZZ-1596: Debiter AI-tokens
    await recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'ai.extract-akt',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: 'claude-sonnet-4-6',
    });

    // BIZZ-1598: Backfill handler til fælles ejerskifte_historik
    if (result.handler.length > 0) {
      try {
        const admin = getAdmin();
        const rows = result.handler
          .filter((h) => h.dato)
          .map((h) => ({
            bfe_nummer: bfe,
            overtagelsesdato: h.dato,
            ejer_navn: h.koeber?.[0]?.navn ?? null,
            kontant_koebesum: h.kontantKoebesum ?? h.koebesum,
            i_alt_koebesum: h.koebesum,
            overdragelsesmaade: h.dokumentType,
            kilde: 'ai_extraction',
          }));
        if (rows.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any)
            .from('ejerskifte_historik')
            .upsert(rows, { onConflict: 'bfe_nummer,overtagelsesdato', ignoreDuplicates: true });
          logger.log(`[extract-akt] Backfilled ${rows.length} handler til ejerskifte_historik`);
        }
      } catch (backfillErr) {
        logger.warn('[extract-akt] Backfill fejlede:', backfillErr);
      }
    }

    logger.log(
      `[extract-akt] BFE ${bfe}: fandt ${result.handler.length} handler, ${result.haeftelser.length} hæftelser, ${result.servitutter.length} servitutter (${result.inputTokens + result.outputTokens} tokens)`
    );

    return NextResponse.json({
      ...extraction,
      tokensUsed: result.inputTokens + result.outputTokens,
    });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[extract-akt] AI extraction fejlede:', msg);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
