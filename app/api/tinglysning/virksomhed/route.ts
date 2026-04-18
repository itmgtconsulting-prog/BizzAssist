/**
 * GET /api/tinglysning/virksomhed?cvr=15231599
 *
 * Henter alle dokumenter i Fast ejendom (bog=1) hvor en virksomhed optræder i
 * rollerne "ejer" og "kreditor". Aggregerer på tværs af paginering (25 pr.
 * side) og returnerer én samlet liste pr. rolle.
 *
 * Baggrund (BIZZ-521): Indtil nu har Tinglysning-tab'en på virksomhedsside
 * vist hardcoded "Fast ejendom (0)". Denne route er den autoritative kilde
 * til hvilke ejendomme en virksomhed er ejer af, og hvor virksomheden står
 * som kreditor (pantebreve). Kompletterer Personbogen-opslaget som kun
 * dækker løsøre/virksomhedspant.
 *
 * Endpoint-reference: http_api_beskrivelse_v1.12 afsnit 4.7.1.
 *   /tinglysning/ssl/soegvirksomhed/cvr?cvr={cvr}&bog=1&rolle={ejer|kreditor}
 *     &antal=25&sidetal={n}
 *
 * Retention: Tinglysning-data er offentligt tilgængelig; ingen PII lagres
 * server-side udover midlertidigt CDN-cache (1 time).
 *
 * @param cvr - CVR-nummer (8 cifre)
 * @returns VirksomhedTinglysningData med arrays for ejer/kreditor roller
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { tlFetch } from '@/app/lib/tlFetch';
import { parseQuery } from '@/app/lib/validate';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * En enkelt række i resultatet — én ejendom som virksomheden har en rolle i.
 * Én BFE kan optræde flere gange hvis der er flere dokumenter (fx pantebrev
 * + skøde), men pr. rolle sammenflettes resultaterne ikke.
 */
export interface VirksomhedEjendomsrolle {
  /** BFE-nummer (Bestemt Fast Ejendomsnummer) — nøgle til /dashboard/ejendomme/[id] */
  bfe: number;
  /** Sammensat matrikelnotation — fx "Vigerslev, København, 3178" */
  matrikel: string;
  /** Rolle: "ejer", "kreditor", "anmoder" m.fl. (følger e-TL rolletyper) */
  rolle: string;
  /** Dokument-UUID — brug til /api/tinglysning/dokument for PDF */
  dokumentId: string | null;
  /** Menneskeligt læsbart dato-løbenummer (fx "19921016-900131-01") */
  dokumentAlias: string | null;
  /**
   * Adkomsttype når rolle=ejer (skoede, arv, gave, tvangsauktion, osv.).
   * Null for andre roller.
   */
  adkomstType: string | null;
}

export interface VirksomhedTinglysningData {
  /** Echoed CVR-nummer */
  cvr: string;
  /** Ejendomme hvor virksomheden står som ejer (skøder, arv, osv.) */
  ejer: VirksomhedEjendomsrolle[];
  /** Ejendomme hvor virksomheden står som kreditor (pantebreve) */
  kreditor: VirksomhedEjendomsrolle[];
  /** Fejlbesked ved ekstern API-fejl; data-arrays er tomme når sat */
  fejl?: string;
}

// Rå respons-type fra e-TL — vi parser kun de felter vi behøver.
interface RawSoegResultat {
  VirksomhedSoegResultat?: {
    VirksomhedSoegningInformationSamling?: RawInfo[];
  };
}

