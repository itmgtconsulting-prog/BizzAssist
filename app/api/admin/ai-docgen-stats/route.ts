/**
 * GET /api/admin/ai-docgen-stats
 *
 * BIZZ-817 (AI DocGen 8/8): admin-only metrics-endpoint til AI DocGen
 * pipeline. Aggregerer public.ai_file rows (BIZZ-810) per format pr.
 * dag de seneste 30 dage. Giver observability for produktions-fejl-
 * diagnose og cost-tracking.
 *
 * Response-shape:
 *   {
 *     days: 30,
 *     byFormat: { xlsx: {count, avgBytes}, docx: {...}, csv: {...} },
 *     daily: [{date: '2026-04-24', xlsx: 12, docx: 3, csv: 7, totalBytes: ...}]
 *   }
 *
 * Security: admin-only via app_metadata.isAdmin check. Ikke cached —
 * freshness > performance for et rarely-used admin view.
 *
 * @module api/admin/ai-docgen-stats
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/**
 * Gate: auth user must have app_metadata.isAdmin = true.
 * Returns user object or null (caller emits 403).
 */
async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return user;
  return null;
}

interface AiFileRow {
  kind: string;
  file_type: string;
  size_bytes: number | null;
  created_at: string;
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const adminClient = createAdminClient();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (adminClient as any)
    .from('ai_file')
    .select('kind, file_type, size_bytes, created_at')
    .eq('kind', 'generated')
    .gte('created_at', cutoff);

  if (error) {
    logger.error('[ai-docgen-stats] fetch fejl:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  const rows = (data ?? []) as AiFileRow[];

  // Per-format aggregation (total)
  const byFormat: Record<string, { count: number; totalBytes: number; avgBytes: number }> = {};
  // Per-day aggregation
  const dailyMap = new Map<string, Record<string, number>>();

  for (const row of rows) {
    const fmt = row.file_type || 'unknown';
    const bytes = row.size_bytes ?? 0;
    const day = row.created_at.slice(0, 10); // YYYY-MM-DD

    const fmtAgg = byFormat[fmt] || { count: 0, totalBytes: 0, avgBytes: 0 };
    fmtAgg.count += 1;
    fmtAgg.totalBytes += bytes;
    byFormat[fmt] = fmtAgg;

    const dayEntry = dailyMap.get(day) || {};
    dayEntry[fmt] = (dayEntry[fmt] ?? 0) + 1;
    dayEntry.totalBytes = (dayEntry.totalBytes ?? 0) + bytes;
    dailyMap.set(day, dayEntry);
  }

  // Finalize avgBytes
  for (const k of Object.keys(byFormat)) {
    const agg = byFormat[k];
    agg.avgBytes = agg.count > 0 ? Math.round(agg.totalBytes / agg.count) : 0;
  }

  // Sort daily by date ascending
  const daily = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  return NextResponse.json({
    days: 30,
    totalGenerations: rows.length,
    byFormat,
    daily,
  });
}
