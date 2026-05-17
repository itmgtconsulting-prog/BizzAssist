/**
 * DELETE /api/forsikring/reset — Slet ALLE forsikringsdata for tenant.
 *
 * BIZZ-1397: Nulstil forsikringsmodulet — sletter alle policer, dækninger,
 * gaps, dokumenter (inkl. storage-filer), analyser og aktiver.
 * Sager beholdes som historik men markeres 'afsluttet'.
 *
 * @module api/forsikring/reset
 */

import { NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName, getTenantContext } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/** Storage bucket name */
const BUCKET = 'forsikring-documents';

/**
 * DELETE /api/forsikring/reset
 *
 * Sletter alt forsikringsdata for tenant:
 *   1. forsikring_gaps
 *   2. forsikring_coverages
 *   3. forsikring_aktiver
 *   4. forsikring_analyser
 *   5. forsikring_documents (+ storage)
 *   6. forsikring_policies
 *
 * @returns { deleted: true, stats }
 */
export async function DELETE(): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);
    const tid = auth.tenantId;

    // 1. Slet gaps
    const { count: gapCount } = await db
      .from('forsikring_gaps')
      .delete({ count: 'exact' })
      .eq('tenant_id', tid);

    // 2. Slet coverages
    const { count: covCount } = await db
      .from('forsikring_coverages')
      .delete({ count: 'exact' })
      .eq('tenant_id', tid);

    // 3. Slet aktiver
    const { count: aktivCount } = await db
      .from('forsikring_aktiver')
      .delete({ count: 'exact' })
      .eq('tenant_id', tid);

    // 4. Slet analyser
    const { count: analyseCount } = await db
      .from('forsikring_analyser')
      .delete({ count: 'exact' })
      .eq('tenant_id', tid);

    // 5. Hent storage paths + slet dokumenter
    const { data: docs } = await db
      .from('forsikring_documents')
      .select('storage_path')
      .eq('tenant_id', tid);

    const storagePaths = (docs ?? [])
      .map((d: { storage_path: string }) => d.storage_path)
      .filter(Boolean);

    if (storagePaths.length > 0) {
      const { error: storageErr } = await admin.storage.from(BUCKET).remove(storagePaths);
      if (storageErr) {
        logger.warn('[forsikring/reset] Storage sletning fejlede:', storageErr.message);
      }
    }

    const { count: docCount } = await db
      .from('forsikring_documents')
      .delete({ count: 'exact' })
      .eq('tenant_id', tid);

    // 6. Slet policer
    const { count: policyCount } = await db
      .from('forsikring_policies')
      .delete({ count: 'exact' })
      .eq('tenant_id', tid);

    // 7. Slet sager
    const { count: sagCount } = await db
      .from('forsikring_sager')
      .delete({ count: 'exact' })
      .eq('tenant_id', tid);

    const stats = {
      policies: policyCount ?? 0,
      documents: docCount ?? 0,
      coverages: covCount ?? 0,
      gaps: gapCount ?? 0,
      analyses: analyseCount ?? 0,
      assets: aktivCount ?? 0,
      cases: sagCount ?? 0,
    };

    logger.log(`[forsikring/reset] Nulstillet for tenant ${tid}:`, JSON.stringify(stats));

    // Audit log
    const ctx = await getTenantContext(tid);
    await ctx.auditLog.write({
      action: 'forsikring.reset',
      resource_type: 'forsikring',
      resource_id: tid,
      metadata: stats,
    });

    return NextResponse.json({ deleted: true, stats });
  } catch (err) {
    logger.error('[forsikring/reset]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
