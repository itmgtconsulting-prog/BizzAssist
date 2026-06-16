/**
 * BIZZ-2093: Fælles BFE→adresse-resolver.
 *
 * Én delt resolver der bruges af alle tre BFE-adresse-flader (diagram-berigelse
 * via /api/bfe-addresses, ejendomme-tab via /api/ejendomme-by-owner og
 * forsikrings-gab via koncernWalk) så samme BFE altid viser samme adresse-label.
 *
 * Strategi (valideret i BIZZ-2092, udvidet i BIZZ-2159):
 *   1. Cache-first fra bfe_adresse_cache — men KUN rækker med troværdig kilde.
 *      'cache_dar' (korrupt backfill 2026-05-20 der skrev SFE-gruppens hoved-
 *      adresse til alle BFE'er i gruppen) og 'unresolvable' (placeholder)
 *      behandles som cache-miss.
 *   2. Live fallback pr. BFE: DAWA /jordstykker?bfenummer → /adgangsadresser?
 *      ejerlavkode&matrikelnr — giver en pr-BFE-adresse, men når en SFE har
 *      FLERE adgangsadresser på samme matrikel vælger jordstykke-opslaget en
 *      VILKÅRLIG adresse (BIZZ-2159).
 *   3. BIZZ-2159: For grund-/bygnings-BFE'er (jordstykke fundet) foretrækkes
 *      BBRs officielle beliggenhedsadresse (bbr_ejendom_status.adgangsadresse_id
 *      → DAWA) over jordstykkets vilkårlige valg. Kilde 'bbr_beliggenhed'.
 *      Ejerlejligheder (intet jordstykke) rører vi IKKE — VP har den specifikke
 *      lejligheds-adresse inkl. etage/dør.
 *   4. Jordstykke uden adgangsadresser = ubebygget grund → matrikelbetegnelse
 *      (fx "65ce Helsingør Markjorder") som adresse, dawaId=null.
 *   5. Intet jordstykke (typisk ejerlejlighed) → VP-fallback som har den
 *      specifikke lejligheds-adresse inkl. etage/dør.
 *   6. Writeback: succesfulde live-resolves gemmes med troværdig kilde
 *      ('bbr_beliggenhed' / 'auto_jordstykke' / 'auto_grund' / 'auto_vp') så
 *      næste opslag er cache-hit. Troværdige rækker overskrives ALDRIG.
 *
 * Data-retention: bfe_adresse_cache indeholder kun offentlige ejendomsdata
 * (ingen PII) — ingen retention-grænse påkrævet.
 *
 * @module lib/bfeAdresse
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';

/** Samlet adresse-resultat for én BFE. */
export interface BfeAdresse {
  adresse: string | null;
  postnr: string | null;
  by: string | null;
  kommune: string | null;
  kommuneKode: string | null;
  ejendomstype: string | null;
  dawaId: string | null;
  /** Etage (fx "1", "st") — kun for ejerlejligheder */
  etage: string | null;
  /** Dør (fx "tv", "th") — kun for ejerlejligheder */
  doer: string | null;
  /** Provenance: cache-rækkens kilde eller resolverens egen kilde-tag */
  kilde: string | null;
}

/**
 * Kilder i bfe_adresse_cache der IKKE kan stoles på pr. BFE (BIZZ-2092):
 * - 'cache_dar': korrupt backfill 2026-05-20 (SFE-gruppens hovedadresse
 *   skrevet til alle BFE'er i gruppen)
 * - 'unresolvable': placeholder-rækker uden reel adresse
 */
export const UNTRUSTED_CACHE_KILDER = new Set(['cache_dar', 'unresolvable']);

/** Maks samtidige live-opslag mod DAWA/VP */
const LIVE_CONCURRENCY = 5;

/** Rå cache-række fra bfe_adresse_cache (kun de kolonner vi læser) */
interface CacheRow {
  bfe_nummer: number;
  adresse: string | null;
  postnr: string | null;
  postnrnavn: string | null;
  kommune: string | null;
  kommune_kode: string | null;
  dawa_id: string | null;
  ejendomstype: string | null;
  etage: string | null;
  doer: string | null;
  kilde: string | null;
}

