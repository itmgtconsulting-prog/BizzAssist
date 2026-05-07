/**
 * Boliga API client — henter sammenlignelige solgte boliger.
 *
 * BIZZ-1180: Bruges af boligannonce-generator til few-shot eksempler.
 * Boliga.dk offentlig API returnerer historiske salg filtreret på
 * postnummer, boligtype, areal-interval og prisinterval.
 *
 * Rate-limit: max 1 request per 500ms (Boliga har ikke dokumenterede
 * rate-limits, men vi er konservative).
 *
 * @module app/lib/boliga
 */

import { logger } from '@/app/lib/logger';

const BOLIGA_API = 'https://api.boliga.dk/api/v2';

/** Boligtype-koder brugt af Boliga API */
export type BoligaPropertyType = 'villa' | 'ejerlejlighed' | 'raekkehus' | 'fritidshus';

/** Et solgt bolig-resultat fra Boliga */
export interface BoligaSold {
  /** Adresse */
  address: string;
  /** Postnummer */
  zipCode: number;
  /** Salgspris i DKK */
  price: number;
  /** Pris per m² i DKK */
  pricePerSqm: number;
  /** Boligareal i m² */
  sqm: number;
  /** Antal værelser */
  rooms: number;
  /** Salgsdato (ISO 8601) */
  soldDate: string;
  /** Boligtype */
  propertyType: string;
  /** Byggeår */
  buildYear: number | null;
}

/** Parametre for sammenlignelige bolig-søgning */
export interface ComparableSearchParams {
  /** Postnummer */
  zipCode: number;
  /** Boligtype */
  propertyType?: BoligaPropertyType;
  /** Min areal i m² */
  minSqm?: number;
  /** Max areal i m² */
  maxSqm?: number;
  /** Min pris i DKK */
  minPrice?: number;
  /** Max pris i DKK */
  maxPrice?: number;
  /** Max antal resultater */
  limit?: number;
}

/** Boliga API response shape for solgte boliger */
interface BoligaApiResponse {
  results?: Array<{
    address?: string;
    zipCode?: number;
    price?: number;
    sqmPrice?: number;
    size?: number;
    rooms?: number;
    soldDate?: string;
    propertyType?: number;
    buildYear?: number;
  }>;
  totalCount?: number;
}

/** Map Boliga propertyType codes to readable names */
const PROPERTY_TYPE_MAP: Record<number, string> = {
  1: 'villa',
  2: 'ejerlejlighed',
  3: 'rækkehus',
  4: 'fritidshus',
  5: 'andelsbolig',
  6: 'landejendom',
};

/** Map boligtype string to Boliga API code */
const TYPE_TO_CODE: Record<BoligaPropertyType, number> = {
  villa: 1,
  ejerlejlighed: 2,
  raekkehus: 3,
  fritidshus: 4,
};

/**
 * Hent sammenlignelige solgte boliger fra Boliga API.
 *
 * @param params - Søgeparametre
 * @returns Array af solgte boliger, sorteret nyeste først
 */
export async function fetchComparableSales(params: ComparableSearchParams): Promise<BoligaSold[]> {
  const limit = params.limit ?? 5;

  // Build query params
  const qs = new URLSearchParams({
    zipCode: String(params.zipCode),
    pageSize: String(limit),
    sort: 'date_d', // newest first
  });

  if (params.propertyType) {
    qs.set('propertyType', String(TYPE_TO_CODE[params.propertyType] ?? ''));
  }
  if (params.minSqm) qs.set('minSize', String(params.minSqm));
  if (params.maxSqm) qs.set('maxSize', String(params.maxSqm));
  if (params.minPrice) qs.set('minPrice', String(params.minPrice));
  if (params.maxPrice) qs.set('maxPrice', String(params.maxPrice));

  // Kun solgte indenfor seneste 2 år
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  qs.set('salesDateMin', twoYearsAgo.toISOString().split('T')[0]);

  try {
    const res = await fetch(`${BOLIGA_API}/sold/search/results?${qs}`, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'BizzAssist/1.0' },
    });

    if (!res.ok) {
      logger.warn(`[boliga] API error: HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as BoligaApiResponse;
    const results = data.results ?? [];

    return results.map((r) => ({
      address: r.address ?? '',
      zipCode: r.zipCode ?? params.zipCode,
      price: r.price ?? 0,
      pricePerSqm: r.sqmPrice ?? 0,
      sqm: r.size ?? 0,
      rooms: r.rooms ?? 0,
      soldDate: r.soldDate ?? '',
      propertyType: PROPERTY_TYPE_MAP[r.propertyType ?? 0] ?? 'ukendt',
      buildYear: r.buildYear ?? null,
    }));
  } catch (err) {
    logger.warn('[boliga] Fetch failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Formatér sammenlignelige salg til prompt-kontekst tekst.
 *
 * @param sales - Array af solgte boliger
 * @returns Formateret tekst til Claude prompt
 */
export function formatComparablesForPrompt(sales: BoligaSold[]): string {
  if (sales.length === 0) return '';

  const lines = sales.map((s, i) => {
    const parts = [
      `${i + 1}. ${s.address}`,
      `   ${s.sqm} m², ${s.rooms} vær., ${s.propertyType}`,
      `   Solgt: ${s.price.toLocaleString('da-DK')} DKK (${s.pricePerSqm.toLocaleString('da-DK')} DKK/m²)`,
      `   Dato: ${s.soldDate}`,
      s.buildYear ? `   Byggeår: ${s.buildYear}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return parts;
  });

  return `SAMMENLIGNELIGE SALG I OMRÅDET (seneste 2 år):\n${lines.join('\n\n')}`;
}
