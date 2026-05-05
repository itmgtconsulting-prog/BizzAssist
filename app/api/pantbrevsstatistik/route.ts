/**
 * GET /api/pantbrevsstatistik — udlånsstatistik fra Danmarks Statistik DNMUF1.
 *
 * BIZZ-963: Henter aggregerede udlånsdata for husholdninger (realkreditlån).
 * Viser samlet restgæld og antal låntagere over tid.
 *
 * @returns { restgaeld, antalLaantagere, kvartal }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** API response */
export interface PantbrevsData {
  /** Seneste kvartal */
  kvartal: string;
  /** Samlet restgæld for husholdninger (mia. kr) */
  restgaeldMiaKr: number | null;
  /** Antal låntagere */
  antalLaantagere: number | null;
  /** Historik seneste 4 kvartaler */
  historik: Array<{ kvartal: string; restgaeldMiaKr: number }>;
}

const STATBANK_URL = 'https://api.statbank.dk/v1/data';

export async function GET(
  _request: NextRequest
): Promise<NextResponse<PantbrevsData | { fejl: string }>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' } as unknown as { fejl: string }, {
      status: 401,
    });
  }

  try {
    // Hent seneste 8 kvartaler af restgæld for husholdninger (realkreditlån)
    const tableInfoRes = await fetch('https://api.statbank.dk/v1/tableinfo/DNMUF1?format=JSON', {
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

    // Hent restgæld (ONA) for husholdninger (1430) + alle instrumenter
    const res = await fetch(STATBANK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'DNMUF1',
        format: 'JSONSTAT',
        variables: [
          { code: 'OPGOER', values: ['MODPART'] },
          { code: 'DATA', values: ['ONA'] },
          { code: 'SEKTORNAT', values: ['1430'] },
          { code: 'INSTRNAT', values: ['ALLE'] },
          { code: 'Tid', values: latestTids },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`[pantbrevsstatistik] DNMUF1 fejlede: ${res.status}`);
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

    if (vals.length === 0) {
      return NextResponse.json({ fejl: 'Ingen data tilgængelig' });
    }

    const latestIdx = vals.length - 1;
    const historik = tidLabels.map((kvartal, i) => ({
      kvartal,
      restgaeldMiaKr: Math.round((vals[i] ?? 0) / 1000),
    }));

    return NextResponse.json(
      {
        kvartal: tidLabels[latestIdx] ?? '',
        restgaeldMiaKr: Math.round((vals[latestIdx] ?? 0) / 1000),
        antalLaantagere: null, // Kræver separat query med DATA=ANTAL_MODPART
        historik: historik.slice(-4),
      },
      {
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    logger.error('[pantbrevsstatistik] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ fejl: 'Ekstern API fejl' });
  }
}
