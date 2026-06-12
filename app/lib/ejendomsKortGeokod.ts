/**
 * BIZZ-2089: Geokodning af ejendomslister til EjendomsKortPanel.
 *
 * Resolver hvert item til koordinater efter prioritet:
 *   1. dawaId  → DAWA /adresser/{id}?struktur=mini (x,y) — fallback /adgangsadresser/{id}
 *   2. adresse → DAWA /adresser?q=…&struktur=mini&per_side=1&fuzzy
 *   3. bfe     → /api/bfe-addresses (batch) → dawaId → trin 1
 *
 * Opslag caches i et modul-level LRU-map (max 150 entries, jf. CLAUDE.md
 * performance-regler) så gentagne panel-åbninger ikke geokoder igen.
 *
 * @module app/lib/ejendomsKortGeokod
 */

const DAWA_BASE = 'https://api.dataforsyningen.dk';
/** Max cache-entries (CLAUDE.md: LRU cache max 150) */
const CACHE_MAX = 150;
/** Max BFE'er pr. /api/bfe-addresses kald (API'ets batch-grænse) */
const BFE_BATCH = 50;

/** Ét ejendoms-item som panelet modtager fra værts-siden */
export interface KortItem {
  /** BFE-nummer hvis kendt (bruges som geokodnings-fallback) */
  bfe: number | null;
  /** Adressetekst hvis kendt */
  adresse: string | null;
  /** DAWA adresse-UUID hvis kendt (hurtigste opslag) */
  dawaId?: string | null;
  /** Valgfri visningslabel (fx ejendomsnavn) — fallback er adressen */
  label?: string;
}

/** Geokodet marker klar til kortet */
export interface KortMarker {
  lng: number;
  lat: number;
  /** Visningsadresse til popup */
  adresse: string;
  /** DAWA-id til /dashboard/ejendomme/{dawaId}-link (null hvis ukendt) */
  dawaId: string | null;
  bfe: number | null;
  label?: string;
}

/** Modul-level cache: cache-nøgle → marker (null = opslag fejlede) */
const cache = new Map<string, KortMarker | null>();

