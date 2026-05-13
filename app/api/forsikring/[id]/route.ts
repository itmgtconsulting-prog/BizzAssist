/**
 * GET /api/forsikring/[id]
 * DELETE /api/forsikring/[id]
 *
 * Hent fuld police inkl. dækninger og gap-detektioner. Bruges af
 * /dashboard/forsikring/[id] detail-side.
 *
 * @module api/forsikring/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';
import { getInsuranceApi } from '@/lib/db/insurance';
import { getTenantContext } from '@/lib/db/tenant';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Ugyldigt id' }, { status: 400 });
  }

  try {
    const insurance = await getInsuranceApi(auth.tenantId);
    const policy = await insurance.policies.get(id);
    if (!policy) {
      return NextResponse.json({ error: 'Police ikke fundet' }, { status: 404 });
    }
    const [coverages, gaps] = await Promise.all([
      insurance.coverages.listForPolicy(policy.id),
      insurance.gaps.listForPolicy(policy.id),
    ]);
    return NextResponse.json({ policy, coverages, gaps });
  } catch (err) {
    logger.error('[forsikring/[id] GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Ugyldigt id' }, { status: 400 });
  }

  try {
    const insurance = await getInsuranceApi(auth.tenantId);
    const policy = await insurance.policies.get(id);
    if (!policy) {
      return NextResponse.json({ error: 'Police ikke fundet' }, { status: 404 });
    }
    await insurance.policies.delete(id);

    const ctx = await getTenantContext(auth.tenantId);
    await ctx.auditLog.write({
      action: 'forsikring.policy.deleted',
      resource_type: 'forsikring_policy',
      resource_id: id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[forsikring/[id] DELETE]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