/**
 * Afgør om en cache-række er troværdig pr. BFE: skal have en reel adresse
 * (ikke "BFE 12345"-placeholder) og en kilde der ikke er på blocklisten.
 *
 * @param row - Cache-række (eller null)
 * @returns true hvis rækken kan bruges direkte uden live-opslag
 */
export function erTrovaerdigCacheRaekke(
  row: Pick<CacheRow, 'adresse' | 'kilde'> | null | undefined
): boolean {
  return Boolean(
    row?.adresse && !/^BFE \d+$/.test(row.adresse) && !UNTRUSTED_CACHE_KILDER.has(row.kilde ?? '')
  );
}

/**
 * Formatér en BfeAdresse til den fælles label "adresse, etage. dør, postnr by"
 * (mønstret fra koncernWalk/diagram-berigelse).
 *
 * @param adr - Adresse-resultat
 * @returns Label-streng, eller null hvis ingen adresse
 */
export function formatBfeLabel(adr: BfeAdresse | null | undefined): string | null {
  if (!adr?.adresse) return null;
  const parts = [adr.adresse];
  if (adr.etage) parts.push(`${adr.etage}.`);
  if (adr.doer) parts[parts.length - 1] += ` ${adr.doer}`;
  if (adr.postnr) parts.push(`${adr.postnr} ${adr.by ?? ''}`.trim());
  return parts.join(', ').trim();
}

/**
 * Hent JSON fra DAWA med timeout; null ved enhver fejl (timeout, non-200,
 * gateway-HTML der ikke kan parses, m.m.).
 *
 * @param url - Fuld DAWA-URL
 * @returns Parsed JSON eller null
 */
async function dawaJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Live-resolve én BFE via DAWA jordstykke→adgangsadresse (pr-BFE-korrekt).
 * Ubebyggede grunde (jordstykke uden adgangsadresser) får matrikelbetegnelse.
 *
 * @param bfe - BFE-nummer
 * @returns BfeAdresse eller null hvis BFE'en ikke har et jordstykke
 */
async function resolveViaJordstykke(bfe: number): Promise<BfeAdresse | null> {
  const jord = (await dawaJson(
    `${DAWA_BASE_URL}/jordstykker?bfenummer=${bfe}&format=json`
  )) as Array<{
    matrikelnr?: string;
    ejerlav?: { kode?: number; navn?: string };
    kommune?: { kode?: string; navn?: string };
  }> | null;
  if (!Array.isArray(jord) || jord.length === 0) return null;
  const j = jord[0];
  const ejerlavKode = j?.ejerlav?.kode;
  const matrikelnr = j?.matrikelnr;
  if (!ejerlavKode || !matrikelnr) return null;

  const adr = (await dawaJson(
    `${DAWA_BASE_URL}/adgangsadresser?ejerlavkode=${ejerlavKode}&matrikelnr=${encodeURIComponent(matrikelnr)}&format=json&struktur=mini&per_side=1`
  )) as Array<{
    id?: string;
    vejnavn?: string;
    husnr?: string;
    postnr?: string | number;
    postnrnavn?: string;
    kommunekode?: string | number;
  }> | null;
  const a = Array.isArray(adr) ? adr[0] : null;
  if (a?.vejnavn && a?.postnr) {
    return {
      adresse: [a.vejnavn, a.husnr].filter(Boolean).join(' '),
      postnr: String(a.postnr),
      by: a.postnrnavn ?? null,
      kommune: null,
      kommuneKode: a.kommunekode != null ? String(a.kommunekode) : null,
      ejendomstype: null,
      dawaId: a.id ?? null,
      etage: null,
      doer: null,
      kilde: 'auto_jordstykke',
    };
  }
  // Ubebygget grund — matrikelbetegnelse i stedet for nabo-adresse
  return {
    adresse: `${matrikelnr} ${j?.ejerlav?.navn ?? ''}`.trim(),
    postnr: null,
    by: null,
    kommune: j?.kommune?.navn ?? null,
    kommuneKode: j?.kommune?.kode != null ? String(j.kommune.kode) : null,
    ejendomstype: null,
    dawaId: null,
    etage: null,
    doer: null,
    kilde: 'auto_grund',
  };
}

