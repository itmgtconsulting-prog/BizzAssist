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
import { fetchDawa } from '@/app/lib/dawa';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';

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
  // BIZZ-521 follow-up — address-felter beriget server-side via DAWA /bfe/{bfe}
  // så UI kan vise samme design som ejendoms-portefølje (adresse + postnr som
  // overskrift frem for BFE-nummer).
  /** Vejnavn + husnr, fx "Bredegade 12". Null hvis DAWA ikke kender BFE'en. */
  adresse: string | null;
  /** Postnummer, fx "2650" */
  postnr: string | null;
  /** Postdistrikt, fx "Hvidovre" */
  by: string | null;
  /** Kommune-navn, fx "Hvidovre Kommune" */
  kommune: string | null;
  /** DAWA adgangsadresse-UUID til link til ejendoms-detaljeside */
  dawaId: string | null;
  /** Ejendomstype fra DAWA (Normal ejendom / Ejerlejlighed / Landbrug m.fl.) */
  ejendomstype: string | null;
  // ─── BIZZ-570: Hæftelse-data (kun sat for rolle=kreditor) ──────────────────
  /** Hovedstol/beløb fra haeftelse-dokumentet (i hele DKK) */
  haeftelseBeloeb?: number | null;
  /** Hæftelses-type (Realkreditpantebrev / Ejerpantebrev / etc.) */
  haeftelseType?: string | null;
  /** Tinglysningsdato for haeftelsen (ISO yyyy-mm-dd) */
  haeftelseDato?: string | null;
  /** Valuta-kode (typisk DKK) */
  haeftelseValuta?: string | null;
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

/**
 * Intern cache-nøgle per BFE — holder både primary-matrikel og ejerlavskode
 * fra e-TL svaret så vi kan falde tilbage til DAWA /adgangsadresser-opslag
 * hvis /bfe/{bfe} er tom.
 */
interface BfeExtraInfo {
  ejerlavKode: number | null;
  matrikelnr: string | null;
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
export function parseVirksomhedSoegResultat(
  raw: unknown,
  extraOut?: Map<number, BfeExtraInfo>
): VirksomhedEjendomsrolle[] {
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

    // Saml ejerlavskode + matrikelnr til fallback-adresse-opslag.
    // Første matrikel-entry vinder — overwriter ikke hvis BFE allerede set.
    if (extraOut && !extraOut.has(bfe)) {
      const m = info.EjendomIdentifikator?.Matrikel?.[0];
      const kodeRaw = m?.CadastralDistrictIdentifier;
      const ejerlavKode =
        typeof kodeRaw === 'number'
          ? kodeRaw
          : typeof kodeRaw === 'string'
            ? Number(kodeRaw) || null
            : null;
      const matrikelnr = m?.Matrikelnummer != null ? String(m.Matrikelnummer) : null;
      if (ejerlavKode || matrikelnr) {
        extraOut.set(bfe, { ejerlavKode, matrikelnr });
      }
    }

    if (dokumenter.length === 0) {
      // Ingen dokumenter — stadig en gyldig række (fx ved manglende data)
      out.push({
        bfe,
        matrikel,
        rolle,
        dokumentId: null,
        dokumentAlias: null,
        adkomstType: null,
        adresse: null,
        postnr: null,
        by: null,
        kommune: null,
        dawaId: null,
        ejendomstype: null,
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
        adresse: null,
        postnr: null,
        by: null,
        kommune: null,
        dawaId: null,
        ejendomstype: null,
      });
    }
  }

  return out;
}

type AdresseOplysninger = {
  adresse: string | null;
  postnr: string | null;
  by: string | null;
  kommune: string | null;
  dawaId: string | null;
  ejendomstype: string | null;
};

const EMPTY_ADRESSE: AdresseOplysninger = {
  adresse: null,
  postnr: null,
  by: null,
  kommune: null,
  dawaId: null,
  ejendomstype: null,
};

/**
 * Slår adresseoplysninger op for ét BFE. Tre-trins strategi:
 *   1. DAWA /bfe/{bfe} — fungerer for nuværende "samlet fast ejendom"
 *   2. Fallback: DAWA /adgangsadresser?ejerlavkode=X&matrikelnr=Y — dækker
 *      ældre/omnummererede BFE'er så længe matriklen stadig er aktiv
 *   3. Giv op — UI falder tilbage til matrikel-strengen fra e-TL
 *
 * Samme shape som /api/ejendomme-by-owner bruger — holder UI'en konsistent.
 */
