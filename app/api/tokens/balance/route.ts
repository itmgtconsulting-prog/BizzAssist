/**
 * GET /api/tokens/balance
 *
 * BIZZ-1770: Token-saldo + opsummering for den aktuelle bruger.
 *
 * @module api/tokens/balance
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = request.nextUrl.searchParams.get('userId') ?? auth.userId;

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Seneste balance fra ledger (running balance)
    const { data: latest } = await db
      .from('ai_token_ledger')
      .select('balance_after')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Aggregeringer denne måned
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { data: monthStats } = await db
      .from('ai_token_ledger')
      .select('txn_type, amount_tokens')
      .eq('user_id', userId)
      .gte('created_at', monthStart.toISOString());

    let monthDebit = 0;
    let monthCredit = 0;
    for (const row of (monthStats ?? []) as Array<{ txn_type: string; amount_tokens: number }>) {
      if (row.txn_type === 'debit') monthDebit += row.amount_tokens;
      else monthCredit += row.amount_tokens;
    }

    return NextResponse.json({
      balance: (latest as { balance_after: number } | null)?.balance_after ?? 0,
      monthDebit,
      monthCredit,
      monthNet: monthCredit - monthDebit,
    });
  } catch {
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
