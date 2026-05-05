/**
 * GET /api/byggeomkostninger — byggeomkostningsindeks fra Danmarks Statistik.
 *
 * BIZZ-968: Henter BYG42 (byggeomkostningsindeks for boliger) fra StatBank API.
 * Returnerer seneste kvartalsindeks for enfamiliehuse og etageboliger.
 *
 * @param type - 'enfamiliehus' | 'etagebolig' (default: enfamiliehus)
 * @returns { type, indeks, kvartal, aendringYoY }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** API response */
export interface ByggeomkostningData {
  /** Bygningstype */
  type: string;
  /** Seneste indeksværdi (base 2015=100) */
  indeks: number;
  /** Kvartal (f.eks. "2023K4") */
  kvartal: string;
  /** Ændring i forhold til samme kvartal året før (pct.) */
  aendringYoY: number | null;
}

/** StatBank API endpoint */
const STATBANK_URL = 'https://api.statbank.dk/v1/data';

/** Mapping fra type til HINDEKS-kode */
const TYPE_MAP: Record<string, string> = {
  enfamiliehus: '02',
  etagebolig: '03',
};

export async function GET(
  request: NextRequest
): Promise<NextResponse<ByggeomkostningData | { fejl: string }>> {
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as { fejl: string }, {
      status: 401,
    });

  const type = request.nextUrl.searchParams.get('type') ?? 'enfamiliehus';
  const hindeks = TYPE_MAP[type];
  if (!hindeks) {
    return NextResponse.json(
      { fejl: 'Ugyldig type — brug enfamiliehus eller etagebolig' },
      { status: 400 }
    );
  }

  try {
    // Hent seneste 8 kvartaler (2 år) for at beregne YoY
    const tableInfoRes = await fetch('https://api.statbank.dk/v1/tableinfo/BYG42?format=JSON', {
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 86400 },
    });
    if (!tableInfoRes.ok) {
      return NextResponse.json({ fejl: 'Ekstern API fejl' });
    }
    const tableInfo = (await tableInfoRes.json()) as {
      variables: Array<{ id: string; values: Array<{ id: string }> }>;
    };
    const tids = tableInfo.variables.find((v) => v.id === 'Tid')?.values ?? [];
    const latestTids = tids.slice(-8).map((t) => t.id);

    if (latestTids.length === 0) {
      return NextResponse.json({ fejl: 'Ingen tidsperioder tilgængelig' });
    }

    // Hent indeks-data
    const res = await fetch(STATBANK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'BYG42',
        format: 'JSONSTAT',
        variables: [
          { code: 'HINDEKS', values: [hindeks] },
          { code: 'DINDEKS', values: ['10000'] },
          { code: 'ART', values: ['1002'] },
          { code: 'TAL', values: ['100'] },
          { code: 'Tid', values: latestTids },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`[byggeomkostninger] StatBank fejlede: ${res.status}`);
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

    if (vals.length === 0 || tidLabels.length === 0) {
      return NextResponse.json({ fejl: 'Ingen data tilgængelig' });
    }

    const latestIdx = vals.length - 1;
    const latestVal = vals[latestIdx];
    const latestKvartal = tidLabels[latestIdx] ?? latestTids[latestIdx];

    // YoY: sammenlign med 4 kvartaler tidligere
    let aendringYoY: number | null = null;
    if (vals.length >= 5) {
      const prevYearVal = vals[latestIdx - 4];
      if (prevYearVal > 0) {
        aendringYoY = Math.round(((latestVal - prevYearVal) / prevYearVal) * 1000) / 10;
      }
    }

    return NextResponse.json(
      {
        type: type === 'enfamiliehus' ? 'Enfamiliehus' : 'Etagebolig',
        indeks: latestVal,
        kvartal: latestKvartal,
        aendringYoY,
      },
      {
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    logger.error('[byggeomkostninger] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ fejl: 'Ekstern API fejl' });
  }
}