async function hentAdresseByBfe(bfe: number, extra?: BfeExtraInfo): Promise<AdresseOplysninger> {
  // Trin 1: DAWA /bfe/{bfe}
  try {
    const res = await fetchDawa(
      `${DAWA_BASE_URL}/bfe/${bfe}`,
      { signal: AbortSignal.timeout(8000), next: { revalidate: 86400 } },
      { caller: 'tinglysning.virksomhed.bfe' }
    );
    if (res.ok) {
      const json = (await res.json()) as {
        ejendomstype?: string;
        beliggenhedsadresse?: {
          id?: string;
          vejnavn?: string;
          husnr?: string;
          postnr?: string;
          postnrnavn?: string;
          kommunenavn?: string;
        };
        jordstykker?: Array<{ husnumre?: Array<{ id?: string }> }>;
      };
      const bel = json.beliggenhedsadresse;
      if (bel?.vejnavn) {
        return {
          adresse: `${bel.vejnavn} ${bel.husnr ?? ''}`.trim(),
          postnr: bel.postnr ?? null,
          by: bel.postnrnavn ?? null,
          kommune: bel.kommunenavn ?? null,
          dawaId: bel.id ?? json.jordstykker?.[0]?.husnumre?.[0]?.id ?? null,
          ejendomstype: json.ejendomstype ?? null,
        };
      }
    }
  } catch {
    // Fald igennem til trin 2
  }

  // Trin 2: Fallback via ejerlav + matrikelnr fra e-TL svaret. Mange
  // historiske BFE'er kender DAWA ikke, men adgangsadresser-endpointet
  // accepterer ejerlavkode + matrikelnr og returnerer nuværende adresse.
  if (extra?.ejerlavKode && extra.matrikelnr) {
    try {
      const url = `${DAWA_BASE_URL}/adgangsadresser?ejerlavkode=${extra.ejerlavKode}&matrikelnr=${encodeURIComponent(extra.matrikelnr)}&struktur=mini&per_side=1`;
      const res = await fetchDawa(
        url,
        { signal: AbortSignal.timeout(6000), next: { revalidate: 86400 } },
        { caller: 'tinglysning.virksomhed.adgangsadresser-fallback' }
      );
      if (res.ok) {
        const arr = (await res.json()) as Array<{
          id?: string;
          vejnavn?: string;
          husnr?: string;
          postnr?: string;
          postnrnavn?: string;
          kommunenavn?: string;
        }>;
        const a = arr?.[0];
        if (a?.vejnavn) {
          return {
            adresse: `${a.vejnavn} ${a.husnr ?? ''}`.trim(),
            postnr: a.postnr ?? null,
            by: a.postnrnavn ?? null,
            kommune: a.kommunenavn ?? null,
            dawaId: a.id ?? null,
            ejendomstype: null,
          };
        }
      }
    } catch {
      // Fald igennem til VP
    }
  }

  // Trin 3: Vurderingsportalen Elasticsearch — samme fallback som
  // /api/ejendomme-by-owner bruger (BIZZ-450). Dækker gamle BFE'er der
  // ikke længere er i DAWA's indeks.
  try {
    const res = await fetch('https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        query: { term: { bfeNumbers: bfe } },
        size: 1,
        _source: [
          'roadName',
          'houseNumber',
          'zipcode',
          'postDistrict',
          'adgangsAdresseID',
          'juridiskKategori',
        ],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        hits?: {
          hits?: Array<{
            _source?: {
              roadName?: string;
              houseNumber?: string;
              zipcode?: string;
              postDistrict?: string;
              adgangsAdresseID?: string;
              juridiskKategori?: string;
            };
          }>;
        };
      };
      const src = data.hits?.hits?.[0]?._source;
      if (src?.roadName) {
        // VP's adgangsAdresseID er ofte forældet — valider mod current DAWA
        // så vi ikke linker til en død adresse-UUID. Drop hvis opslag fejler.
        let freshDawaId: string | null = null;
        if (src.houseNumber && src.zipcode) {
          try {
            const probe = await fetchDawa(
              `${DAWA_BASE_URL}/adgangsadresser?vejnavn=${encodeURIComponent(src.roadName)}&husnr=${encodeURIComponent(src.houseNumber)}&postnr=${encodeURIComponent(src.zipcode)}&struktur=mini&per_side=1`,
              { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
              { caller: 'tinglysning.virksomhed.vp-fresh-dawa-id' }
            );
            if (probe.ok) {
              const arr = (await probe.json()) as Array<{ id?: string }>;
              freshDawaId = arr?.[0]?.id ?? null;
            }
          } catch {
            // Lad freshDawaId være null
          }
        }

        return {
          adresse: `${src.roadName} ${src.houseNumber ?? ''}`.trim(),
          postnr: src.zipcode ?? null,
          by: src.postDistrict ?? null,
          kommune: null,
          dawaId: freshDawaId,
          ejendomstype: src.juridiskKategori ?? null,
        };
      }
    }
  } catch {
    // Fald igennem
  }

  return EMPTY_ADRESSE;
}