/**
 * VP-fallback for BFE'er uden jordstykke (typisk ejerlejligheder).
 * VP har den specifikke lejligheds-adresse inkl. etage/dør.
 *
 * @param bfe - BFE-nummer
 * @returns BfeAdresse eller null hvis VP ikke kender BFE'en
 */
async function resolveViaVP(bfe: number): Promise<BfeAdresse | null> {
  try {
    const res = await fetch('https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Browser-UA påkrævet for at passere CloudFront WAF
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
          'adresseID',
          'floor',
          'door',
          'juridiskKategori',
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      hits?: {
        hits?: Array<{
          _source?: {
            roadName?: string;
            houseNumber?: string;
            zipcode?: string;
            postDistrict?: string;
            adgangsAdresseID?: string;
            adresseID?: string;
            floor?: string;
            door?: string;
            juridiskKategori?: string;
          };
        }>;
      };
    };
    const src = data.hits?.hits?.[0]?._source;
    if (!src?.roadName) return null;
    const etage = src.floor && src.floor.length > 0 ? src.floor : null;
    return {
      adresse: `${src.roadName} ${src.houseNumber ?? ''}`.trim(),
      postnr: src.zipcode ?? null,
      by: src.postDistrict ?? null,
      kommune: null,
      kommuneKode: null,
      ejendomstype: src.juridiskKategori ?? null,
      dawaId: (etage ? src.adresseID : src.adgangsAdresseID) ?? src.adgangsAdresseID ?? null,
      etage,
      doer: src.door && src.door.length > 0 ? src.door : null,
      kilde: 'auto_vp',
    };
  } catch {
    return null;
  }
}

/**
 * BIZZ-2159: Resolve én BFE via BBRs officielle beliggenhedsadresse.
 *
 * En SFE kan dække flere adgangsadresser på samme matrikel (fx hjørne-
 * bygningen Gyldenstræde 8 / Stengade 10 på matrikel 519). DAWA-jordstykke-
 * opslaget vælger en vilkårlig af dem, mens bbr_ejendom_status.adgangsadresse_id
 * peger på den officielle/primære adresse. Denne kilde har derfor forrang for
 * grund-/bygnings-BFE'er.
 *
 * @param bfe - BFE-nummer
 * @param admin - Supabase admin-klient (til public.bbr_ejendom_status)
 * @returns BfeAdresse med kilde='bbr_beliggenhed', eller null hvis BFE'en ikke
 *   har en BBR-beliggenhedsadresse eller DAWA ikke kan resolve den
 */
async function resolveViaBbrBeliggenhed(
  bfe: number,
  admin: ReturnType<typeof createAdminClient>
): Promise<BfeAdresse | null> {
  let adgangsadresseId: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from('bbr_ejendom_status')
      .select('adgangsadresse_id')
      .eq('bfe_nummer', bfe)
      .maybeSingle();
    adgangsadresseId = (data?.adgangsadresse_id as string | null) ?? null;
  } catch {
    return null;
  }
  if (!adgangsadresseId) return null;

  const a = (await dawaJson(
    `${DAWA_BASE_URL}/adgangsadresser/${encodeURIComponent(adgangsadresseId)}?struktur=mini`
  )) as {
    id?: string;
    vejnavn?: string;
    husnr?: string;
    postnr?: string | number;
    postnrnavn?: string;
    kommunekode?: string | number;
  } | null;
  if (!a?.vejnavn || a?.postnr == null) return null;
  return {
    adresse: [a.vejnavn, a.husnr].filter(Boolean).join(' '),
    postnr: String(a.postnr),
    by: a.postnrnavn ?? null,
    kommune: null,
    kommuneKode: a.kommunekode != null ? String(a.kommunekode) : null,
    ejendomstype: null,
    dawaId: a.id ?? adgangsadresseId,
    etage: null,
    doer: null,
    kilde: 'bbr_beliggenhed',
  };
}

/**
 * Live-resolve én BFE: jordstykke-kæden først (afgør om det er en grund-/
 * bygnings-BFE), og foretræk dér BBRs officielle beliggenhedsadresse over
 * jordstykkets vilkårlige valg (BIZZ-2159). VP som fallback for ejerlejligheder
 * (intet jordstykke) — VP har den specifikke lejligheds-adresse inkl. etage/dør,
 * som BBR-beliggenhed ikke har, så ejerlejligheder rører vi ikke. Returnerer
 * null hvis intet findes.
 *
 * @param bfe - BFE-nummer
 * @param admin - Supabase admin-klient (til BBR-beliggenhed-opslag)
 * @returns BfeAdresse eller null
 */
