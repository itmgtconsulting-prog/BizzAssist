/**
 * POST /api/penhed-resolve
 *
 * Batch-resolver P-enhed adresser til koordinater + BFE via DAWA.
 * Bruges af VirksomhedOverblikTab til at vise ejendomslinks og kort-markører.
 *
 * Input: { addresses: Array<{ pno: number; address: string; zipcode: string; city: string }> }
 * Output: { results: Record<number, { lat: number; lng: number; bfe: number | null } | null> }
 *
 * Maks 100 adresser per kald. Parallelisme begrænset til 5 samtidige DAWA-opslag.
 *
 * @param request - POST body med addresses array
 * @returns Map fra P-nummer til koordinater + BFE (null hvis opslag fejler)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { fetchDawa } from '@/app/lib/dawa';

const MAX_ADDRESSES = 100;
const DAWA_CONCURRENCY = 5;

/** Zod schema for request body */
const requestSchema = z.object({
  addresses: z
    .array(
      z.object({
        pno: z.number(),
        address: z.string(),
        zipcode: z.string(),
        city: z.string(),
      })
    )
    .min(1)
    .max(MAX_ADDRESSES),
});

/** Resultat for en enkelt P-enhed */
export interface PenhedLocation {
  lat: number;
  lng: number;
  bfe: number | null;
}

/**
 * Resolver en enkelt adresse til koordinater + BFE via DAWA datavask.
 *
 * @param betegnelse - Fuld adressebetegnelse (fx "Vesterbrogade 1, 1620 København V")
 * @returns Koordinater og BFE eller null hvis opslag fejler
 */
async function resolveAddress(betegnelse: string): Promise<PenhedLocation | null> {
  try {
    const url = `https://api.dataforsyningen.dk/datavask/adgangsadresser?betegnelse=${encodeURIComponent(betegnelse)}`;
    const res = await fetchDawa(
      url,
      { signal: AbortSignal.timeout(10000) },
      { caller: 'penhed-resolve.datavask' }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      resultater?: Array<{
        adgangsadresse?: {
          id?: string;
          adgangspunkt?: { koordinater?: [number, number] };
          ejerlav?: { kode?: number };
          matrikelnr?: string;
        };
      }>;
    };

    const best = data.resultater?.[0]?.adgangsadresse;
    if (!best?.adgangspunkt?.koordinater) return null;

    const [lng, lat] = best.adgangspunkt.koordinater;
    if (!lat || !lng) return null;

    /* ── BFE via jordstykke ── */
    let bfe: number | null = null;
    const ek = best.ejerlav?.kode;
    const mn = best.matrikelnr;
    if (ek && mn) {
      try {
        const jsUrl = `https://api.dataforsyningen.dk/jordstykker/${ek}/${encodeURIComponent(mn)}`;
        const jsRes = await fetchDawa(
          jsUrl,
          { signal: AbortSignal.timeout(10000) },
          { caller: 'penhed-resolve.jordstykker' }
        );
        if (jsRes.ok) {
          const js = (await jsRes.json()) as { bfenummer?: number };
          bfe = js.bfenummer ?? null;
        }
      } catch {
        /* BFE er nice-to-have — koordinater er vigtigst */
      }
    }

    return { lat, lng, bfe };
  } catch {
    return null;
  }
}

/**
 * Kører N async funktioner med begrænset parallelisme.
 *
 * @param items - Array af inputs
 * @param concurrency - Maks samtidige kørsler
 * @param fn - Async funktion der skal køres for hvert item
 * @returns Array af resultater i samme rækkefølge som inputs
 */
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Ugyldigt input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { addresses } = parsed.data;

  try {
    const resolved = await pMap(addresses, DAWA_CONCURRENCY, async (addr) => {
      const betegnelse = `${addr.address}, ${addr.zipcode} ${addr.city}`;
      const location = await resolveAddress(betegnelse);
      return { pno: addr.pno, location };
    });

    const results: Record<number, PenhedLocation | null> = {};
    for (const r of resolved) {
      results[r.pno] = r.location;
    }

    return NextResponse.json(
      { results },
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=172800' } }
    );
  } catch (err) {
    logger.error('[penhed-resolve] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
