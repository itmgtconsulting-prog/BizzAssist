/**
 * DELETE /api/forsikring/documents/bulk?kunde_id=xxx
 *
 * BIZZ-1632: Slet alle forsikringsdokumenter for en specifik kunde.
 * Fjerner filer fra Supabase Storage + rækker fra forsikring_documents.
 *
 * @module api/forsikring/documents/bulk
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getInsuranceApi } from '@/lib/db/insurance';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/**
 * DELETE /api/forsikring/documents/bulk?kunde_id=xxx
 *
 * @returns { deleted: number }
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kundeId = request.nextUrl.searchParams.get('kunde_id');
  if (!kundeId) {
    return NextResponse.json({ error: 'Missing kunde_id' }, { status: 400 });
  }

  try {
    const insurance = await getInsuranceApi(auth.tenantId);

    // Hent alle dokumenter for denne kunde
    const allDocs = await insurance.documents.list();
    const kundeDocs = allDocs.filter((d) => d.kunde_id === kundeId);

    if (kundeDocs.length === 0) {
      return NextResponse.json({ deleted: 0 });
    }

    // Slet filer fra Storage
    const admin = createAdminClient();
    const storagePaths = kundeDocs.map((d) => d.storage_path).filter(Boolean);
    if (storagePaths.length > 0) {
      const { error: storageErr } = await admin.storage
        .from('forsikring-documents')
        .remove(storagePaths);
      if (storageErr) {
        logger.warn('[forsikring/documents/bulk] storage delete fejl:', storageErr.message);
      }
    }

    // Slet rækker fra DB (én ad gangen via insurance API)
    let deleted = 0;
    for (const doc of kundeDocs) {
      try {
        await insurance.documents.delete(doc.id);
        deleted++;
      } catch {
        logger.warn(`[forsikring/documents/bulk] Kunne ikke slette doc ${doc.id}`);
      }
    }

    logger.log(
      `[forsikring/documents/bulk] Slettet ${deleted}/${kundeDocs.length} docs for kunde ${kundeId}`
    );
    return NextResponse.json({ deleted });
  } catch (err) {
    logger.error('[forsikring/documents/bulk]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
