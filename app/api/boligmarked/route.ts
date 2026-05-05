/**
 * GET /api/boligmarked — ejendomssalgspriser fra Danmarks Statistik EJEN77.
 *
 * BIZZ-962: Henter gennemsnitlige salgspriser pr. ejendomskategori og region.
 * Returnerer seneste 4 kvartaler med prisudvikling.
 *
 * @param region - DST områdekode (f.eks. "084" for Region Hovedstaden)
 * @param type - 'enfamiliehus' | 'ejerlejlighed' | 'sommerhus' (default: enfamiliehus)
 * @returns { priser: Array<{kvartal, prisTusindKr}>, aendringYoY }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** API response */
export interface BoligmarkedData {
  /** Region/område */
  omraade: string;
  /** Ejendomstype */
  type: string;
  /** Seneste kvartaler med gennemsnitspris */
  priser: Array<{ kvartal: string; prisTusindKr: number }>;
  /** Ændring seneste kvartal vs. samme kvartal året før (pct.) */
  aendringYoY: number | null;
}

const STATBANK_URL = 'https://api.statbank.dk/v1/data';

/** Mapping fra type til EJENDOMSKATE-kode */
const TYPE_MAP: Record<string, { kode: string; label: string }> = {
  enfamiliehus: { kode: '0111', label: 'Enfamiliehuse' },
  ejerlejlighed: { kode: '2103', label: 'Ejerlejligheder' },
  sommerhus: { kode: '0801', label: 'Sommerhuse' },
};

/** Mapping fra kommunekode til DST områdekode */
function kommuneTilOmraade(kommunekode: number): string {
  if (kommunekode === 101) return '01'; // København
  if (kommunekode >= 147 && kommunekode <= 190) return '02'; // Københavns omegn
  if (kommunekode >= 201 && kommunekode <= 270) return '03'; // Nordsjælland
  if (kommunekode >= 300 && kommunekode <= 390) return '04'; // Bornholm+Østsjælland
  if (kommunekode >= 400 && kommunekode <= 499) return '05'; // Fyn
  if (kommunekode >= 530 && kommunekode <= 580) return '07'; // Sydjylland
  if (kommunekode >= 600 && kommunekode <= 670) return '08'; // Østjylland
  if (kommunekode >= 700 && kommunekode <= 770) return '09'; // Vestjylland
  if (kommunekode >= 773 && kommunekode <= 860) return '10'; // Nordjylland
  return '000'; // Hele landet
}

export async function GET(
  request: NextRequest
): Promise<NextResponse<BoligmarkedData | { fejl: string }>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' } as unknown as { fejl: string }, {
      status: 401,
    });
  }

  const kommunekode = parseInt(request.nextUrl.searchParams.get('kommunekode') ?? '', 10);
  const type = request.nextUrl.searchParams.get('type') ?? 'enfamiliehus';
  const typeInfo = TYPE_MAP[type];
  if (!typeInfo) {
    return NextResponse.json({ fejl: 'Ugyldig type' }, { status: 400 });
  }

  const omraade = isNaN(kommunekode) ? '000' : kommuneTilOmraade(kommunekode);

  try {
    // Hent seneste 8 kvartaler
    const tableInfoRes = await fetch('https://api.statbank.dk/v1/tableinfo/EJEN77?format=JSON', {
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

    const res = await fetch(STATBANK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'EJEN77',
        format: 'JSONSTAT',
        variables: [
          { code: 'OMRÅDE', values: [omraade] },
          { code: 'EJENDOMSKATE', values: [typeInfo.kode] },
          { code: 'BNØGLE', values: ['3'] }, // Gennemsnitlig pris pr. ejendom
          { code: 'OVERDRAG', values: ['1'] }, // Almindelig fri handel
          { code: 'Tid', values: latestTids },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`[boligmarked] StatBank EJEN77 fejlede: ${res.status}`);
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

    const priser = tidLabels.map((kvartal, i) => ({
      kvartal,
      prisTusindKr: vals[i] ?? 0,
    }));

    // YoY ændring
    let aendringYoY: number | null = null;
    if (vals.length >= 5) {
      const latest = vals[vals.length - 1];
      const prevYear = vals[vals.length - 5];
      if (prevYear > 0) {
        aendringYoY = Math.round(((latest - prevYear) / prevYear) * 1000) / 10;
      }
    }

    return NextResponse.json(
      {
        omraade: omraadeLabel,
        type: typeInfo.label,
        priser,
        aendringYoY,
      },
      {
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    logger.error('[boligmarked] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ fejl: 'Ekstern API fejl' });
  }
}
