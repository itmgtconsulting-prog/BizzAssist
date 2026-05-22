/**
 * GET /api/tokens/ledger?offset=0&limit=50
 *
 * BIZZ-1770: Paginated token-transaktionshistorik for den aktuelle bruger.
 * Admin kan tilføje ?userId=X for at se andre brugeres historik.
 *
 * @module api/tokens/ledger
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50));
  const userId = searchParams.get('userId') ?? auth.userId;

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    const { data, count } = await db
      .from('ai_token_ledger')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    return NextResponse.json({
      transactions: data ?? [],
      total: count ?? 0,
      offset,
      limit,
    });
  } catch {
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
