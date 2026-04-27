/**
 * GET /api/byggeaktivitet — fuldført byggeri fra DST BYGV22.
 *
 * BIZZ-1027: Viser byggeaktivitet (antal boliger fuldført) per område.
 *
 * @param kommunekode - 4-cifret kommunekode
 * @returns { kvartaler, antalBoliger, trend }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** API response */
export interface ByggeaktivitetData {
  /** Område */
  omraade: string;
  /** Seneste kvartal */
  kvartal: string;
  /** Antal fuldførte boliger (nybyggeri) i seneste kvartal */
  antalBoliger: number;
  /** Historik seneste 4 kvartaler */
  historik: Array<{ kvartal: string; antal: number }>;
}

const STATBANK_URL = 'https://api.statbank.dk/v1/data';

/** Kommunekode → DST områdekode */
function kommuneTilOmraade(kode: number): string {
  if (kode === 101) return '01';
  if (kode >= 147 && kode <= 190) return '02';
  if (kode >= 201 && kode <= 270) return '03';
  if (kode >= 300 && kode <= 390) return '04';
  if (kode >= 400 && kode <= 499) return '05';
  if (kode >= 530 && kode <= 580) return '07';
  if (kode >= 600 && kode <= 670) return '08';
  if (kode >= 700 && kode <= 770) return '09';
  if (kode >= 773 && kode <= 860) return '10';
  return '000';
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const kommunekode = parseInt(request.nextUrl.searchParams.get('kommunekode') ?? '', 10);
  const omraade = isNaN(kommunekode) ? '000' : kommuneTilOmraade(kommunekode);

  try {
    const tableInfoRes = await fetch('https://api.statbank.dk/v1/tableinfo/BYGV22?format=JSON', {
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 86400 },
    });
    if (!tableInfoRes.ok) return NextResponse.json({ fejl: 'Ekstern API fejl' });

    const tableInfo = (await tableInfoRes.json()) as {
      variables: Array<{ id: string; values: Array<{ id: string }> }>;
    };
    const tids = tableInfo.variables.find((v) => v.id === 'Tid')?.values ?? [];
    const latestTids = tids.slice(-4).map((t) => t.id);

    const res = await fetch(STATBANK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'BYGV22',
        format: 'JSONSTAT',
        variables: [
          { code: 'OMRÅDE', values: [omraade] },
          { code: 'TAL', values: ['46'] },
          { code: 'AAR', values: ['0'] },
          { code: 'BYGGESAG', values: ['1'] },
          { code: 'ANVENDELSE', values: ['120'] },
          { code: 'Tid', values: latestTids },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`[byggeaktivitet] BYGV22 fejlede: ${res.status}`);
      return NextResponse.json({ fejl: 'Ekstern API fejl' });
    }

    const data = (await res.json()) as {
      dataset?: {
        value?: number[];
        dimension?: Record<string, { category?: { label?: Record<string, string> } }>;
      };
    };
    const vals = data.dataset?.value ?? [];
    const tidLabels = Object.values(data.dataset?.dimension?.Tid?.category?.label ?? {});
    const omraadeLabel =
      Object.values(data.dataset?.dimension?.OMRÅDE?.category?.label ?? {})[0] ?? omraade;

    const historik = tidLabels.map((kvartal, i) => ({
      kvartal,
      antal: vals[i] ?? 0,
    }));

    return NextResponse.json(
      {
        omraade: omraadeLabel,
        kvartal: tidLabels[tidLabels.length - 1] ?? '',
        antalBoliger: vals[vals.length - 1] ?? 0,
        historik,
      } as ByggeaktivitetData,
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
    );
  } catch (err) {
    logger.error('[byggeaktivitet] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ fejl: 'Ekstern API fejl' });
  }
}
