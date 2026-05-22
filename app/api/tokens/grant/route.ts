/**
 * POST /api/tokens/grant
 *
 * BIZZ-1770: Admin-only — tilskriv tokens til en bruger.
 *
 * Body: { userId: string, amount: number, description: string }
 *
 * @module api/tokens/grant
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { userId: string; amount: number; description?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.userId || !body.amount || body.amount <= 0) {
    return NextResponse.json({ error: 'userId og amount (>0) påkrævet' }, { status: 400 });
  }

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Hent nuværende balance
    const { data: latest } = await db
      .from('ai_token_ledger')
      .select('balance_after')
      .eq('user_id', body.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const currentBalance = (latest as { balance_after: number } | null)?.balance_after ?? 0;

    // Indsæt credit-transaktion
    const { error } = await db.from('ai_token_ledger').insert({
      tenant_id: auth.tenantId,
      user_id: body.userId,
      txn_type: 'credit',
      amount_tokens: body.amount,
      action: 'admin-grant',
      description: body.description ?? `Manuel tilskrivning af ${body.amount} tokens`,
      balance_after: currentBalance + body.amount,
      created_by: auth.userId,
    });

    if (error) {
      logger.error('[tokens/grant] Insert fejl:', error);
      return NextResponse.json({ error: 'Kunne ikke tilskrive tokens' }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      newBalance: currentBalance + body.amount,
    });
  } catch {
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
