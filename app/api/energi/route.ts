/**
 * GET /api/energi — elspotpriser fra Energinet Datahub.
 *
 * BIZZ-955: Henter gennemsnitlig elspot-pris for et prisområde (DK1/DK2)
 * baseret på kommunekode. Returnerer snit, min, max for seneste 30 dage.
 *
 * @param kommunekode - 4-cifret kommunekode (bestemmer prisområde DK1/DK2)
 * @returns { prisomraade, gennemsnit, min, max, enhed }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** API response */
export interface EnergiData {
  /** Prisområde: DK1 (Vestdanmark) eller DK2 (Østdanmark) */
  prisomraade: string;
  /** Gennemsnitlig spotpris i DKK/kWh (seneste 30 dage) */
  gennemsnit: number;
  /** Laveste spotpris i perioden */
  min: number;
  /** Højeste spotpris i perioden */
  max: number;
  /** Enhed */
  enhed: string;
  /** Antal datapunkter */
  antal: number;
}

/**
 * Bestem prisområde fra kommunekode.
 * DK2 = Sjælland + øer (kommunekode < 400), DK1 = Jylland + Fyn (>= 400).
 *
 * @param kode - 4-cifret kommunekode
 * @returns 'DK1' eller 'DK2'
 */
function prisomraadeFraKommune(kode: number): 'DK1' | 'DK2' {
  return kode >= 400 ? 'DK1' : 'DK2';
}

/** Energidataservice ElspotPrices endpoint */
const ELSPOT_URL = 'https://api.energidataservice.dk/dataset/ElspotPrices';

export async function GET(
  request: NextRequest
): Promise<NextResponse<EnergiData | { fejl: string }>> {
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as { fejl: string }, {
      status: 401,
    });

  const kommunekode = parseInt(request.nextUrl.searchParams.get('kommunekode') ?? '', 10);
  if (isNaN(kommunekode) || kommunekode < 100 || kommunekode > 900) {
    return NextResponse.json({ fejl: 'Ugyldig kommunekode' }, { status: 400 });
  }

  const prisomraade = prisomraadeFraKommune(kommunekode);

  try {
    // Hent seneste 720 timer (~30 dage) af spotpriser
    const filter = JSON.stringify({ PriceArea: prisomraade });
    const url = `${ELSPOT_URL}?limit=720&filter=${encodeURIComponent(filter)}&sort=HourDK%20desc&columns=SpotPriceDKK`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      logger.warn(`[energi] Energidataservice fejlede: ${res.status}`);
      return NextResponse.json({ fejl: 'Ekstern API fejl' });
    }

    const data = (await res.json()) as {
      records?: Array<{ SpotPriceDKK: number | null }>;
    };

    const prices = (data.records ?? [])
      .map((r) => r.SpotPriceDKK)
      .filter((p): p is number => p != null);

    if (prices.length === 0) {
      return NextResponse.json({ fejl: 'Ingen prisdata tilgængelig' });
    }

    // Konverter fra DKK/MWh til DKK/kWh
    const toKwh = (v: number) => Math.round((v / 1000) * 100) / 100;
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    return NextResponse.json(
      {
        prisomraade,
        gennemsnit: toKwh(avg),
        min: toKwh(Math.min(...prices)),
        max: toKwh(Math.max(...prices)),
        enhed: 'DKK/kWh',
        antal: prices.length,
      },
      {
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    logger.error('[energi] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ fejl: 'Ekstern API fejl' });
  }
}