interface RawInfo {
  EjendomIdentifikator?: {
    BestemtFastEjendomNummer?: number | string;
    Matrikel?: Array<{
      CadastralDistrictName?: string;
      CadastralDistrictIdentifier?: number | string;
      Matrikelnummer?: number | string;
    }>;
  };
  RolleTypeIdentifikator?: string;
  DokumentRettighedSamling?: Array<{
    DokumentRevisionIdentifikator?: {
      DokumentIdentifikator?: string;
    };
    DokumentAlias?: {
      AktHistoriskIdentifikator?: string;
    };
    AdkomstType?: string;
  }>;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Bygger en menneskelig matrikelstreng fra en Matrikel-array.
 * e-TL returnerer normalt én matrikel pr. ejendom, men arrayen kan indeholde
 * flere — vi joiner med ", " for at være defensiv.
 */
type Matrikel = NonNullable<NonNullable<RawInfo['EjendomIdentifikator']>['Matrikel']>[number];

function formatMatrikel(matrikler?: Matrikel[]): string {
  if (!matrikler || matrikler.length === 0) return '';
  return matrikler
    .map((m: Matrikel) => {
      const parts = [m.CadastralDistrictName, m.Matrikelnummer].filter(
        (v) => v != null && String(v).trim() !== ''
      );
      return parts.join(', ');
    })
    .filter((s: string) => s.length > 0)
    .join(' | ');
}

/**
 * Udtrækker ejendomsrolle-rækker fra e-TL's raw response-objekt.
 * Splitter hvert dokument i DokumentRettighedSamling ud som egen række, så
 * en ejendom med flere dokumenter vises på flere linjer.
 *
 * @param raw - Raw JSON fra soegvirksomhed-endpointet
 * @returns Liste af flade ejendomsrolle-rækker
 */
export function parseVirksomhedSoegResultat(raw: unknown): VirksomhedEjendomsrolle[] {
  const resultat = (raw as RawSoegResultat | null)?.VirksomhedSoegResultat;
  const samling = resultat?.VirksomhedSoegningInformationSamling ?? [];
  const out: VirksomhedEjendomsrolle[] = [];

  for (const info of samling) {
    const bfeRaw = info.EjendomIdentifikator?.BestemtFastEjendomNummer;
    const bfe = typeof bfeRaw === 'number' ? bfeRaw : parseInt(String(bfeRaw ?? ''), 10);
    if (!bfe || !Number.isFinite(bfe)) continue;

    const matrikel = formatMatrikel(info.EjendomIdentifikator?.Matrikel);
    const rolle = info.RolleTypeIdentifikator ?? 'ukendt';
    const dokumenter = info.DokumentRettighedSamling ?? [];

    if (dokumenter.length === 0) {
      // Ingen dokumenter — stadig en gyldig række (fx ved manglende data)
      out.push({
        bfe,
        matrikel,
        rolle,
        dokumentId: null,
        dokumentAlias: null,
        adkomstType: null,
      });
      continue;
    }

    for (const d of dokumenter) {
      out.push({
        bfe,
        matrikel,
        rolle,
        dokumentId: d.DokumentRevisionIdentifikator?.DokumentIdentifikator ?? null,
        dokumentAlias: d.DokumentAlias?.AktHistoriskIdentifikator ?? null,
        adkomstType: rolle === 'ejer' ? (d.AdkomstType ?? null) : null,
      });
    }
  }

  return out;
}

/**
 * Paginerer gennem soegvirksomhed indtil alle resultater er hentet.
 * Hver side rummer `antal` rækker. Stopper når antallet på en side er
 * mindre end `antal` (sidste side) eller efter PAGE_LIMIT sider (safety).
 *
 * @param cvr   - 8-cifret CVR-nummer
 * @param rolle - "ejer" | "kreditor" | andre e-TL rolletyper
 * @returns Aggregeret liste af rækker på tværs af alle sider
 */
async function hentAllePagenerede(
  cvr: string,
  rolle: 'ejer' | 'kreditor'
): Promise<VirksomhedEjendomsrolle[]> {
  const ANTAL = 25;
  const PAGE_LIMIT = 20; // safety cap — 500 dokumenter er rigeligt
  const resultater: VirksomhedEjendomsrolle[] = [];

  for (let sidetal = 1; sidetal <= PAGE_LIMIT; sidetal++) {
    const path = `/soegvirksomhed/cvr?cvr=${cvr}&bog=1&rolle=${rolle}&antal=${ANTAL}&sidetal=${sidetal}`;
    const res = await tlFetch(path, { accept: 'application/json' });

    if (res.status !== 200) {
      // Første side non-200 = reel fejl. Efterfølgende sider non-200
      // betyder normalt at paginering er slut — stop stille.
      if (sidetal === 1) {
        throw new Error(`e-TL soegvirksomhed HTTP ${res.status}`);
      }
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // Ugyldig JSON fra e-TL — behandl som ingen flere resultater
      break;
    }

    const side = parseVirksomhedSoegResultat(parsed);
    resultater.push(...side);

    // Færre end antal per side = sidste side
    if (side.length < ANTAL) break;
  }

  return resultater;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

const querySchema = z.object({
  cvr: z.string().regex(/^\d{8}$/, 'cvr parameter er påkrævet (8 cifre)'),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'cvr parameter er påkrævet (8 cifre)' }, { status: 400 });
  }
  const { cvr } = parsed.data;

  const certOk =
    (process.env.TINGLYSNING_CERT_PATH ||
      process.env.TINGLYSNING_CERT_B64 ||
      process.env.NEMLOGIN_DEVTEST4_CERT_PATH ||
      process.env.NEMLOGIN_DEVTEST4_CERT_B64) &&
    (process.env.TINGLYSNING_CERT_PASSWORD || process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD);

  if (!certOk) {
    const empty: VirksomhedTinglysningData = {
      cvr,
      ejer: [],
      kreditor: [],
      fejl: 'Tinglysning certifikat ikke konfigureret',
    };
    return NextResponse.json(empty);
  }

  try {
    // Hent ejer + kreditor i parallel — hver egen paginerings-løkke.
    // Anmoder/debitor/andre roller er ude af scope for BIZZ-521.
    const [ejer, kreditor] = await Promise.all([
      hentAllePagenerede(cvr, 'ejer'),
      hentAllePagenerede(cvr, 'kreditor'),
    ]);

    const result: VirksomhedTinglysningData = { cvr, ejer, kreditor };

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    logger.error('[tinglysning/virksomhed] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
