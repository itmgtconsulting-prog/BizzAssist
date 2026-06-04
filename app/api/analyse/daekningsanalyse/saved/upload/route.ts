/**
 * Upload analysis source file — POST /api/analyse/daekningsanalyse/saved/upload
 *
 * BIZZ-2003: Stores the uploaded Excel/CSV in Supabase storage bucket
 * 'daekningsanalyse-files'. Returns the storage path for linking to a
 * saved analysis.
 *
 * Max file size: 10MB. Accepted types: .xlsx, .csv.
 *
 * @module app/api/analyse/daekningsanalyse/saved/upload/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireModuleAccess } from '@/app/lib/serverModuleAccess';
import { logger } from '@/app/lib/logger';

const BUCKET = 'daekningsanalyse-files';
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * POST /api/analyse/daekningsanalyse/saved/upload
 *
 * @param req - Multipart form data with 'file' field
 * @returns JSON with { filePath, fileName }
 */
export async function POST(req: NextRequest): Promise<NextResponse | Response> {
  const blocked = await requireModuleAccess('daekningsanalyse');
  if (blocked) return blocked;

  const tenant = await resolveTenantId();
  if (!tenant?.tenantId || !tenant.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 });
    }

    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['xlsx', 'csv', 'xls'].includes(ext)) {
      return NextResponse.json({ error: 'Invalid file type' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${tenant.userId}/${randomUUID()}-${safeName}`;

    const admin = createAdminClient();
    const { error: uploadErr } = await admin.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });

    if (uploadErr) {
      logger.error('[daekningsanalyse/upload] Storage error:', uploadErr.message);
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }

    return NextResponse.json({ filePath: storagePath, fileName: file.name });
  } catch (err) {
    logger.error('[daekningsanalyse/upload] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