/**
 * Beriger en liste af ejendomsrolle-rækker med adresseoplysninger.
 * Slår kun op én gang pr. unikt BFE, selv hvis samme ejendom optræder
 * flere gange (multiple dokumenter → flere rækker).
 *
 * Parallelle opslag, men begrænset concurrency til 8 for at undgå at
 * hamre DAWA når en virksomhed har mange ejendomme.
 */
async function berigMedAdresser(
  rows: VirksomhedEjendomsrolle[],
  extraByBfe: Map<number, BfeExtraInfo>
): Promise<VirksomhedEjendomsrolle[]> {
  const unikkeBfeer = Array.from(new Set(rows.map((r) => r.bfe)));
  const CONCURRENCY = 8;
  const cache = new Map<number, AdresseOplysninger>();

  for (let i = 0; i < unikkeBfeer.length; i += CONCURRENCY) {
    const chunk = unikkeBfeer.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((bfe) => hentAdresseByBfe(bfe, extraByBfe.get(bfe)))
    );
    chunk.forEach((bfe, idx) => cache.set(bfe, results[idx]));
  }

  return rows.map((r) => {
    const enr = cache.get(r.bfe);
    if (!enr) return r;
    return { ...r, ...enr };
  });
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
  rolle: 'ejer' | 'kreditor',
  extraOut: Map<number, BfeExtraInfo>
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

    const side = parseVirksomhedSoegResultat(parsed, extraOut);
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

/**
 * BIZZ-570: Henter haeftelse-beløb + type + dato fra dokaktuel-XML for hver
 * kreditor-række (mutates rows in-place). Capped parallelisme for at undgå
 * at presse Tinglysning's API. Fejl pr. dokument logges men blokerer ikke.
 */
async function berigMedHaeftelseBeloeb(rows: VirksomhedEjendomsrolle[]): Promise<void> {
  const CONCURRENCY = 5;
  const targets = rows.filter((r) => r.dokumentId);
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (r) => {
        try {
          const result = await tlFetch(`/dokaktuel/uuid/${r.dokumentId}`, {
            accept: 'application/xml',
            timeout: 10000,
          });
          if (result.status !== 200) return;
          const xml = result.body;
          // Beløb: BeloebVaerdi (hovedstol)
          const beloebStr = xml.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1];
          const beloeb = beloebStr ? parseInt(beloebStr, 10) : null;
          // Type: HaeftelseType
          const type = xml.match(/HaeftelseType[^>]*>([^<]+)/)?.[1] ?? null;
          // Dato
          const dato = xml.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? null;
          // Valuta
          const valuta = xml.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? null;
          if (beloeb != null) r.haeftelseBeloeb = beloeb;
          if (type) r.haeftelseType = type;
          if (dato) r.haeftelseDato = dato;
          if (valuta) r.haeftelseValuta = valuta;
        } catch (err) {
          logger.warn(
            `[tinglysning/virksomhed] haeftelse-beriging fejlede for ${r.dokumentId}:`,
            err instanceof Error ? err.message : err
          );
        }
      })
    );
  }
}

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
    // extraByBfe samler ejerlav+matrikel per BFE til fallback-opslag.
    const extraByBfe = new Map<number, BfeExtraInfo>();
    const [ejerRaw, kreditorRaw] = await Promise.all([
      hentAllePagenerede(cvr, 'ejer', extraByBfe),
      hentAllePagenerede(cvr, 'kreditor', extraByBfe),
    ]);

    // Berig BFE'er med adresseoplysninger: DAWA /bfe/{bfe} → fallback til
    // /adgangsadresser?ejerlavkode=X&matrikelnr=Y for ældre BFE'er.
    const [ejer, kreditor] = await Promise.all([
      berigMedAdresser(ejerRaw, extraByBfe),
      berigMedAdresser(kreditorRaw, extraByBfe),
    ]);

    // BIZZ-570: Berig kreditor-rækker med hæftelse-beløb fra dokumentet.
    // Capped concurrency så mange ejendomme ikke overbelaster Tinglysning.
    await berigMedHaeftelseBeloeb(kreditor);

    const result: VirksomhedTinglysningData = { cvr, ejer, kreditor };

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    logger.error('[tinglysning/virksomhed] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
