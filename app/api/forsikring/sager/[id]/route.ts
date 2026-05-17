/**
 * DELETE /api/forsikring/sager/[id] — Slet en kundesag med alt tilknyttet data.
 *
 * BIZZ-1395: Cascade-slet: sag → policer → coverages + gaps + documents + storage.
 * Bruger kan starte forfra med en ny kunde.
 *
 * @module api/forsikring/sager/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/** Storage bucket name */
const BUCKET = 'forsikring-documents';

/**
 * DELETE /api/forsikring/sager/[id]
 *
 * Sletter sagen og ALT tilknyttet data:
 *   1. forsikring_gaps (for alle policer i sagen)
 *   2. forsikring_coverages (for alle policer i sagen)
 *   3. forsikring_documents (+ storage-filer)
 *   4. forsikring_policies
 *   5. forsikring_analyser (matchet via kunde_id)
 *   6. forsikring_aktiver (for analyser)
 *   7. forsikring_sager
 *
 * @param request - Next.js request
 * @param params - Route params med sag-ID
 * @returns { deleted: true }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing sag id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Hent sagen og verificér tenant-ejerskab
    const { data: sag, error: sagErr } = await db
      .from('forsikring_sager')
      .select('id, kunde_type, kunde_id')
      .eq('id', id)
      .eq('tenant_id', auth.tenantId)
      .maybeSingle();

    if (sagErr || !sag) {
      return NextResponse.json({ error: 'Sag ikke fundet' }, { status: 404 });
    }

    // 1. Hent alle policer tilknyttet sagen (via sag_id)
    const { data: policer } = await db
      .from('forsikring_policies')
      .select('id, document_id')
      .eq('tenant_id', auth.tenantId)
      .eq('sag_id', id);

    const policyIds = (policer ?? []).map((p: { id: string }) => p.id);
    const documentIds = [
      ...new Set(
        (policer ?? [])
          .map((p: { document_id: string | null }) => p.document_id)
          .filter(Boolean) as string[]
      ),
    ];

    // 2. Slet gaps for alle policer
    if (policyIds.length > 0) {
      await db
        .from('forsikring_gaps')
        .delete()
        .eq('tenant_id', auth.tenantId)
        .in('policy_id', policyIds);
    }

    // 3. Slet coverages for alle policer
    if (policyIds.length > 0) {
      await db
        .from('forsikring_coverages')
        .delete()
        .eq('tenant_id', auth.tenantId)
        .in('policy_id', policyIds);
    }

    // 4. Slet policer
    if (policyIds.length > 0) {
      await db
        .from('forsikring_policies')
        .delete()
        .eq('tenant_id', auth.tenantId)
        .in('id', policyIds);
    }

    // 5. Slet storage-filer + dokument-rækker
    if (documentIds.length > 0) {
      // Hent storage paths for sletning
      const { data: docs } = await db
        .from('forsikring_documents')
        .select('id, storage_path')
        .in('id', documentIds);

      const storagePaths = (docs ?? [])
        .map((d: { storage_path: string }) => d.storage_path)
        .filter(Boolean);

      // Slet fra storage (best-effort)
      if (storagePaths.length > 0) {
        const { error: storageErr } = await admin.storage.from(BUCKET).remove(storagePaths);
        if (storageErr) {
          logger.warn('[forsikring/sager DELETE] Storage sletning fejlede:', storageErr.message);
        }
      }

      // Slet dokument-rækker
      await db
        .from('forsikring_documents')
        .delete()
        .eq('tenant_id', auth.tenantId)
        .in('id', documentIds);
    }

    // 6. Slet analyser + aktiver for denne kunde
    const { data: analyser } = await db
      .from('forsikring_analyser')
      .select('id')
      .eq('tenant_id', auth.tenantId)
      .eq('kunde_id', sag.kunde_id);

    const analyseIds = (analyser ?? []).map((a: { id: string }) => a.id);
    if (analyseIds.length > 0) {
      await db
        .from('forsikring_aktiver')
        .delete()
        .eq('tenant_id', auth.tenantId)
        .in('analyse_id', analyseIds);

      await db
        .from('forsikring_analyser')
        .delete()
        .eq('tenant_id', auth.tenantId)
        .in('id', analyseIds);
    }

    // 7. Slet selve sagen
    await db.from('forsikring_sager').delete().eq('id', id).eq('tenant_id', auth.tenantId);

    logger.log(
      `[forsikring/sager DELETE] Slettet sag ${id}: ${policyIds.length} policer, ${documentIds.length} dokumenter, ${analyseIds.length} analyser`
    );

    return NextResponse.json({
      deleted: true,
      stats: {
        policies: policyIds.length,
        documents: documentIds.length,
        analyses: analyseIds.length,
      },
    });
  } catch (err) {
    logger.error('[forsikring/sager DELETE] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
