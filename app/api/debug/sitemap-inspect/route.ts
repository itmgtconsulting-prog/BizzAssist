/**
 * GET /api/debug/sitemap-inspect?key=<CRON_SECRET>
 *
 * BIZZ-645: Temporary debug endpoint to diagnose why sitemap/0.xml
 * renders as empty <urlset></urlset> on prod despite sitemap_entries
 * having 20K+ rows. Returns raw Supabase query output + env diagnostics.
 *
 * Protected by CRON_SECRET to avoid leaking operational data. Remove
 * once sitemap issue is confirmed fixed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const key = req.nextUrl.searchParams.get('key') ?? '';
  const expected = process.env.CRON_SECRET ?? '';
  if (!expected || !safeCompare(key, expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const diag: Record<string, unknown> = {
    ts: new Date().toISOString(),
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '(missing)',
      has_service_role_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      service_role_key_len: (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').length,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? '(missing)',
      VERCEL_ENV: process.env.VERCEL_ENV ?? '(missing)',
    },
  };

  try {
    const admin = createAdminClient();

    const { count, error: countError } = await admin
      .from('sitemap_entries')
      .select('*', { count: 'exact', head: true });
    diag.count_query = { count, error: countError?.message ?? null };

    const { data, error: selectError } = await admin
      .from('sitemap_entries')
      .select('type, slug, entity_id, updated_at')
      .order('updated_at', { ascending: false })
      .range(0, 4);
    diag.sample_query = {
      error: selectError?.message ?? null,
      rows_returned: data?.length ?? 0,
      first_rows: (data ?? []).map((r) => ({
        type: r.type,
        slug: r.slug?.slice(0, 30),
        entity_id: r.entity_id,
      })),
    };
  } catch (err) {
    diag.exception = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(diag, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
