/**
 * GET /api/boligmarked/ejf-kvmpris?postnr=2800
 *
 * BIZZ-1733: Median kvm-pris fra EJF fri handel i et postnr-område.
 *
 * Beregner median kvm-pris fra ejf_ejerskifte + ejf_handelsoplysninger
 * + bbr_ejendom_status, filtreret på overdragelsesmaade = Almindelig fri handel.
 *
 * @param request - GET med ?postnr=XXXX
 * @returns { medianKvmPris, antalHandler, postnr }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';

export const maxDuration = 15;

export interface EjfKvmPrisData {
  postnr: string;
  medianKvmPris: number | null;
  gennemsnitKvmPris: number | null;
  antalHandler: number;
  periode: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const postnr = request.nextUrl.searchParams.get('postnr');
  if (!postnr || !/^\d{4}$/.test(postnr)) {
    return NextResponse.json({ error: 'Ugyldigt postnr' }, { status: 400 });
  }

  try {
    const admin = createAdminClient();

    // 3-årig periode
    const treAarSiden = new Date();
    treAarSiden.setFullYear(treAarSiden.getFullYear() - 3);
    const fra = treAarSiden.toISOString().split('T')[0];

    // Find BFE'er i postnr-området via bfe_adresse_cache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: bfeRows } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('bfe_nummer')
      .eq('postnr', postnr)
      .limit(500);

    if (!bfeRows || bfeRows.length === 0) {
      return NextResponse.json({
        postnr,
        medianKvmPris: null,
        gennemsnitKvmPris: null,
        antalHandler: 0,
        periode: `${fra} – nu`,
      });
    }

    const bfes = (bfeRows as Array<{ bfe_nummer: number }>).map((r) => r.bfe_nummer);

    // Hent fri handel ejerskifter med handelsoplysninger
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejerskifter } = await (admin as any)
      .from('ejf_ejerskifte')
      .select('bfe_nummer, handelsoplysninger_lokal_id')
      .in('bfe_nummer', bfes)
      .eq('status', 'gældende')
      .eq('overdragelsesmaade', 'Almindelig fri handel')
      .gte('overtagelsesdato', fra)
      .not('handelsoplysninger_lokal_id', 'is', null)
      .limit(200);

    if (!ejerskifter || ejerskifter.length === 0) {
      return NextResponse.json({
        postnr,
        medianKvmPris: null,
        gennemsnitKvmPris: null,
        antalHandler: 0,
        periode: `${fra} – nu`,
      });
    }

    // Hent priser
    const handelsIds = (ejerskifter as Array<Record<string, unknown>>)
      .map((e) => e.handelsoplysninger_lokal_id as string)
      .filter((id, i, arr) => arr.indexOf(id) === i);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: handelsData } = await (admin as any)
      .from('ejf_handelsoplysninger')
      .select('id_lokal_id, kontant_koebesum, samlet_koebesum')
      .in('id_lokal_id', handelsIds);

    const prisMap = new Map(
      ((handelsData ?? []) as Array<Record<string, unknown>>).map((h) => [
        h.id_lokal_id as string,
        (h.kontant_koebesum as number) ?? (h.samlet_koebesum as number) ?? null,
      ])
    );

    // Hent boligareal for BFE'er
    const ejfBfes = (ejerskifter as Array<Record<string, unknown>>)
      .map((e) => e.bfe_nummer as number)
      .filter((b, i, arr) => arr.indexOf(b) === i);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: bbrData } = await (admin as any)
      .from('bbr_ejendom_status')
      .select('bfe_nummer, samlet_boligareal')
      .in('bfe_nummer', ejfBfes);

    const arealMap = new Map(
      ((bbrData ?? []) as Array<Record<string, unknown>>).map((b) => [
        b.bfe_nummer as number,
        (b.samlet_boligareal as number) ?? null,
      ])
    );

    // Beregn kvm-priser
    const kvmPriser: number[] = [];
    for (const e of ejerskifter as Array<Record<string, unknown>>) {
      const hId = e.handelsoplysninger_lokal_id as string;
      const pris = prisMap.get(hId);
      const areal = arealMap.get(e.bfe_nummer as number);
      if (pris && pris > 0 && areal && areal > 0) {
        kvmPriser.push(Math.round(pris / areal));
      }
    }

    if (kvmPriser.length === 0) {
      return NextResponse.json({
        postnr,
        medianKvmPris: null,
        gennemsnitKvmPris: null,
        antalHandler: 0,
        periode: `${fra} – nu`,
      });
    }

    // Median + gennemsnit
    const sorted = [...kvmPriser].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
    const avg = Math.round(kvmPriser.reduce((a, b) => a + b, 0) / kvmPriser.length);

    return NextResponse.json(
      {
        postnr,
        medianKvmPris: median,
        gennemsnitKvmPris: avg,
        antalHandler: kvmPriser.length,
        periode: `${fra} – nu`,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' } }
    );
  } catch (err) {
    logger.error('[boligmarked/ejf-kvmpris]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
