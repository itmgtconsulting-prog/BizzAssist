/**
 * GET /api/ejendom-struktur
 *
 * Bygger det fulde ejendomshierarki (SFE → Hovedejendom → Ejerlejlighed)
 * for en given matrikel. Bruger Tinglysningsrettens matrikelsøgning til at
 * finde alle ejendomme og klassificerer dem i 3 niveauer. Henter vurdering
 * for hver hovedejendom via VUR GraphQL. Resolver DAWA-ID'er for navigation.
 *
 * Query params:
 *   - ejerlavKode: string (ejerlav kode)
 *   - matrikelnr: string (matrikelnummer)
 *   - sfeBfe: number (optional — BFE for den aktuelle SFE, bruges til at tagge root)
 *
 * @returns EjendomStrukturResponse med tree-struktur
 */

import { NextRequest, NextResponse } from 'next/server';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { fetchDawa } from '@/app/lib/dawa';
import { createAdminClient } from '@/lib/supabase/admin';
import { hentBfeAdresser, formatBfeLabel } from '@/app/lib/bfeAdresse';
import { fetchEjfEjereDirekt } from '@/app/lib/ejerskab/fetchEjfEjereDirekt';

// ─── Query param validation ─────────────────────────────────────────────────

const strukturQuerySchema = z
  .object({
    ejerlavKode: z.string().regex(/^\d+$/).optional(),
    matrikelnr: z.string().min(1).optional(),
    sfeBfe: z.coerce.number().int().positive().optional(),
  })
  .refine((d) => (d.ejerlavKode && d.matrikelnr) || d.sfeBfe, {
    message: 'Enten ejerlavKode+matrikelnr eller sfeBfe er påkrævet',
  });

// ─── Types ──────────────────────────────────────────────────────────────────

/** Klassificering af en node i ejendomshierarkiet */
export type StrukturNiveau = 'sfe' | 'hovedejendom' | 'ejerlejlighed' | 'soester-sfe';

/** En enkelt node i ejendomsstrukturtræet */
export interface StrukturNode {
  bfe: number;
  adresse: string;
  niveau: StrukturNiveau;
  /** DAWA adresse-UUID for navigation til ejendomsdetalje */
  dawaId: string | null;
  /** Ejendomsværdi fra vurdering (kun for hovedejendomme) */
  ejendomsvaerdi: number | null;
  /** Grundværdi fra vurdering (kun for hovedejendomme) */
  grundvaerdi: number | null;
  /** Vurderingsår */
  vurderingsaar: number | null;
  /** Tinglysningens ejendomsvurdering (fallback) */
  tlVurdering: number | null;
  /** Areal i m² (fra BBR/TL — beriges klient-side) */
  areal: number | null;
  /** Antal værelser (fra BBR — beriges klient-side) */
  vaerelser: number | null;
  /** Ejer-navn (beriges klient-side fra lejligheder-data) */
  ejer: string | null;
  /** Ejer-type: person/selskab/ukendt */
  ejertype: 'person' | 'selskab' | 'ukendt' | null;
  /** Købspris i DKK */
  koebspris: number | null;
  /** Købsdato (ISO) */
  koebsdato: string | null;
  /** Underliggende ejendomme */
  children: StrukturNode[];
}

/** API-svar */
export interface EjendomStrukturResponse {
  tree: StrukturNode | null;
  fejl: string | null;
}

// ─── Tinglysning mTLS ───────────────────────────────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';
const TL_API_PATH = '/tinglysning/ssl';

/** Tinglysning søge-item */
interface TLSearchItem {
  uuid: string;
  adresse: string;
  vedroerende: string;
  ejendomsVurdering: number | null;
  grundVaerdi: number | null;
  vurderingsDato: string | null;
  /**
   * BIZZ-2058: Dette er det KOMMUNALE ESR-ejendomsnummer (entydigt KUN sammen
   * med kommuneNummer), IKKE et BFE-nummer. Må aldrig bruges som BFE — det
   * reelle BFE (BestemtFastEjendomNummer) hentes via ejdsummarisk-opslag på uuid.
   */
  ejendomsnummer: string | null;
  kommuneNummer: string | null;
}

/**
 * HTTPS request med client-certifikat (mTLS) til Tinglysningsretten.
 *
 * @param urlPath - URL-sti efter /tinglysning/ssl/
 * @returns HTTP status + body
 */
function tlFetch(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    if (CERT_B64) {
      pfx = Buffer.from(CERT_B64, 'base64');
    } else {
      const certAbsPath = path.resolve(CERT_PATH);
      if (!fs.existsSync(certAbsPath)) {
        reject(new Error('Certifikat ikke fundet: ' + certAbsPath));
        return;
      }
      pfx = fs.readFileSync(certAbsPath);
    }
    const url = new URL(TL_BASE + TL_API_PATH + urlPath);

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        pfx,
        passphrase: CERT_PASSWORD,
        rejectUnauthorized: false,
        timeout: 15000,
        headers: { Accept: 'application/json, application/xml, */*' },
      },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body }));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

/** BIZZ-2095: Data parset fra et ejdsummarisk-svar */
interface TLSummarisk {
  bfe: number;
  /** Kontant/i alt-købesum fra seneste skøde (DKK) */
  koebspris: number | null;
  /** Overtagelses- eller tinglysningsdato for skødet (ISO) */
  koebsdato: string | null;
}

/**
 * BIZZ-2058: Henter det reelle BFE-nummer (BestemtFastEjendomNummer) for en
 * TL-ejendom via ejdsummarisk-opslag på dens uuid.
 *
 * TL-søgesvar indeholder kun det kommunale ESR-ejendomsnummer, ikke BFE.
 * ejdsummarisk-opslaget returnerer XML (EjendomSummariskHentResultat) hvor
 * <ns7:BestemtFastEjendomNummer> er det entydige BFE.
 *
 * BIZZ-2095: Parser desuden skøde-købesum og overtagelsesdato fra samme
 * svar (SkoedeKoebesum/KontantKoebesum + SkoedeOvertagelsesDato) — ingen
 * ekstra kald, så hovedejendom-rækker kan vise købspris/-dato.
 *
 * @param uuid - TL-objektets uuid fra søgesvaret
 * @returns Parsede summarisk-data eller null hvis opslaget fejlede
 */
async function fetchBfeFromUuid(uuid: string): Promise<TLSummarisk | null> {
  try {
    const res = await tlFetch(`/ejdsummarisk/${uuid}`);
    if (res.status !== 200) return null;
    const m = res.body.match(/BestemtFastEjendomNummer>\s*(\d+)/i);
    if (!m) return null;

    // Skøde-købesum: foretrak kontant, fald tilbage til "i alt"
    const koebesumMatch =
      res.body.match(/KontantKoebesum>\s*([\d.]+)/i) ?? res.body.match(/IAltKoebesum>\s*([\d.]+)/i);
    const koebspris = koebesumMatch ? parseInt(koebesumMatch[1].replace(/\./g, ''), 10) : null;

    // Overtagelsesdato fra skødet (fald tilbage til tinglysningsdato)
    const datoMatch =
      res.body.match(/SkoedeOvertagelsesDato>\s*(\d{4}-\d{2}-\d{2})/i) ??
      res.body.match(/TinglysningsDato>\s*(\d{4}-\d{2}-\d{2})/i);

    return {
      bfe: parseInt(m[1], 10),
      koebspris: koebspris != null && Number.isFinite(koebspris) ? koebspris : null,
      koebsdato: datoMatch ? datoMatch[1] : null,
    };
  } catch {
    return null;
  }
}

