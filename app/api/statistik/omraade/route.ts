/**
 * GET /api/statistik/omraade?kommunekode=0167
 *
 * Henter områdeprofil-data fra Danmarks Statistik (StatBank API).
 * Returnerer befolkningstal, gennemsnitsindkomst og boligdata for
 * en given kommune.
 *
 * Datakilde: api.statbank.dk/v1 (gratis, ingen auth).
 * Cache: 24h LRU (data opdateres kvartalsvis).
 *
 * @param kommunekode - 3- eller 4-cifret kommunekode (fx "0167" for Hvidovre)
 * @returns OmraadeProfilData med nøgletal
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

const querySchema = z.object({
  kommunekode: z
    .string()
    .regex(/^\d{3,4}$/)
    .transform((v) => v.replace(/^0+/, '') || v),
});

/** Områdeprofil-response. */
export interface OmraadeProfilData {
  kommunekode: string;
  kommunenavn: string | null;
  befolkning: number | null;
  befolkningKvartal: string | null;
  /** Disponibel gennemsnitsindkomst i DKK */
  gnsIndkomst: number | null;
  indkomstAar: number | null;
  /** Antal boliger i kommunen */
  antalBoliger: number | null;
  boligAar: number | null;
  fejl: string | null;
}

const STATBANK_URL = 'https://api.statbank.dk/v1/data';

// ─── LRU cache (24h) ─────────────────────────────────────────────────────

const cache = new Map<string, { data: OmraadeProfilData; ts: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 150;

/**
 * Henter data fra StatBank via POST /v1/data.
 *
 * @param table - Tabelnavn (fx "FOLK1A")
 * @param variables - Array af { code, values } filtre
 * @returns Parsed JSONSTAT dataset
 */
async function fetchStatBank(
  table: string,
  variables: Array<{ code: string; values: string[] }>
): Promise<{
  value: number[];
  dimension: Record<string, { category: { label: Record<string, string> } }>;
} | null> {
  try {
    const res = await fetch(STATBANK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, format: 'JSONSTAT', lang: 'da', variables }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn(`[statistik] StatBank ${table} fejlede: ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      dataset?: { value?: number[]; dimension?: Record<string, unknown> };
    };
    return json.dataset as ReturnType<typeof fetchStatBank> extends Promise<infer T> ? T : never;
  } catch (err) {
    logger.warn(`[statistik] StatBank ${table} fejl:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ugyldige parametre' }, { status: 400 });
  }

  const { kommunekode } = parsed.data;

  // Check cache
  const cached = cache.get(kommunekode);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    });
  }

  // Fetch in parallel: befolkning, indkomst, boliger
  const [folkResult, indkomstResult, boligResult] = await Promise.all([
    // FOLK1A: Befolkning seneste kvartal
    fetchStatBank('FOLK1A', [
      { code: 'OMRÅDE', values: [kommunekode] },
      { code: 'KØN', values: ['TOT'] },
      { code: 'ALDER', values: ['IALT'] },
      { code: 'CIVILSTAND', values: ['TOT'] },
      { code: 'Tid', values: ['*'] },
    ]),
    // INDKP106: Disponibel indkomst (gennemsnit)
    fetchStatBank('INDKP106', [
      { code: 'OMRÅDE', values: [kommunekode] },
      { code: 'ENHED', values: ['116'] }, // Gennemsnit i kr.
      { code: 'KOEN', values: ['MOK'] }, // Mænd og kvinder
      { code: 'Tid', values: ['*'] },
    ]),
    // BOL101: Antal boliger
    fetchStatBank('BOL101', [
      { code: 'OMRÅDE', values: [kommunekode] },
      { code: 'ANVEND', values: ['BOLIGF'] }, // Boligformål
      { code: 'Tid', values: ['*'] },
    ]),
  ]);

  // Parse befolkning — tag seneste value
  let befolkning: number | null = null;
  let befolkningKvartal: string | null = null;
  let kommunenavn: string | null = null;
  if (folkResult?.value) {
    const values = folkResult.value;
    befolkning = values[values.length - 1] ?? null;
    // Extract kvartal label
    const tidDim = folkResult.dimension?.Tid ?? folkResult.dimension?.['Tid'];
    if (tidDim?.category?.label) {
      const labels = Object.values(tidDim.category.label);
      befolkningKvartal = labels[labels.length - 1] ?? null;
    }
    // Extract kommunenavn
    const omrDim = folkResult.dimension?.['OMRÅDE'];
    if (omrDim?.category?.label) {
      kommunenavn = Object.values(omrDim.category.label)[0] ?? null;
    }
  }

  // Parse indkomst — tag seneste value
  let gnsIndkomst: number | null = null;
  let indkomstAar: number | null = null;
  if (indkomstResult?.value) {
    const values = indkomstResult.value;
    gnsIndkomst = values[values.length - 1] ?? null;
    const tidDim = indkomstResult.dimension?.Tid ?? indkomstResult.dimension?.['Tid'];
    if (tidDim?.category?.label) {
      const labels = Object.keys(tidDim.category.label);
      const lastKey = labels[labels.length - 1];
      indkomstAar = lastKey ? parseInt(lastKey, 10) : null;
    }
  }

  // Parse boliger — tag seneste value
  let antalBoliger: number | null = null;
  let boligAar: number | null = null;
  if (boligResult?.value) {
    const values = boligResult.value;
    antalBoliger = values[values.length - 1] ?? null;
    const tidDim = boligResult.dimension?.Tid ?? boligResult.dimension?.['Tid'];
    if (tidDim?.category?.label) {
      const labels = Object.keys(tidDim.category.label);
      const lastKey = labels[labels.length - 1];
      boligAar = lastKey ? parseInt(lastKey, 10) : null;
    }
  }

  const result: OmraadeProfilData = {
    kommunekode,
    kommunenavn,
    befolkning,
    befolkningKvartal,
    gnsIndkomst,
    indkomstAar,
    antalBoliger,
    boligAar,
    fejl: null,
  };

  // Update cache
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(kommunekode, { data: result, ts: Date.now() });

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
  });
}
