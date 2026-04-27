/**
 * GET /api/omraadeprofil — befolkningstal + bilpark fra DST.
 *
 * BIZZ-1026 + BIZZ-1032: Beriger områdeprofil med befolkningstal (FOLK1A)
 * og bilpark (BIL707) per kommune.
 *
 * @param kommunekode - 3-4 cifret kommunekode
 * @returns { befolkning, bilerPr1000 }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** API response */
export interface OmraadeprofilData {
  /** Kommunenavn */
  kommune: string;
  /** Befolkningstal */
  befolkning: number | null;
  /** Kvartal for befolkningsdata */
  befolkningKvartal: string | null;
  /** Antal personbiler pr. 1000 indbyggere */
  bilerPr1000: number | null;
  /** Bilpark-år */
  bilparkAar: string | null;
}

const STATBANK_URL = 'https://api.statbank.dk/v1/data';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const kommunekode = request.nextUrl.searchParams.get('kommunekode') ?? '';
  if (!kommunekode || !/^\d{3,4}$/.test(kommunekode)) {
    return NextResponse.json({ fejl: 'Ugyldig kommunekode' }, { status: 400 });
  }

  // DST bruger 3-cifret for nogle kommuner (uden leading 0)
  const dstKommune = String(parseInt(kommunekode, 10));

  try {
    // Hent befolkning fra FOLK1A — seneste kvartal
    const folkInfoRes = await fetch('https://api.statbank.dk/v1/tableinfo/FOLK1A?format=JSON', {
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 86400 },
    });
    let befolkning: number | null = null;
    let befolkningKvartal: string | null = null;
    let kommuneNavn = kommunekode;

    if (folkInfoRes.ok) {
      const folkInfo = (await folkInfoRes.json()) as {
        variables: Array<{ id: string; values: Array<{ id: string }> }>;
      };
      const tids = folkInfo.variables.find((v) => v.id === 'Tid')?.values ?? [];
      const latestTid = tids[tids.length - 1]?.id;

      if (latestTid) {
        const folkRes = await fetch(STATBANK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            table: 'FOLK1A',
            format: 'JSONSTAT',
            variables: [
              { code: 'OMRÅDE', values: [dstKommune] },
              { code: 'KØN', values: ['TOT'] },
              { code: 'ALDER', values: ['IALT'] },
              { code: 'CIVILSTAND', values: ['TOT'] },
              { code: 'Tid', values: [latestTid] },
            ],
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (folkRes.ok) {
          const folkData = (await folkRes.json()) as {
            dataset?: {
              value?: number[];
              dimension?: Record<string, { category?: { label?: Record<string, string> } }>;
            };
          };
          befolkning = folkData.dataset?.value?.[0] ?? null;
          befolkningKvartal =
            Object.values(folkData.dataset?.dimension?.Tid?.category?.label ?? {})[0] ?? latestTid;
          kommuneNavn =
            Object.values(folkData.dataset?.dimension?.OMRÅDE?.category?.label ?? {})[0] ??
            kommunekode;
        }
      }
    }

    // Hent bilpark fra BIL707 — seneste år
    let bilerPr1000: number | null = null;
    let bilparkAar: string | null = null;

    const bilInfoRes = await fetch('https://api.statbank.dk/v1/tableinfo/BIL707?format=JSON', {
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 86400 },
    });
    if (bilInfoRes.ok) {
      const bilInfo = (await bilInfoRes.json()) as {
        variables: Array<{ id: string; values: Array<{ id: string }> }>;
      };
      const bilTids = bilInfo.variables.find((v) => v.id === 'Tid')?.values ?? [];
      const latestBilTid = bilTids[bilTids.length - 1]?.id;

      if (latestBilTid) {
        const bilRes = await fetch(STATBANK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            table: 'BIL707',
            format: 'JSONSTAT',
            variables: [
              { code: 'OMRÅDE', values: [dstKommune] },
              { code: 'BILTYPE', values: ['4000101002'] },
              { code: 'Tid', values: [latestBilTid] },
            ],
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (bilRes.ok) {
          const bilData = (await bilRes.json()) as { dataset?: { value?: number[] } };
          const antalBiler = bilData.dataset?.value?.[0] ?? null;
          if (antalBiler && befolkning && befolkning > 0) {
            bilerPr1000 = Math.round((antalBiler / befolkning) * 1000);
          }
          bilparkAar = latestBilTid;
        }
      }
    }

    return NextResponse.json(
      {
        kommune: kommuneNavn,
        befolkning,
        befolkningKvartal,
        bilerPr1000,
        bilparkAar,
      } as OmraadeprofilData,
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
    );
  } catch (err) {
    logger.error('[omraadeprofil] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ fejl: 'Ekstern API fejl' });
  }
}