/** Indsætter i cachen med simpel LRU-eviction (ældste nøgle ryger først). */
function cacheSet(key: string, value: KortMarker | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Stabil cache-nøgle for et item */
export function kortItemKey(item: KortItem): string {
  return item.dawaId
    ? `id:${item.dawaId}`
    : item.adresse
      ? `adr:${item.adresse}`
      : `bfe:${item.bfe}`;
}

/** Rydder geokodnings-cachen (kun til tests) */
export function _clearGeokodCache(): void {
  cache.clear();
}

/** DAWA mini-struktur svar (delmængde) */
interface DawaMini {
  id?: string;
  x?: number;
  y?: number;
  betegnelse?: string;
  adressebetegnelse?: string;
}

/** Slår en DAWA adresse-UUID op → marker. Fallback til adgangsadresser. */
async function opslagDawaId(
  dawaId: string,
  item: KortItem,
  fetchFn: typeof fetch
): Promise<KortMarker | null> {
  for (const endpoint of ['adresser', 'adgangsadresser']) {
    try {
      const res = await fetchFn(`${DAWA_BASE}/${endpoint}/${dawaId}?struktur=mini`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const raw = (await res.json()) as DawaMini;
      if (typeof raw.x === 'number' && typeof raw.y === 'number') {
        return {
          lng: raw.x,
          lat: raw.y,
          adresse: item.adresse ?? raw.betegnelse ?? raw.adressebetegnelse ?? '',
          dawaId,
          bfe: item.bfe,
          label: item.label,
        };
      }
    } catch {
      /* prøv næste endpoint */
    }
  }
  return null;
}

/** Søger en adressetekst i DAWA (fuzzy) → marker. */
async function opslagAdresseTekst(
  adresse: string,
  item: KortItem,
  fetchFn: typeof fetch
): Promise<KortMarker | null> {
  try {
    const res = await fetchFn(
      `${DAWA_BASE}/adresser?q=${encodeURIComponent(adresse)}&struktur=mini&per_side=1&fuzzy`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as DawaMini[];
    const hit = Array.isArray(raw) ? raw[0] : undefined;
    if (hit && typeof hit.x === 'number' && typeof hit.y === 'number') {
      return {
        lng: hit.x,
        lat: hit.y,
        adresse,
        dawaId: hit.id ?? null,
        bfe: item.bfe,
        label: item.label,
      };
    }
  } catch {
    /* opslag fejlede */
  }
  return null;
}

/** Batch-resolver BFE-only items → dawaId/adresse via /api/bfe-addresses. */
async function berigBfeItems(
  items: KortItem[],
  fetchFn: typeof fetch
): Promise<Map<number, { adresse: string | null; dawaId: string | null }>> {
  const result = new Map<number, { adresse: string | null; dawaId: string | null }>();
  const bfes = [...new Set(items.map((i) => i.bfe).filter((b): b is number => !!b))];
  for (let i = 0; i < bfes.length; i += BFE_BATCH) {
    const chunk = bfes.slice(i, i + BFE_BATCH);
    try {
      const res = await fetchFn(`/api/bfe-addresses?bfes=${chunk.join(',')}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const raw = (await res.json()) as Record<
        string,
        { adresse: string | null; postnr: string | null; by: string | null; dawaId: string | null }
      >;
      for (const [bfe, row] of Object.entries(raw)) {
        const adresse =
          row.adresse && row.postnr
            ? `${row.adresse}, ${row.postnr} ${row.by ?? ''}`.trim()
            : row.adresse;
        result.set(Number(bfe), { adresse, dawaId: row.dawaId });
      }
    } catch {
      /* chunk fejlede — items falder tilbage til null */
    }
  }
  return result;
}

/**
 * Geokoder en liste af ejendoms-items til kort-markers.
 *
 * Dedup'er på cache-nøgle, slår op i prioriteret rækkefølge (dawaId →
 * adressetekst → BFE-batch) og returnerer kun items der kunne placeres.
 *
 * @param items - Ejendomsliste fra værts-siden
 * @param fetchFn - fetch-implementation (injicerbar i tests)
 * @returns Geokodede markers (items uden hit udelades)
 */
export async function geokodKortItems(
  items: KortItem[],
  fetchFn: typeof fetch = fetch
): Promise<KortMarker[]> {
  // Dedup på nøgle, bevar første forekomst
  const unikke = new Map<string, KortItem>();
  for (const item of items) {
    if (!item.dawaId && !item.adresse && !item.bfe) continue;
    const key = kortItemKey(item);
    if (!unikke.has(key)) unikke.set(key, item);
  }

  // BFE-only items beriges i batch først
  const bfeOnly = [...unikke.values()].filter(
    (i) => !i.dawaId && !i.adresse && i.bfe && !cache.has(kortItemKey(i))
  );
  const bfeInfo = bfeOnly.length > 0 ? await berigBfeItems(bfeOnly, fetchFn) : new Map();

  const markers: KortMarker[] = [];
  // Begrænset parallelisme (10 ad gangen) for ikke at hamre DAWA
  const entries = [...unikke.entries()];
  for (let i = 0; i < entries.length; i += 10) {
    const slice = entries.slice(i, i + 10);
    const resolved = await Promise.all(
      slice.map(async ([key, item]) => {
        if (cache.has(key)) return cache.get(key) ?? null;
        let marker: KortMarker | null = null;
        if (item.dawaId) {
          marker = await opslagDawaId(item.dawaId, item, fetchFn);
        } else if (item.adresse) {
          marker = await opslagAdresseTekst(item.adresse, item, fetchFn);
        } else if (item.bfe) {
          const info = bfeInfo.get(item.bfe);
          if (info?.dawaId)
            marker = await opslagDawaId(info.dawaId, { ...item, adresse: info.adresse }, fetchFn);
          else if (info?.adresse) marker = await opslagAdresseTekst(info.adresse, item, fetchFn);
        }
        cacheSet(key, marker);
        return marker;
      })
    );
    for (const m of resolved) if (m) markers.push(m);
  }
  return markers;
}
