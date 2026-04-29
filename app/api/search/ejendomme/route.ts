/**
 * GET /api/search/ejendomme — søg i ejendomsdatabasen med filtre og pagination.
 *
 * BIZZ-1088: Bruges af ejendomme-listesiden til at søge i ~2.8M ejendomme
 * baseret på kommune, postnummer, ejendomstype, areal og opførelsesår.
 *
 * Sikkerhed: auth required, rate limited, max 100 resultater per side.
 *
 * @param searchParams - Filter parameters (kommune_kode, postnr, type, areal_min, areal_max, aar_min, aar_max, page, limit)
 * @returns { results: EjendomSearchResult[], total: number, page: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { KOMMUNE_NAVN } from '@/app/lib/kommuner';

const MAX_LIMIT = 100;

/** Søgeresultat for en ejendom */
export interface EjendomSearchResult {
  bfe_nummer: number;
  kommune_kode: number | null;
  samlet_boligareal: number | null;
  opfoerelsesaar: number | null;
  energimaerke: string | null;
  byg021_anvendelse: string | null;
  is_udfaset: boolean;
}

export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const kommuneKoder = sp
    .getAll('kommune_kode')
    .map(Number)
    .filter((n) => !isNaN(n));
  const kommuneNavn = sp.get('kommune'); // BIZZ-1090: kommune-navn filter
  const _postnumre = sp.getAll('postnr'); // TODO: kræver adgangsadresse join
  const type = sp.get('type');
  const arealMin = sp.get('areal_min') ? Number(sp.get('areal_min')) : null;
  const arealMax = sp.get('areal_max') ? Number(sp.get('areal_max')) : null;
  const aarMin = sp.get('aar_min') ? Number(sp.get('aar_min')) : null;
  const aarMax = sp.get('aar_max') ? Number(sp.get('aar_max')) : null;
  const energi = sp.get('energi');
  const page = Math.max(1, Number(sp.get('page') ?? 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get('limit') ?? 50)));

  try {
    const admin = createAdminClient();
    let query = admin
      .from('bbr_ejendom_status')
      .select(
        'bfe_nummer, kommune_kode, samlet_boligareal, opfoerelsesaar, energimaerke, byg021_anvendelse, is_udfaset',
        { count: 'exact' }
      )
      .eq('is_udfaset', false);

    /* Filtre */
    // BIZZ-1090: Resolve kommune-navn til kode via KOMMUNE_NAVN map
    const allKommuneKoder = [...kommuneKoder];
    if (kommuneNavn) {
      const navnLower = kommuneNavn.toLowerCase().replace(' kommune', '');
      for (const [kode, navn] of Object.entries(KOMMUNE_NAVN)) {
        if (navn.toLowerCase() === navnLower) {
          allKommuneKoder.push(Number(kode));
          break;
        }
      }
    }
    if (allKommuneKoder.length > 0) query = query.in('kommune_kode', allKommuneKoder);
    if (type === 'bolig') query = query.gt('samlet_boligareal', 0);
    if (type === 'erhverv') query = query.is('samlet_boligareal', null);
    if (arealMin != null) query = query.gte('samlet_boligareal', arealMin);
    if (arealMax != null) query = query.lte('samlet_boligareal', arealMax);
    if (aarMin != null) query = query.gte('opfoerelsesaar', aarMin);
    if (aarMax != null) query = query.lte('opfoerelsesaar', aarMax);
    if (energi) query = query.eq('energimaerke', energi);

    /* Pagination */
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1).order('bfe_nummer', { ascending: true });

    const { data, error, count } = await query;

    if (error) {
      logger.error('[search/ejendomme]', error.message);
      return NextResponse.json({ error: 'Databasefejl' }, { status: 500 });
    }

    return NextResponse.json(
      {
        results: (data ?? []) as EjendomSearchResult[],
        total: count ?? 0,
        page,
        limit,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } }
    );
  } catch (err) {
    logger.error('[search/ejendomme] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
