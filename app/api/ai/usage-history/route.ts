/**
 * GET /api/ai/usage-history
 *
 * Returnerer pagineret AI token-forbrugshistorik for den autentificerede bruger.
 * Data fra tenant.ai_token_usage — sorteret nyeste først.
 *
 * @query limit  - Antal rows (default 20, max 100)
 * @query offset - Pagination offset (default 0)
 * @returns { rows: UsageRow[], total: number }
 *
 * @retention 12 måneder (purge-old-data cron)
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

export const runtime = 'nodejs';

/** Shape of a single usage row returned to the client. */
export interface UsageHistoryRow {
  id: string;
  route: string | null;
  tokens_in: number;
  tokens_out: number;
  model: string;
  created_at: string;
}

/**
 * GET handler — returnerer token-forbrugshistorik.
 *
 * @param request - GET request med optional limit/offset query params
 * @returns JSON med rows + total count
 */
export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 20), 100);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  const admin = createAdminClient();

  // BIZZ-2205: læs via public SECURITY DEFINER RPC'er. Det delte `tenant`-schema
  // er ikke eksponeret til PostgREST (kun public + udvalgte tenant_*), så en
  // direkte admin.schema('tenant')-query gav PGRST106 → Forbrugshistorik altid tom.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpc = admin as any;

  const [dataRes, countRes] = await Promise.all([
    rpc.rpc('get_ai_token_usage', {
      p_tenant_id: auth.tenantId,
      p_user_id: auth.userId,
      p_limit: limit,
      p_offset: offset,
    }),
    rpc.rpc('get_ai_token_usage_total', {
      p_tenant_id: auth.tenantId,
      p_user_id: auth.userId,
    }),
  ]);

  if (dataRes.error) {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  return NextResponse.json({
    rows: (dataRes.data ?? []) as UsageHistoryRow[],
    total: Number(countRes.data ?? 0),
  });
}
