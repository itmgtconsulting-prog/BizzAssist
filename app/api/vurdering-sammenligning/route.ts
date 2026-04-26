/**
 * GET /api/vurdering-sammenligning?postnr=2650&ejendomsvaerdi=1900000&grundvaerdi=315300&areal=856
 *
 * BIZZ-958: Benchmark ejendomsvurdering mod postnummer-gennemsnit.
 * Henter foreløbige vurderinger fra Vurderingsportalen ES for samme
 * postnummer og beregner percentil-placering.
 *
 * @param postnr - 4-cifret postnummer
 * @param ejendomsvaerdi - Ejendommens ejendomsværdi (DKK)
 * @param grundvaerdi - Ejendommens grundværdi (DKK)
 * @param areal - Ejendommens vurderede areal (m²)
 * @returns Sammenligning med gennemsnit, percentil, min/max
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

const querySchema = z.object({
  postnr: z.string().regex(/^\d{4}$/),
  ejendomsvaerdi: z.coerce.number().optional(),
  grundvaerdi: z.coerce.number().optional(),
  areal: z.coerce.number().optional(),
});

const VP_ES = 'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search';

/** Sammenligning-respons. */
export interface VurderingSammenligningData {
  postnr: string;
  antalEjendomme: number;
  ejendomsvaerdi: {
    gennemsnit: number;
    median: number;
    min: number;
    max: number;
    dinVaerdi: number | null;
    percentil: number | null;
  } | null;
  grundvaerdiPrM2: {
    gennemsnit: number;
    median: number;
    dinVaerdi: number | null;
    percentil: number | null;
  } | null;
}

/**
 * Beregn percentil — hvor mange % af værdier der er <= din.
 */
function percentil(values: number[], dinVaerdi: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = sorted.findIndex((v) => v > dinVaerdi);
  if (idx === -1) return 100;
  return Math.round((idx / sorted.length) * 100);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ugyldige parametre' }, { status: 400 });
  }

  const { postnr, ejendomsvaerdi, grundvaerdi, areal } = parsed.data;

  try {
    // Søg Vurderingsportalen for ejendomme i samme postnummer
    const res = await fetch(VP_ES, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: 200,
        query: {
          bool: {
            must: [{ term: { postNumber: parseInt(postnr, 10) } }],
            filter: [{ exists: { field: 'propertyValue' } }],
          },
        },
        _source: ['propertyValue', 'landValue', 'landArea'],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`[vurdering-sammenligning] VP ES fejlede: ${res.status}`);
      return NextResponse.json({ error: 'Data ikke tilgængelig' }, { status: 503 });
    }

    const data = await res.json();
    const hits = data.hits?.hits ?? [];

    if (hits.length === 0) {
      return NextResponse.json({
        postnr,
        antalEjendomme: 0,
        ejendomsvaerdi: null,
        grundvaerdiPrM2: null,
      } satisfies VurderingSammenligningData);
    }

    // Saml værdier
    const evValues: number[] = [];
    const gvPrM2Values: number[] = [];

    for (const hit of hits) {
      const s = hit._source ?? {};
      const ev = s.propertyValue;
      const gv = s.landValue;
      const ar = s.landArea;
      if (typeof ev === 'number' && ev > 0) evValues.push(ev);
      if (typeof gv === 'number' && typeof ar === 'number' && ar > 0) {
        gvPrM2Values.push(Math.round(gv / ar));
      }
    }

    const avg = (arr: number[]) => Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
    const median = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    };

    const result: VurderingSammenligningData = {
      postnr,
      antalEjendomme: hits.length,
      ejendomsvaerdi:
        evValues.length > 0
          ? {
              gennemsnit: avg(evValues),
              median: median(evValues),
              min: Math.min(...evValues),
              max: Math.max(...evValues),
              dinVaerdi: ejendomsvaerdi ?? null,
              percentil: ejendomsvaerdi != null ? percentil(evValues, ejendomsvaerdi) : null,
            }
          : null,
      grundvaerdiPrM2:
        gvPrM2Values.length > 0 && areal && grundvaerdi
          ? {
              gennemsnit: avg(gvPrM2Values),
              median: median(gvPrM2Values),
              dinVaerdi: Math.round(grundvaerdi / areal),
              percentil: percentil(gvPrM2Values, Math.round(grundvaerdi / areal)),
            }
          : null,
    };

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
    });
  } catch (err) {
    logger.warn('[vurdering-sammenligning] fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
