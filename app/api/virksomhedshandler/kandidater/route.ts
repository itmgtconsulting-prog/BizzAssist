/**
 * GET /api/virksomhedshandler/kandidater
 *
 * BIZZ-1929: Henter virksomhedshandel-kandidater fra mv_virksomhedshandel_kandidater.
 * Understøtter filtrering på signal_type, tidsperiode og pagination.
 *
 * Query params:
 * - signal_type  - Filter på signal (entry|exit|increase|decrease)
 * - from_date    - Gyldig fra dato (YYYY-MM-DD)
 * - to_date      - Gyldig til dato (YYYY-MM-DD)
 * - limit        - Max antal resultater (default 50, max 200)
 * - offset       - Offset for pagination
 *
 * @returns { kandidater: [...], total: number }
 *
 * @module app/api/virksomhedshandler/kandidater/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

/**
 * GET handler — henter kandidater med filtrering og pagination.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(req, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const signalType = searchParams.get('signal_type');
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);
  const offset = Number(searchParams.get('offset')) || 0;

  try {
    const admin = createAdminClient();

    let query = admin
      .from('mv_virksomhedshandel_kandidater')
      .select('*', { count: 'exact' })
      .neq('signal_type', 'unchanged')
      .order('gyldig_fra', { ascending: false })
      .range(offset, offset + limit - 1);

    if (signalType) {
      query = query.eq('signal_type', signalType);
    }
    if (fromDate) {
      query = query.gte('gyldig_fra', fromDate);
    }
    if (toDate) {
      query = query.lte('gyldig_fra', toDate);
    }

    const { data, count, error } = await query;

    if (error) {
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
    }

    return NextResponse.json({ kandidater: data ?? [], total: count ?? 0 });
  } catch {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
