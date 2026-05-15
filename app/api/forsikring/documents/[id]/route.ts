/**
 * DELETE /api/forsikring/documents/[id] — Slet ét forsikringsdokument.
 *
 * BIZZ-1397: Sletter dokumentrækken + storage-fil. Hvis dokumentet
 * har en tilknyttet police, slettes policen IKKE — kun linket fjernes.
 *
 * @module api/forsikring/documents/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getInsuranceApi } from '@/lib/db/insurance';
import { getTenantContext } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

/** Storage bucket name */
const BUCKET = 'forsikring-documents';

/**
 * DELETE /api/forsikring/documents/[id]
 *
 * @param request - Next.js request
 * @param context - Route params med document ID
 * @returns { ok: true }
 */
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
    const doc = await insurance.documents.get(id);
    if (!doc) {
      return NextResponse.json({ error: 'Dokument ikke fundet' }, { status: 404 });
    }

    // Slet storage-fil (best-effort)
    if (doc.storage_path) {
      const admin = createAdminClient();
      const { error: storageErr } = await admin.storage.from(BUCKET).remove([doc.storage_path]);
      if (storageErr) {
        logger.warn(`[forsikring/documents DELETE] Storage: ${storageErr.message}`);
      }
    }

    // Slet dokument-rækken
    await insurance.documents.delete(id);

    // Audit log
    const ctx = await getTenantContext(auth.tenantId);
    await ctx.auditLog.write({
      action: 'forsikring.document.deleted',
      resource_type: 'forsikring_document',
      resource_id: id,
      metadata: { original_name: doc.original_name },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[forsikring/documents DELETE]', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