/**
 * BIZZ-2058: Batch-resolver reelle BFE-numre (+ købesum/dato, BIZZ-2095) for
 * en liste af TL-uuid'er. Kalder ejdsummarisk parallelt så vi får korrekt BFE
 * for hver ejendom frem for at fejltolke det kommunale ESR-nummer som BFE.
 *
 * @param uuids - TL-objekt-uuid'er
 * @returns Map fra uuid → summarisk-data (kun entries der kunne resolves)
 */
async function fetchBfeBatch(uuids: string[]): Promise<Map<string, TLSummarisk>> {
  const map = new Map<string, TLSummarisk>();
  const results = await Promise.all(
    uuids.map(async (uuid) => ({ uuid, data: await fetchBfeFromUuid(uuid) }))
  );
  for (const { uuid, data } of results) {
    if (data && data.bfe > 0) map.set(uuid, data);
  }
  return map;
}

// ─── VUR GraphQL helper ─────────────────────────────────────────────────────

/** VUR-resultat per BFE */
interface VurResult {
  ejendomsvaerdi: number | null;
  grundvaerdi: number | null;
  aar: number | null;
}

/**
 * BIZZ-1214: Batch-henter ejendomsvurderinger fra Datafordeler VUR GraphQL.
 * Samler alle BFE'er i ét GraphQL-kald i stedet for N separate kald.
 *
 * @param bfeList - Array af BFE-numre
 * @returns Map fra BFE → vurderingsdata
 */
async function fetchVurderingBatch(bfeList: number[]): Promise<Map<number, VurResult>> {
  const result = new Map<number, VurResult>();
  if (bfeList.length === 0) return result;

  try {
    const token = await getSharedOAuthToken();
    if (!token) return result;

    const query = `query($bfe: [Int!]!) {
      VUR_BFEKrydsreference(where: { BFEnummer: { in: $bfe } }) {
        nodes {
          BFEnummer
          VUR_Ejendomsvurdering {
            nodes {
              ejendomsvaerdi
              grundvaerdi
              vurderingsaar
            }
          }
        }
      }
    }`;

    const VUR_GQL_URL = 'https://graphql.datafordeler.dk/VUR/v2';
    const resp = await fetch(proxyUrl(VUR_GQL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query, variables: { bfe: bfeList } }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });

    if (!resp.ok) return result;

    const data = (await resp.json()) as {
      data?: {
        VUR_BFEKrydsreference?: {
          nodes?: Array<{
            BFEnummer: number;
            VUR_Ejendomsvurdering?: {
              nodes?: Array<{
                ejendomsvaerdi: number | null;
                grundvaerdi: number | null;
                vurderingsaar: number | null;
              }>;
            };
          }>;
        };
      };
    };

    for (const node of data.data?.VUR_BFEKrydsreference?.nodes ?? []) {
      const vurderinger = node.VUR_Ejendomsvurdering?.nodes ?? [];
      if (vurderinger.length === 0) continue;
      const nyeste = vurderinger.reduce((a, b) =>
        (b.vurderingsaar ?? 0) > (a.vurderingsaar ?? 0) ? b : a
      );
      result.set(node.BFEnummer, {
        ejendomsvaerdi: nyeste.ejendomsvaerdi,
        grundvaerdi: nyeste.grundvaerdi,
        aar: nyeste.vurderingsaar,
      });
    }
  } catch (err) {
    logger.warn(`[ejendom-struktur] VUR batch fetch fejl:`, err);
  }
  return result;
}

// ─── Ejerskabs-berigelse fra ejf_ejerskab ─────────────────────────────────

/** Ejerskabsdata per BFE */
interface EjerInfo {
  ejerNavn: string;
  ejerType: 'person' | 'selskab' | 'ukendt';
}

/**
 * BIZZ-2060: Batch-henter ejerskabsdata fra ejf_ejerskab for en liste af BFE'er.
 * Returnerer Map fra BFE → ejer-info (kun gældende ejerskifter).
 * Slår CVR-navne op i cvr_virksomhed for virksomhedsejere.
 *
 * @param bfeList - Array af BFE-numre
 * @returns Map fra BFE → EjerInfo
 */
async function fetchEjerskabBatch(bfeList: number[]): Promise<Map<number, EjerInfo>> {
  const result = new Map<number, EjerInfo>();
  if (bfeList.length === 0) return result;

  try {
    const supabase = createAdminClient();

    // Hent gældende ejerskaber for alle BFE'er
    const { data: rawEjerskaber } = await supabase
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_navn, ejer_cvr, ejer_type')
      .in('bfe_nummer', bfeList)
      .eq('status', 'gældende')
      .order('virkning_fra', { ascending: false });

    const ejerskaber = (rawEjerskaber ?? []) as Array<{
      bfe_nummer: number;
      ejer_navn: string | null;
      ejer_cvr: number | null;
      ejer_type: string | null;
    }>;
    if (ejerskaber.length === 0) return result;

    // Saml CVR-numre der skal resolves til navne
    const cvrSet = new Set<string>();
    for (const e of ejerskaber) {
      if (e.ejer_cvr && e.ejer_type === 'virksomhed') {
        cvrSet.add(String(e.ejer_cvr));
      }
    }

    // Batch-hent CVR-navne fra cvr_virksomhed
    const cvrNavnMap = new Map<string, string>();
    if (cvrSet.size > 0) {
      const { data: rawVirksomheder } = await supabase
        .from('cvr_virksomhed')
        .select('cvr, navn')
        .in('cvr', Array.from(cvrSet));

      for (const v of (rawVirksomheder ?? []) as Array<{ cvr: string; navn: string }>) {
        if (v.cvr && v.navn) cvrNavnMap.set(String(v.cvr), v.navn);
      }
    }

    // Map til resultat — kun første (nyeste) ejer per BFE
    for (const e of ejerskaber) {
      if (result.has(e.bfe_nummer)) continue; // allerede sat (nyeste virkning_fra først)

      let navn: string;
      if (e.ejer_type === 'virksomhed' && e.ejer_cvr) {
        navn = cvrNavnMap.get(String(e.ejer_cvr)) ?? e.ejer_navn ?? `CVR ${e.ejer_cvr}`;
      } else if (e.ejer_type === 'person' && !e.ejer_navn) {
        // BIZZ-2111: person uden navn fra EJF = navne- og adressebeskyttet —
        // vi kender ejertypen, kun navnet er beskyttet. GDPR: vis aldrig navnet
        // fra andre kilder (fx tinglysnings-dokumenter) når EJF beskytter det.
        navn = 'Navne- og adressebeskyttet';
      } else {
        navn = e.ejer_navn ?? 'Ukendt';
      }

      result.set(e.bfe_nummer, {
        ejerNavn: navn,
        ejerType:
          e.ejer_type === 'virksomhed' ? 'selskab' : e.ejer_type === 'person' ? 'person' : 'ukendt',
      });
    }
  } catch (err) {
    logger.warn('[ejendom-struktur] Ejerskab batch fetch fejl:', err);
  }

  // BIZZ-2111 (reopen): BFE'er uden gældende cache-række — delta-syncen har
  // historiske huller, og navnebeskyttede ejerskifter blev tidligere droppet
  // helt af ingesten. Live EJF-opslag (capped, så trælatensen er bounded;
  // routen er s-maxage-cachet) henter den aktuelle ejer. Gældende personejer
  // med null navn = navne- og adressebeskyttet — labelen SKAL sættes her, så
  // UI'et ikke viser tomt/historisk navn for en beskyttet persons ejendom.
  const missing = bfeList.filter((b) => !result.has(b)).slice(0, 15);
  const LIVE_CONCURRENCY = 5;
  for (let i = 0; i < missing.length; i += LIVE_CONCURRENCY) {
    const batch = missing.slice(i, i + LIVE_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (bfe) => {
        try {
          const { ejere } = await fetchEjfEjereDirekt(bfe);
          const e = ejere[0];
          if (!e) return;
          const navn = e.personNavn ?? e.virksomhedsnavn ?? null;
          if (navn || e.cvr) {
            result.set(bfe, {
              ejerNavn: navn ?? `CVR ${e.cvr}`,
              ejerType:
                e.ejertype === 'person'
                  ? 'person'
                  : e.ejertype === 'selskab'
                    ? 'selskab'
                    : 'ukendt',
            });
          } else if (e.ejertype === 'person') {
            result.set(bfe, { ejerNavn: 'Navne- og adressebeskyttet', ejerType: 'person' });
          }
        } catch {
          /* live-opslag non-fatal — node vises uden ejer */
        }
      })
    );
  }
  return result;
}

