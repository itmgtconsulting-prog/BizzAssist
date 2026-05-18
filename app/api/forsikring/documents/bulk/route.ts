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
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName, tenantDb } from '@/lib/db/tenant';
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
    const admin = createAdminClient();
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = tenantDb(admin as any, schemaName);

    // Hent alle dokumenter for denne kunde
    const { data: docs, error: listErr } = await db
      .from('forsikring_documents')
      .select('id, storage_path')
      .eq('tenant_id', auth.tenantId)
      .eq('kunde_id', kundeId);

    if (listErr) {
      logger.error('[forsikring/documents/bulk] list error:', listErr.message);
      return NextResponse.json({ error: 'Kunne ikke hente dokumenter' }, { status: 500 });
    }

    if (!docs || docs.length === 0) {
      return NextResponse.json({ deleted: 0 });
    }

    // Slet filer fra Storage
    const storagePaths = (docs as Array<{ storage_path: string }>)
      .map((d) => d.storage_path)
      .filter(Boolean);
    if (storagePaths.length > 0) {
      const { error: storageErr } = await admin.storage
        .from('forsikring-documents')
        .remove(storagePaths);
      if (storageErr) {
        logger.warn('[forsikring/documents/bulk] storage delete fejl:', storageErr.message);
        // Fortsæt med DB-sletning selvom storage fejler
      }
    }

    // Slet rækker fra DB
    const docIds = (docs as Array<{ id: string }>).map((d) => d.id);
    const { error: deleteErr } = await db
      .from('forsikring_documents')
      .delete()
      .eq('tenant_id', auth.tenantId)
      .eq('kunde_id', kundeId);

    if (deleteErr) {
      logger.error('[forsikring/documents/bulk] delete error:', deleteErr.message);
      return NextResponse.json({ error: 'Kunne ikke slette dokumenter' }, { status: 500 });
    }

    logger.log(`[forsikring/documents/bulk] Slettet ${docIds.length} docs for kunde ${kundeId}`);

    return NextResponse.json({ deleted: docIds.length });
  } catch (err) {
    logger.error('[forsikring/documents/bulk]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