async function resolveLive(
  bfe: number,
  admin: ReturnType<typeof createAdminClient>
): Promise<BfeAdresse | null> {
  const viaJord = await resolveViaJordstykke(bfe);
  if (viaJord) {
    const viaBbr = await resolveViaBbrBeliggenhed(bfe, admin);
    return viaBbr ?? viaJord;
  }
  return resolveViaVP(bfe);
}

/**
 * Map en troværdig cache-række til BfeAdresse.
 *
 * @param row - Cache-række
 * @returns BfeAdresse
 */
function mapCacheRow(row: CacheRow): BfeAdresse {
  return {
    adresse: row.adresse,
    postnr: row.postnr ?? null,
    by: row.postnrnavn ?? null,
    kommune: row.kommune ?? null,
    kommuneKode: row.kommune_kode ?? null,
    ejendomstype: row.ejendomstype ?? null,
    dawaId: row.dawa_id ?? null,
    etage: row.etage ?? null,
    doer: row.doer ?? null,
    kilde: row.kilde ?? null,
  };
}

/**
 * Batch-resolve BFE-numre → adresser. Cache-first (kun troværdige kilder),
 * live-fallback pr. BFE for misses, guarded writeback.
 *
 * @param bfes - BFE-numre (dedupes internt; ugyldige/NaN filtreres fra)
 * @returns Map fra BFE-nummer til BfeAdresse (kun resolvede BFE'er indgår)
 */
export async function hentBfeAdresser(bfes: number[]): Promise<Map<number, BfeAdresse>> {
  const unique = [...new Set(bfes.filter((n) => Number.isFinite(n) && n > 0))];
  const out = new Map<number, BfeAdresse>();
  if (unique.length === 0) return out;

  const admin = createAdminClient();

  // Trin 1: Cache-first — kun troværdige rækker bruges direkte
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached } = await (admin as any)
      .from('bfe_adresse_cache')
      .select(
        'bfe_nummer, adresse, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype, etage, doer, kilde'
      )
      .in('bfe_nummer', unique);
    for (const row of (cached ?? []) as CacheRow[]) {
      if (erTrovaerdigCacheRaekke(row)) out.set(row.bfe_nummer, mapCacheRow(row));
    }
  } catch {
    /* cache-læsning non-kritisk — fortsæt til live */
  }

  // Trin 2: Live-resolve misses med begrænset samtidighed
  const misses = unique.filter((b) => !out.has(b));
  for (let i = 0; i < misses.length; i += LIVE_CONCURRENCY) {
    const chunk = misses.slice(i, i + LIVE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (bfe) => ({ bfe, res: await resolveLive(bfe, admin) }))
    );
    for (const { bfe, res } of results) {
      if (!res?.adresse) continue;
      out.set(bfe, res);
      // Trin 3: Writeback — kun for misses/utroværdige rækker (vi resolver
      // aldrig live for troværdige rækker, så upsert kan ikke overskrive dem).
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any).from('bfe_adresse_cache').upsert(
          {
            bfe_nummer: bfe,
            adresse: res.adresse,
            postnr: res.postnr,
            postnrnavn: res.by,
            kommune: res.kommune,
            kommune_kode: res.kommuneKode,
            dawa_id: res.dawaId,
            ejendomstype: res.ejendomstype,
            etage: res.etage,
            doer: res.doer,
            kilde: res.kilde,
            sidst_opdateret: new Date().toISOString(),
          },
          { onConflict: 'bfe_nummer' }
        );
      } catch {
        /* writeback non-kritisk */
      }
    }
  }

  return out;
}

/**
 * Resolve én enkelt BFE → adresse (samme strategi som hentBfeAdresser).
 *
 * @param bfe - BFE-nummer
 * @returns BfeAdresse eller null hvis BFE'en ikke kunne resolves
 */
export async function hentBfeAdresse(bfe: number): Promise<BfeAdresse | null> {
  const map = await hentBfeAdresser([bfe]);
  return map.get(bfe) ?? null;
}