// ─── Søster-SFE'er (BIZZ-2094) ──────────────────────────────────────────────

/**
 * BIZZ-2094: Finder søster-SFE'er til root-SFE'en — separate SFE'er på
 * nabo-matrikler i samme ejerlav med samme gældende ejer (ejf_ejerskab
 * ejer_cvr). Resights grupperer pr. vurderingsejendom, som kan spænde over
 * flere SFE'er; VUR GraphQL eksponerer ikke vurderingsejendom-koblingen
 * (VUR_BFEKrydsreference har kun BFEnummer — probet 2026-06-12), så
 * ejer+ejerlav-fallback er den dokumenterede strategi fra ticketen.
 *
 * Adresser resolves via den fælles BFE→adresse-lib (BIZZ-2093) med
 * matrikelbetegnelse som fallback for ubebyggede grunde.
 *
 * @param rootBfe - Root-SFE'ens BFE-nummer
 * @param ejerlavKode - Root-matriklens ejerlavkode (geografisk afgrænsning)
 * @param excludeBfes - BFE'er der allerede er i træet
 * @returns Søster-SFE-noder (tom liste ved person-ejer eller fejl)
 */
async function fetchSoesterSfeNodes(
  rootBfe: number,
  ejerlavKode: string,
  excludeBfes: Set<number>
): Promise<StrukturNode[]> {
  try {
    const supabase = createAdminClient();

    // 1) Gældende virksomheds-ejere (CVR) for root-SFE'en
    const { data: rootEjere } = await supabase
      .from('ejf_ejerskab')
      .select('ejer_cvr')
      .eq('bfe_nummer', rootBfe)
      .eq('status', 'gældende')
      .not('ejer_cvr', 'is', null)
      .limit(5);
    const cvrs = [
      ...new Set(
        ((rootEjere ?? []) as Array<{ ejer_cvr: string | number | null }>)
          .map((r) => String(r.ejer_cvr ?? ''))
          .filter((c) => c.length > 0)
      ),
    ];
    if (cvrs.length === 0) return [];

    // 2) Ejerens øvrige gældende BFE'er (kandidater)
    const { data: andre } = await supabase
      .from('ejf_ejerskab')
      .select('bfe_nummer')
      .in('ejer_cvr', cvrs)
      .eq('status', 'gældende')
      .neq('bfe_nummer', rootBfe)
      .limit(200);
    const kandidater = [
      ...new Set(((andre ?? []) as Array<{ bfe_nummer: number }>).map((r) => r.bfe_nummer)),
    ]
      .filter((b) => b > 0 && !excludeBfes.has(b))
      .slice(0, 80);
    if (kandidater.length === 0) return [];

    // 3) Geografisk afgrænsning: kun BFE'er med jordstykke i samme ejerlav.
    // DAWA-opslag pr. kandidat med begrænset parallelisme.
    const matchende: Array<{ bfe: number; matrikelLabel: string }> = [];
    const KONK = 8;
    for (let i = 0; i < kandidater.length; i += KONK) {
      const chunk = kandidater.slice(i, i + KONK);
      const res = await Promise.all(
        chunk.map(async (bfe) => {
          try {
            const r = await fetchDawa(
              `https://api.dataforsyningen.dk/jordstykker?bfenummer=${bfe}&struktur=mini`,
              { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
              { caller: 'ejendom-struktur.soester-ejerlav' }
            );
            if (!r.ok) return null;
            const js = (await r.json()) as Array<{
              ejerlavkode?: number;
              ejerlavnavn?: string;
              matrikelnr?: string;
            }>;
            const match = js.find((j) => String(j.ejerlavkode ?? '') === ejerlavKode);
            if (!match) return null;
            return {
              bfe,
              matrikelLabel: `${match.matrikelnr ?? ''} ${match.ejerlavnavn ?? ''}`.trim(),
            };
          } catch {
            return null;
          }
        })
      );
      for (const m of res) if (m) matchende.push(m);
    }
    if (matchende.length === 0) return [];

    // 4) Adresser (fælles lib, BIZZ-2093) + ejer-navne i batch
    const soesterBfes = matchende.map((m) => m.bfe);
    const [adresser, ejerMap] = await Promise.all([
      hentBfeAdresser(soesterBfes),
      fetchEjerskabBatch(soesterBfes),
    ]);

    const nodes: StrukturNode[] = matchende.map(({ bfe, matrikelLabel }) => {
      const adr = adresser.get(bfe) ?? null;
      const ejer = ejerMap.get(bfe);
      return {
        bfe,
        adresse: formatBfeLabel(adr) ?? matrikelLabel ?? `BFE ${bfe}`,
        niveau: 'soester-sfe' as const,
        dawaId: adr?.dawaId ?? null,
        ejendomsvaerdi: null,
        grundvaerdi: null,
        vurderingsaar: null,
        tlVurdering: null,
        areal: null,
        vaerelser: null,
        ejer: ejer?.ejerNavn ?? null,
        ejertype: ejer?.ejerType ?? null,
        koebspris: null,
        koebsdato: null,
        children: [],
      };
    });
    nodes.sort((a, b) => a.adresse.localeCompare(b.adresse, 'da'));
    return nodes;
  } catch (err) {
    logger.warn('[ejendom-struktur] søster-SFE opslag fejlede:', err);
    return [];
  }
}

// ─── DAWA adresse-resolver ──────────────────────────────────────────────────

/**
 * Resolver DAWA adresse-ID (UUID) fra en TL-adressestreng.
 * Parser vejnavn, husnummer, postnummer og slår op i DAWA /adresser eller
 * /adgangsadresser for at finde UUID til navigation.
 *
 * @param tlAdresse - Tinglysnings-adresse (f.eks. "Arnold Nielsens Boulevard 62A, 2650 Hvidovre")
 * @param etage - Etage (for ejerlejligheder)
 * @param doer - Dør (for ejerlejligheder)
 * @returns DAWA UUID eller null
 */
async function resolveDawaId(
  tlAdresse: string,
  etage: string | null,
  doer: string | null
): Promise<string | null> {
  try {
    const parts = tlAdresse.split(',').map((s) => s.trim());
    const streetPart = parts[0];
    const m = streetPart.match(/^(.+?)\s+(\d+\w*)$/);
    if (!m) return null;
    const vejnavn = m[1];
    const husnummer = m[2];
    // Postnummer: find 4-cifret tal i adressestreng
    const postMatch = tlAdresse.match(/(\d{4})/);
    if (!postMatch) return null;
    const postnr = postMatch[1];

    // For ejerlejligheder: søg med etage/dør for specifik adresse-UUID
    if (etage) {
      const params = new URLSearchParams({
        vejnavn,
        husnr: husnummer,
        postnr,
        etage,
        struktur: 'mini',
      });
      if (doer) params.set('dør', doer);
      const res = await fetchDawa(
        `https://dawa.aws.dk/adresser?${params}`,
        { signal: AbortSignal.timeout(5000) },
        { caller: 'ejendom-struktur.dawa-adresse' }
      );
      if (res.ok) {
        const arr = (await res.json()) as Array<{ id: string }>;
        if (arr.length > 0) return arr[0].id;
      }
    }

    // For SFE/hovedejendom: søg adgangsadresse (uden etage)
    // Prøv først eksakt match, derefter fritekst-fallback
    const params = new URLSearchParams({
      vejnavn,
      husnr: husnummer,
      postnr,
      struktur: 'mini',
    });
    const res = await fetchDawa(
      `https://dawa.aws.dk/adgangsadresser?${params}`,
      { signal: AbortSignal.timeout(5000) },
      { caller: 'ejendom-struktur.dawa-adgangsadresse' }
    );
    if (res.ok) {
      const arr = (await res.json()) as Array<{ id: string }>;
      if (arr.length > 0) return arr[0].id;
    }

    // Fritekst-fallback: DAWA autocomplete med q-parameter
    // Fanger tilfælde hvor vejnavn har specielle tegn (ø/æ/å) der
    // ikke matcher eksaktsøgningen
    const qRes = await fetchDawa(
      `https://dawa.aws.dk/adgangsadresser/autocomplete?q=${encodeURIComponent(`${vejnavn} ${husnummer}, ${postnr}`)}&per_side=1`,
      { signal: AbortSignal.timeout(5000) },
      { caller: 'ejendom-struktur.dawa-autocomplete' }
    );
    if (qRes.ok) {
      const arr = (await qRes.json()) as Array<{ adgangsadresse: { id: string } }>;
      if (arr.length > 0) return arr[0].adgangsadresse.id;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Klassificering ─────────────────────────────────────────────────────────

/**
 * Klassificerer en TL-item baseret på vedroerende-tekst og adresse.
 * Tinglysning bruger "Ejerlejlighed:" prefix for ejerlejligheder og
 * "Hovedejendom:" for hovedejendomme. Alt uden etage-info og uden
 * "Ejerlejlighed" er enten SFE eller hovedejendom.
 *
 * @param item - Tinglysning søge-item
 * @returns Klassificering
 */
function klassificerItem(item: TLSearchItem): StrukturNiveau {
  const v = item.vedroerende.toLowerCase();
  if (v.includes('ejerlejlighed')) return 'ejerlejlighed';
  if (v.includes('hovedejendom')) return 'hovedejendom';
  // Fallback: items med etage i adressen er ejerlejligheder
  const parts = item.adresse.split(',');
  if (parts.length >= 3) {
    const mid = parts[1].trim();
    if (/^\d+\.|^st\.|^kl\./i.test(mid)) return 'ejerlejlighed';
  }
  return 'sfe';
}

/**
 * Ekstraher husnummer (tal + evt. bogstav) fra en adressestreng.
 * F.eks. "Arnold Nielsens Boulevard 62B, st. th, 2650" → "62B"
 *
 * @param adresse - Fuld adressestreng
 * @returns Husnummer inkl. evt. bogstav (f.eks. "62A", "62B", "62")
 */
function extractHusnr(adresse: string): string {
  const streetPart = adresse.split(',')[0].trim();
  const match = streetPart.match(/(\d+\w*)$/);
  return match ? match[1].toUpperCase() : '';
}

/**
 * Parser etage+dør fra en tinglysningsadresse.
 * F.eks. "Vejnavn 18, 1. tv, 1799 København" → { etage: "1", doer: "tv" }
 *
 * @param adresse - Fuld adressestreng fra tinglysning
 * @returns Etage og dør
 */
function parseEtageDoer(adresse: string): { etage: string | null; doer: string | null } {
  const parts = adresse.split(',').map((s) => s.trim());
  if (parts.length < 3) return { etage: null, doer: null };
  const etageDoer = parts[1].trim();
  const match = etageDoer.match(/^(\d+|st|kl)\.?\s*(.*)$/i);
  if (!match) return { etage: null, doer: null };
  return {
    etage: match[1].toLowerCase(),
    doer: match[2]?.toLowerCase().trim() || null,
  };
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<EjendomStrukturResponse>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ tree: null, fejl: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseQuery(request, strukturQuerySchema);
  if (!parsed.success) return parsed.response as NextResponse<EjendomStrukturResponse>;
  let { ejerlavKode, matrikelnr } = parsed.data;
  const { sfeBfe } = parsed.data;

  // BIZZ-1834: BFE-only mode — resolve ejerlavKode+matrikelnr via DAWA jordstykke
  if (!ejerlavKode && !matrikelnr && sfeBfe) {
    try {
      const bfeRes = await fetchDawa(
        `https://api.dataforsyningen.dk/jordstykker?bfenummer=${sfeBfe}&format=json`,
        { signal: AbortSignal.timeout(5000) },
        { caller: 'ejendom-struktur.bfe-resolve' }
      );
      if (bfeRes.ok) {
        const jordstykker = (await bfeRes.json()) as Array<{
          ejerlav?: { kode?: number };
          matrikelnr?: string;
        }>;
        if (jordstykker.length > 0) {
          ejerlavKode = String(jordstykker[0].ejerlav?.kode ?? '');
          matrikelnr = jordstykker[0].matrikelnr ?? '';
        }
      }
    } catch {
      /* DAWA jordstykke resolve is non-critical */
    }

    if (!ejerlavKode || !matrikelnr) {
      return NextResponse.json(
        { tree: null, fejl: 'Kunne ikke resolve ejerlavKode+matrikelnr fra BFE' },
        { status: 200 }
      );
    }
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { tree: null, fejl: 'Tinglysning certifikat ikke konfigureret' },
      { status: 200 }
    );
  }

  try {
    // ── Trin 1: Hent alle ejendomme via Tinglysning ──
    // BIZZ-1218: Søg BÅDE på matrikel OG SFE BFE for at fange ejendomme
    // på flere matrikler under samme SFE (fx 62A, 62B, 62C).
    const searches: Promise<{ status: number; body: string }>[] = [];
    // Matrikel-søgning (kun hvis ejerlavKode + matrikelnr er tilgængelige)
    if (ejerlavKode && matrikelnr) {
      const matrikelPath = `/ejendom/landsejerlavmatrikel?landsejerlavid=${encodeURIComponent(ejerlavKode)}&matrikelnr=${encodeURIComponent(matrikelnr)}`;
      searches.push(tlFetch(matrikelPath));
    }
    // Hvis vi kender SFE BFE, søg også direkte på den for at fange alle underenheder
    if (sfeBfe) {
      searches.push(tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${sfeBfe}`));
    }
    const searchResults = await Promise.all(searches);

    const items: TLSearchItem[] = [];
    const seenUuids = new Set<string>();
    for (const tlResult of searchResults) {
      if (tlResult.status !== 200) continue;
      try {
        const parsed = JSON.parse(tlResult.body) as { items: TLSearchItem[] };
        for (const item of parsed.items ?? []) {
          if (seenUuids.has(item.uuid)) continue;
          seenUuids.add(item.uuid);
          items.push(item);
        }
      } catch {
        /* ignore malformed response */
      }
    }

    // BIZZ-1678: Når TL fejler, byg minimalt strukturtræ fra DAWA adresser
    // på matriklen. Giver brugeren overblik over lejligheder selv uden TL.
    if (items.length === 0) {
      try {
        const dawaRes = await fetch(
          `https://api.dataforsyningen.dk/adgangsadresser?ejerlavkode=${ejerlavKode ?? ''}&matrikelnr=${encodeURIComponent(matrikelnr ?? '')}&per_side=5`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (dawaRes.ok) {
          const adgangsadresser = (await dawaRes.json()) as Array<{
            id: string;
            adressebetegnelse: string;
            postnr: string;
            postnrnavn: string;
          }>;
          if (adgangsadresser.length > 0) {
            const sfeLabel = `${adgangsadresser[0].adressebetegnelse?.split(',')[0] ?? 'SFE'}`;
            const sfeNode: StrukturNode = {
              bfe: sfeBfe ?? 0,
              adresse: `${sfeLabel}, ${adgangsadresser[0].postnr} ${adgangsadresser[0].postnrnavn}`,
              niveau: 'sfe',
              dawaId: null,
              ejendomsvaerdi: null,
              grundvaerdi: null,
              vurderingsaar: null,
              tlVurdering: null,
              areal: null,
              vaerelser: null,
              ejer: null,
              ejertype: null,
              koebspris: null,
              koebsdato: null,
              children: adgangsadresser.map((adg) => ({
                bfe: 0,
                adresse: adg.adressebetegnelse,
                niveau: 'hovedejendom' as const,
                dawaId: adg.id,
                ejendomsvaerdi: null,
                grundvaerdi: null,
                vurderingsaar: null,
                tlVurdering: null,
                areal: null,
                vaerelser: null,
                ejer: null,
                ejertype: null,
                koebspris: null,
                koebsdato: null,
                children: [],
              })),
            };
            logger.log(
              `[ejendom-struktur] DAWA fallback: ${adgangsadresser.length} adgangsadresser for ejerlav ${ejerlavKode} matr. ${matrikelnr}`
            );
            return NextResponse.json(
              { tree: sfeNode, fejl: null },
              {
                status: 200,
                headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
              }
            );
          }
        }
      } catch {
        /* DAWA fallback non-fatal */
      }
      if (searchResults[0].status !== 200) {
        logger.error(`[ejendom-struktur] Tinglysning svarede ${searchResults[0].status}`);
      }
      // BIZZ-2095: tomme/fejlede TL-svar må ikke caches — næste request skal prøve igen
      return NextResponse.json(
        {
          tree: null,
          fejl:
            searchResults[0].status !== 200
              ? `Tinglysning svarede ${searchResults[0].status}`
              : null,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (items.length === 0) {
      // BIZZ-2095: tomt TL-svar caches ikke
      return NextResponse.json(
        { tree: null, fejl: null },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Debug: log alle TL items for at forstå klassificering
    logger.log(
      `[ejendom-struktur] ${items.length} items fra TL for ejerlav=${ejerlavKode} matr=${matrikelnr}:`,
      items.map((i) => ({
        adresse: i.adresse,
        vedroerende: i.vedroerende,
        esr: i.ejendomsnummer,
        vurdering: i.ejendomsVurdering,
      }))
    );

    // ── BIZZ-2058: Hent reelle BFE-numre via ejdsummarisk ──
    // TL-søgesvaret indeholder kun det kommunale ESR-ejendomsnummer, IKKE BFE.
    // Tidligere blev ESR fejltolket som BFE (parseInt(ejendomsnummer)), hvilket
    // gav links til vilkårlige forkerte ejendomme (fx ESR 134971 → BFE 134971 =
    // Cumberlandsgade 2 i stedet for Hammerholmen 44, 1.). Vi slår derfor det
    // reelle BFE op pr. uuid.
    const bfeMap = await fetchBfeBatch(items.map((i) => i.uuid));

    // ── Trin 2: Klassificér alle items ──
    const classified = items.map((item) => {
      const niveau = klassificerItem(item);
      const summarisk = bfeMap.get(item.uuid) ?? null;
      const bfe = summarisk?.bfe ?? 0;
      const husnr = extractHusnr(item.adresse);
      const { etage, doer } = parseEtageDoer(item.adresse);
      return {
        ...item,
        niveau,
        bfe,
        husnr,
        etage,
        doer,
        // BIZZ-2095: skøde-købesum/-dato fra samme ejdsummarisk-svar
        koebspris: summarisk?.koebspris ?? null,
        koebsdato: summarisk?.koebsdato ?? null,
      };
    });

    // BIZZ-2132: Ejerlejligheder med SFE-BFE → resolve til individuel BFE
    // via bfe_adresse_cache (adresse + etage + dør match). TL's ejdsummarisk
    // returnerer SFE-BFE for ejerlejligheder i stedet for den individuelle.
    if (sfeBfe) {
      const sfeBfeNum = typeof sfeBfe === 'number' ? sfeBfe : parseInt(String(sfeBfe), 10);
      const needsResolve = classified.filter(
        (c) => c.niveau === 'ejerlejlighed' && c.bfe === sfeBfeNum
      );
      if (needsResolve.length > 0) {
        try {
          // Hent alle ejerlejligheder i bfe_adresse_cache der matcher SFE'ens postnr
          const firstPostnr = needsResolve[0].adresse?.match(/\b(\d{4})\b/)?.[1];
          if (firstPostnr) {
            const { data: cacheRows } = await admin
              .from('bfe_adresse_cache')
              .select('bfe_nummer, adresse, etage, doer')
              .eq('postnr', firstPostnr)
              .eq('ejendomstype', 'Ejerlejlighed')
              .limit(500);
            if (cacheRows && cacheRows.length > 0) {
              const normAddr = (s: string | null) =>
                (s ?? '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
              for (const item of needsResolve) {
                // Match på adresse-tekst + etage + dør
                const itemAddr = normAddr(item.adresse);
                const match = (
                  cacheRows as Array<{
                    bfe_nummer: number;
                    adresse: string | null;
                    etage: string | null;
                    doer: string | null;
                  }>
                ).find((r) => {
                  const fullAddr = `${r.adresse ?? ''} ${r.etage ?? ''} ${r.doer ?? ''}`;
                  return normAddr(fullAddr) === itemAddr || itemAddr.includes(normAddr(r.adresse));
                });
                if (match) {
                  (item as { bfe: number }).bfe = match.bfe_nummer;
                }
              }
              logger.log(
                `[ejendom-struktur] BIZZ-2132: resolved ${needsResolve.filter((i) => i.bfe !== sfeBfeNum).length}/${needsResolve.length} ejerlejlighed-BFEs fra cache`
              );
            }
          }
        } catch {
          // Best-effort — analysen fortsætter med SFE-BFE
        }
      }
    }

    logger.log(
      `[ejendom-struktur] klassificering:`,
      classified.map((c) => `${c.adresse} → ${c.niveau} (husnr=${c.husnr}, bfe=${c.bfe})`)
    );

    let sfeItems = classified.filter((i) => i.niveau === 'sfe');
    const hovedejendomItems = classified.filter((i) => i.niveau === 'hovedejendom');
    const ejerlejlighedItems = classified.filter((i) => i.niveau === 'ejerlejlighed');

    // Heuristik: hvis der er FLERE "sfe"-items, er de reelt hovedejendomme.
    // Den ægte SFE er den med lavest BFE eller den uden husnr-bogstav.
    // Resten er hovedejendomme der ikke blev fanget af vedroerende-tekst.
    if (sfeItems.length > 1) {
      // Find den der bedst matcher "ren" SFE: laveste BFE, eller den med
      // husnr uden bogstav-suffix
      const sorted = [...sfeItems].sort((a, b) => {
        // Foretrøk item med sfeBfe match
        if (sfeBfe) {
          if (a.bfe === sfeBfe) return -1;
          if (b.bfe === sfeBfe) return 1;
        }
        // Foretrøk husnr uden bogstav (f.eks. "62" over "62A")
        const aHasLetter = /[A-Z]$/i.test(a.husnr);
        const bHasLetter = /[A-Z]$/i.test(b.husnr);
        if (aHasLetter !== bHasLetter) return aHasLetter ? 1 : -1;
        return a.bfe - b.bfe;
      });
      // Første er den ægte SFE, resten er hovedejendomme
      const realSfe = sorted[0];
      const extraHoved = sorted.slice(1);
      sfeItems = [realSfe];
      for (const item of extraHoved) {
        item.niveau = 'hovedejendom';
        hovedejendomItems.push(item);
      }
      logger.log(
        `[ejendom-struktur] multi-sfe heuristik: SFE=${realSfe.bfe}, ekstra hovedejendomme:`,
        extraHoved.map((h) => h.bfe)
      );
    }

    // ── Trin 3: Hent vurderinger for hovedejendomme + ejerlejligheder i ét batch-kald ──
    // BIZZ-1214+1336: Samler alle BFE'er (hoved + ejerlejligheder) for komplet vurdering.
    const allBfeList = [
      ...hovedejendomItems.filter((h) => h.bfe > 0).map((h) => h.bfe),
      ...ejerlejlighedItems.filter((e) => e.bfe > 0).map((e) => e.bfe),
    ];
    const vurMap = await fetchVurderingBatch(allBfeList);

    // ── Trin 4: Resolve DAWA ID'er for navigation ──
    // BIZZ-1214: Kun SFE + hovedejendomme — ejerlejligheder beriges
    // klient-side via lejligheder-data (sparer 50+ DAWA-kald for store bygninger).
    const parentItems = [...sfeItems, ...hovedejendomItems];
    const dawaIds = await Promise.all(
      parentItems.map(async (item) => {
        const id = await resolveDawaId(item.adresse, item.etage, item.doer);
        return { bfe: item.bfe, adresse: item.adresse, dawaId: id };
      })
    );
    const dawaMap = new Map(dawaIds.map((d) => [d.adresse, d.dawaId]));

    // ── Trin 5: Byg træet ──

    // Gruppér ejerlejligheder under hovedejendomme baseret på husnummer-match
    const assignedEjl = new Set<number>();
    const hovedejendomNodes: StrukturNode[] = hovedejendomItems.map((hej) => {
      const vur = vurMap.get(hej.bfe);
      const children: StrukturNode[] = ejerlejlighedItems
        .filter((ejl) => ejl.husnr === hej.husnr)
        .map((ejl) => {
          assignedEjl.add(ejl.bfe);
          // BIZZ-1336: Berig ejerlejligheder med vurdering fra cache
          const ejlVur = vurMap.get(ejl.bfe);
          return {
            bfe: ejl.bfe,
            adresse: ejl.adresse,
            niveau: 'ejerlejlighed' as const,
            dawaId: dawaMap.get(ejl.adresse) ?? null,
            ejendomsvaerdi: ejlVur?.ejendomsvaerdi ?? null,
            grundvaerdi: ejlVur?.grundvaerdi ?? null,
            vurderingsaar: ejlVur?.aar ?? null,
            tlVurdering: ejl.ejendomsVurdering,
            areal: null,
            vaerelser: null,
            ejer: null,
            ejertype: null,
            koebspris: ejl.koebspris,
            koebsdato: ejl.koebsdato,
            children: [],
          };
        });

      return {
        bfe: hej.bfe,
        adresse: hej.adresse,
        niveau: 'hovedejendom' as const,
        dawaId: dawaMap.get(hej.adresse) ?? null,
        ejendomsvaerdi: vur?.ejendomsvaerdi ?? null,
        grundvaerdi: vur?.grundvaerdi ?? null,
        vurderingsaar: vur?.aar ?? null,
        tlVurdering: hej.ejendomsVurdering,
        areal: null,
        vaerelser: null,
        ejer: null,
        ejertype: null,
        // BIZZ-2095: skøde-købesum/-dato fra ejdsummarisk
        koebspris: hej.koebspris,
        koebsdato: hej.koebsdato,
        children,
      };
    });

    // Orphan-ejerlejligheder: gruppér per husnr og opret virtuelle
    // hovedejendom-noder for dem. Tinglysning returnerer ikke altid
    // en eksplicit "Hovedejendom"-item for alle opgange, men ejerlejlighederne
    // hører logisk under en hovedejendom med samme husnr.
    const orphanItems = ejerlejlighedItems.filter((ejl) => !assignedEjl.has(ejl.bfe));
    const orphanByHusnr = new Map<string, typeof orphanItems>();
    for (const ejl of orphanItems) {
      const group = orphanByHusnr.get(ejl.husnr) ?? [];
      group.push(ejl);
      orphanByHusnr.set(ejl.husnr, group);
    }

    // Opret virtuelle hovedejendom-noder for orphan-grupper og hent
    // deres vurderinger + DAWA-ID'er
    const virtualHovedNodes: StrukturNode[] = [];
    for (const [husnr, ejls] of orphanByHusnr) {
      // Byg adresse for den virtuelle hovedejendom: vejnavn + husnr + postnr
      const firstAddr = ejls[0].adresse;
      const streetMatch = firstAddr
        .split(',')[0]
        .trim()
        .match(/^(.+?)\s+\d+\w*$/);
      const postMatch = firstAddr.match(/(\d{4}\s+\S+.*)$/);
      const vejnavn = streetMatch?.[1] ?? '';
      const postBy = postMatch?.[1] ?? '';
      const hovedAdresse = `${vejnavn} ${husnr}, ${postBy}`;

      // Resolve DAWA ID for den virtuelle hovedejendom
      let hovedDawaId: string | null = null;
      try {
        hovedDawaId = await resolveDawaId(hovedAdresse, null, null);
      } catch {
        /* non-fatal */
      }

      const children: StrukturNode[] = ejls.map((ejl) => {
        const ejlVur = vurMap.get(ejl.bfe);
        return {
          bfe: ejl.bfe,
          adresse: ejl.adresse,
          niveau: 'ejerlejlighed' as const,
          dawaId: dawaMap.get(ejl.adresse) ?? null,
          ejendomsvaerdi: ejlVur?.ejendomsvaerdi ?? null,
          grundvaerdi: ejlVur?.grundvaerdi ?? null,
          vurderingsaar: ejlVur?.aar ?? null,
          tlVurdering: ejl.ejendomsVurdering,
          areal: null,
          vaerelser: null,
          ejer: null,
          ejertype: null,
          koebspris: ejl.koebspris,
          koebsdato: ejl.koebsdato,
          children: [],
        };
      });

      virtualHovedNodes.push({
        bfe: 0,
        adresse: hovedAdresse,
        niveau: 'hovedejendom',
        dawaId: hovedDawaId,
        ejendomsvaerdi: null,
        grundvaerdi: null,
        vurderingsaar: null,
        tlVurdering: null,
        areal: null,
        vaerelser: null,
        ejer: null,
        ejertype: null,
        koebspris: null,
        koebsdato: null,
        children,
      });
    }

    // Root node = SFE
    const sfeItem = sfeItems[0];
    const sfeAdresse = sfeItem?.adresse ?? items[0].adresse.split(',').slice(0, 1).join(',').trim();

    // SFE DAWA ID: prøv først den vi allerede har; hvis den fejlede, prøv
    // adgangsadresse-lookup med bare vejnavn+laveste husnr
    let sfeDawaId = dawaMap.get(sfeAdresse) ?? null;
    if (!sfeDawaId && sfeItem) {
      try {
        sfeDawaId = await resolveDawaId(sfeItem.adresse, null, null);
      } catch {
        /* non-fatal */
      }
    }
    // BIZZ-1217: Fallback til DAWA BFE-lookup for SFE-noder uden dawaId.
    // SFE-adressen mangler ofte etage/dør og resolver til en forkert adresse.
    // DAWA /bfe/{bfe} returnerer beliggenhedsadresse.id som er stabil.
    if (!sfeDawaId && sfeBfe) {
      try {
        const bfeRes = await fetchDawa(
          `https://dawa.aws.dk/bfe/${sfeBfe}`,
          { signal: AbortSignal.timeout(5000) },
          { caller: 'ejendom-struktur.sfe-resolve' }
        );
        if (bfeRes.ok) {
          const bfeData = (await bfeRes.json()) as {
            beliggenhedsadresse?: { id?: string };
          };
          sfeDawaId = bfeData?.beliggenhedsadresse?.id ?? null;
        }
      } catch {
        /* non-fatal */
      }
    }

    const root: StrukturNode = {
      bfe: sfeBfe ?? sfeItem?.bfe ?? 0,
      adresse: sfeAdresse,
      niveau: 'sfe',
      dawaId: sfeDawaId,
      ejendomsvaerdi: null,
      grundvaerdi: null,
      vurderingsaar: null,
      tlVurdering: sfeItem?.ejendomsVurdering ?? null,
      areal: null,
      vaerelser: null,
      ejer: null,
      ejertype: null,
      // BIZZ-2095: skøde-købesum/-dato fra ejdsummarisk
      koebspris: sfeItem?.koebspris ?? null,
      koebsdato: sfeItem?.koebsdato ?? null,
      children: [...hovedejendomNodes, ...virtualHovedNodes],
    };

    // ── BIZZ-1137/BIZZ-1214: Resolve dawaId via DAWA /bfe/{bfe} for noder
    // uden dawaId — KUN SFE og hovedejendomme for at undgå N+1 DAWA-kald.
    // Ejerlejligheder beriges klient-side via lejligheder-data.
    {
      /** Samler SFE/hovedejendom noder uden dawaId */
      function collectParentNodesWithoutDawaId(node: StrukturNode): StrukturNode[] {
        const result: StrukturNode[] = [];
        if (!node.dawaId && node.bfe > 0 && node.niveau !== 'ejerlejlighed') {
          result.push(node);
        }
        for (const child of node.children) {
          result.push(...collectParentNodesWithoutDawaId(child));
        }
        return result;
      }
      const parentNodes = collectParentNodesWithoutDawaId(root);
      if (parentNodes.length > 0) {
        await Promise.allSettled(
          parentNodes.map(async (node) => {
            try {
              const res = await fetchDawa(
                `https://dawa.aws.dk/bfe/${node.bfe}`,
                { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
                { caller: 'ejendom-struktur.bfe-resolve' }
              );
              if (res.ok) {
                const json = (await res.json()) as {
                  beliggenhedsadresse?: { id?: string };
                };
                if (json.beliggenhedsadresse?.id) {
                  node.dawaId = json.beliggenhedsadresse.id;
                }
              }
            } catch {
              /* non-fatal */
            }
          })
        );
      }
    }

    // BIZZ-1901: Supplér med DAWA-adgangsadresser der ikke er i TL-resultatet.
    // Carlsberg Byen har hovedejendomme (fx J.C. Jacobsens Gade) der ikke
    // returneres fra TL matrikel-søgning men har adgangsadresser i DAWA.
    logger.log(
      `[ejendom-struktur] DAWA supplement check: ejerlav=${ejerlavKode} matr=${matrikelnr} children=${root.children.length}`
    );
    if (ejerlavKode && matrikelnr && root.children.length > 0) {
      try {
        // BIZZ-1901: Plain fetch — fetchDawa wrapper kan have ISR-issues
        const dawaRes = await fetch(
          `https://api.dataforsyningen.dk/adgangsadresser?ejerlavkode=${ejerlavKode}&matrikelnr=${encodeURIComponent(matrikelnr)}&per_side=30&format=json&struktur=mini`,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 3600 } }
        );
        logger.log(`[ejendom-struktur] DAWA supplement: ${dawaRes.status}`);
        if (dawaRes.ok) {
          const dawaAdresser = (await dawaRes.json()) as Array<{
            id: string;
            vejnavn: string;
            husnr: string;
            postnr: string;
            postnrnavn: string;
          }>;
          // Find adresser der ikke matcher eksisterende hovedejendomme
          const existingHusnrs = new Set(
            root.children.map((c) => {
              const parts = c.adresse.split(',')[0].trim().toLowerCase();
              return parts;
            })
          );
          for (const adg of dawaAdresser) {
            const adgKey = `${adg.vejnavn} ${adg.husnr}`.toLowerCase();
            const alreadyExists = [...existingHusnrs].some(
              (h) => h.includes(adgKey) || adgKey.includes(h)
            );
            if (!alreadyExists) {
              root.children.push({
                bfe: 0,
                adresse: `${adg.vejnavn} ${adg.husnr}, ${adg.postnr} ${adg.postnrnavn}`,
                niveau: 'hovedejendom',
                dawaId: adg.id,
                ejendomsvaerdi: null,
                grundvaerdi: null,
                vurderingsaar: null,
                tlVurdering: null,
                areal: null,
                vaerelser: null,
                ejer: null,
                ejertype: null,
                koebspris: null,
                koebsdato: null,
                children: [],
              });
              existingHusnrs.add(adgKey);
            }
          }
        }
      } catch (supplementErr) {
        logger.warn(
          '[ejendom-struktur] DAWA supplement fejlede:',
          supplementErr instanceof Error ? supplementErr.message : String(supplementErr)
        );
      }
    }

    // ── BIZZ-2094: Søster-SFE'er — samme gældende ejer + samme ejerlav ──
    // Resights' struktur omfatter hele vurderingsejendommen, som kan spænde
    // over flere SFE'er (fx Fenrisvej 15/19 under Gefionsvej 47A). VUR
    // eksponerer ikke koblingen, så vi bruger ticketens fallback: ejerens
    // øvrige SFE'er i samme ejerlav vises som søster-SFE'er under root.
    if (root.bfe > 0 && ejerlavKode) {
      const inTree = new Set<number>();
      /** Samler alle BFE'er der allerede er i træet */
      const collectBfes = (n: StrukturNode): void => {
        if (n.bfe > 0) inTree.add(n.bfe);
        n.children.forEach(collectBfes);
      };
      collectBfes(root);
      const soesterNodes = await fetchSoesterSfeNodes(root.bfe, ejerlavKode, inTree);
      if (soesterNodes.length > 0) {
        root.children.push(...soesterNodes);
        logger.log(`[ejendom-struktur] ${soesterNodes.length} søster-SFE'er tilføjet (BIZZ-2094)`);
      }
    }

    // ── BIZZ-2060/BIZZ-2095: Berig ALLE noder med ejer + areal i batch ──
    // BIZZ-2060 ramte kun ejerlejligheder 2 niveauer nede — hovedejendom- og
    // SFE-rækker fik aldrig ejer sat, selvom ejf_ejerskab har gældende ejere
    // for dem. Nu walkes hele træet (EFTER søster-SFE'er er tilføjet, så de
    // også får areal): ejer fra ejf_ejerskab (CVR-navne via cvr_virksomhed)
    // og areal fra bbr_ejendom_status, begge i ét batch-kald.
    {
      const alleNoder: StrukturNode[] = [];
      /** Samler alle noder med reelt BFE rekursivt */
      const collectNodes = (n: StrukturNode): void => {
        if (n.bfe > 0) alleNoder.push(n);
        n.children.forEach(collectNodes);
      };
      collectNodes(root);

      if (alleNoder.length > 0) {
        const alleBfes = [...new Set(alleNoder.map((n) => n.bfe))];
        const supabase = createAdminClient();
        const [ejerMap, arealRes] = await Promise.all([
          fetchEjerskabBatch(alleBfes),
          supabase
            .from('bbr_ejendom_status')
            .select('bfe_nummer, samlet_boligareal, samlet_erhvervsareal, bebygget_areal')
            .in('bfe_nummer', alleBfes),
        ]);
        const arealMap = new Map<number, number>();
        for (const r of (arealRes.data ?? []) as Array<{
          bfe_nummer: number;
          samlet_boligareal: number | null;
          samlet_erhvervsareal: number | null;
          bebygget_areal: number | null;
        }>) {
          const areal = r.samlet_boligareal ?? r.samlet_erhvervsareal ?? r.bebygget_areal;
          if (areal != null && areal > 0) arealMap.set(r.bfe_nummer, areal);
        }
        for (const node of alleNoder) {
          const ejerInfo = ejerMap.get(node.bfe);
          if (ejerInfo && !node.ejer) {
            node.ejer = ejerInfo.ejerNavn;
            node.ejertype = ejerInfo.ejerType;
          }
          if (node.areal == null) {
            node.areal = arealMap.get(node.bfe) ?? null;
          }
        }
        logger.log(
          `[ejendom-struktur] Berigelse: ${ejerMap.size}/${alleBfes.length} med ejer, ${arealMap.size} med areal`
        );
      }
    }

    logger.log(`[ejendom-struktur] Final tree: ${root.children.length} children`);

    // BIZZ-2095: cache kun ikke-tomme træer — et tomt træ (fx TL-timeout undervejs)
    // må ikke ligge 1 time i CDN-cachen og skjule data for efterfølgende besøg
    return NextResponse.json(
      { tree: root, fejl: null },
      {
        status: 200,
        headers: {
          'Cache-Control':
            root.children.length > 0
              ? 'public, s-maxage=3600, stale-while-revalidate=600'
              : 'no-store',
        },
      }
    );
  } catch (err) {
    logger.error('[ejendom-struktur] Uventet fejl:', err);
    return NextResponse.json(
      { tree: null, fejl: 'Ekstern API fejl' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
