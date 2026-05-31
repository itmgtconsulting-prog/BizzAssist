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
import { logger } from '@/app/lib/logger';

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
  const signalTypes = searchParams.get('signal_types');
  const fromDate = searchParams.get('from_date');
  const toDate = searchParams.get('to_date');
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 200);
  const offset = Number(searchParams.get('offset')) || 0;

  try {
    // admin client unused — using Management API to bypass PostgREST schema-cache

    // BIZZ-1935: Supabase Management API for SQL — bypasser PostgREST schema-cache
    // som ikke ser sidst_opdateret kolonnen på nye MV'er.
    const conditions: string[] = ["signal_type != 'unchanged'"];
    if (signalTypes) {
      const types = signalTypes
        .split(',')
        .filter(Boolean)
        .map((t) => t.replace(/[^a-z_]/g, ''));
      if (types.length > 0)
        conditions.push(`signal_type IN (${types.map((t) => `'${t}'`).join(',')})`);
    } else if (signalType) {
      conditions.push(`signal_type = '${signalType.replace(/[^a-z_]/g, '')}'`);
    }
    if (fromDate) conditions.push(`sidst_opdateret >= '${fromDate.replace(/[^0-9-]/g, '')}'`);
    if (toDate) conditions.push(`sidst_opdateret <= '${toDate.replace(/[^0-9-]/g, '')}'`);

    const where = conditions.join(' AND ');
    const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').match(/\/\/([^.]+)/)?.[1];

    if (!accessToken || !projectRef) {
      return NextResponse.json({ error: 'Mangler SUPABASE_ACCESS_TOKEN' }, { status: 503 });
    }

    const countSql = `SELECT COUNT(*)::int AS total FROM mv_virksomhedshandel_kandidater WHERE ${where}`;
    const dataSql = `SELECT * FROM mv_virksomhedshandel_kandidater WHERE ${where} ORDER BY sidst_opdateret DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`;

    const [countRes, dataRes] = await Promise.all([
      fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: countSql }),
        signal: AbortSignal.timeout(15000),
      }).then((r) => r.json()),
      fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: dataSql }),
        signal: AbortSignal.timeout(15000),
      }).then((r) => r.json()),
    ]);

    const total = Array.isArray(countRes) && countRes[0]?.total != null ? countRes[0].total : 0;
    const data = Array.isArray(dataRes) ? dataRes : [];

    return NextResponse.json({ kandidater: data, total });
  } catch (err) {
    logger.error('[virksomhedshandler/kandidater] catch', { error: err });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
