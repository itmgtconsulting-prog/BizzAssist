/**
 * GET /api/search/virksomheder — søg i virksomhedsdatabasen med filtre og pagination.
 *
 * BIZZ-1091/1092: Bruges af virksomheder-listesiden til at søge i cvr_virksomhed
 * cache-tabellen (2.1M virksomheder) med filtre og pagination.
 *
 * Sikkerhed: auth required, rate limited, max 100 resultater per side.
 *
 * @param searchParams - q, status, branche, form, kommune, page, limit
 * @returns { results: VirksomhedSearchResult[], total: number, page: number, limit: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

const MAX_LIMIT = 100;

/** Søgeresultat for en virksomhed */
export interface VirksomhedSearchResult {
  cvr: string;
  navn: string;
  status: string | null;
  virksomhedsform: string | null;
  branche_tekst: string | null;
  ansatte_aar: number | null;
  ophoert: string | null;
  adresse_json: Record<string, unknown> | null;
}

export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const q = sp.get('q')?.trim();
  const status = sp.get('status'); // 'Aktiv' | 'Ophørt' | null
  const branche = sp.get('branche');
  const form = sp.getAll('form'); // virksomhedsformer (kan være flere)
  const kommune = sp.get('kommune');
  const page = Math.max(1, Number(sp.get('page') ?? 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get('limit') ?? 20)));

  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (admin as any)
      .from('cvr_virksomhed')
      .select(
        'cvr, navn, status, virksomhedsform, branche_tekst, ansatte_aar, ophoert, adresse_json',
        { count: 'exact' }
      );

    /* Fritekst-søgning via dansk full-text search */
    if (q && q.length >= 2) {
      // Prøv CVR-nummer match først
      if (/^\d{8}$/.test(q)) {
        query = query.eq('cvr', q);
      } else {
        query = query.textSearch('navn', q, { type: 'websearch', config: 'danish' });
      }
    }

    /* Filtre */
    if (status === 'Aktiv') query = query.is('ophoert', null);
    if (status === 'Ophørt') query = query.not('ophoert', 'is', null);
    if (branche) query = query.eq('branche_tekst', branche);
    if (form.length > 0) query = query.in('virksomhedsform', form);
    if (kommune) {
      // kommune-felt i adresse_json: adresse_json->>'postdistrikt' eller beliggenhedsadresse
      // cvr_virksomhed har ikke kommune_kode — skip for nu
    }

    /* Pagination */
    const from = (page - 1) * limit;
    query = query.range(from, from + limit - 1).order('navn', { ascending: true });

    const { data, error, count } = await query;

    if (error) {
      logger.error('[search/virksomheder]', error.message);
      return NextResponse.json({ error: 'Databasefejl' }, { status: 500 });
    }

    return NextResponse.json(
      {
        results: (data ?? []) as VirksomhedSearchResult[],
        total: count ?? 0,
        page,
        limit,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } }
    );
  } catch (err) {
    logger.error('[search/virksomheder] exception:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
