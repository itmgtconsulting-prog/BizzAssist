/**
 * GET /api/admin/sync-status
 *
 * BIZZ-918: Returnerer sync-status for alle datakilder.
 * Bruges af admin dashboard til at vise health-status.
 *
 * @returns Array af data_sync_status rows
 */

import { NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('data_sync_status')
    .select('*')
    .order('source_name');

  if (error) {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // Beregn health per kilde
  const now = Date.now();
  const thresholds: Record<string, number> = {
    bbr: 14 * 24 * 60 * 60 * 1000,
    cvr: 2 * 24 * 60 * 60 * 1000,
    dar: 60 * 24 * 60 * 60 * 1000,
    vur: 60 * 24 * 60 * 60 * 1000,
    ejf: 14 * 24 * 60 * 60 * 1000,
  };

  const enriched = (data ?? []).map(
    (row: { source_name: string; last_sync_at: string | null; last_error: string | null }) => {
      const threshold = thresholds[row.source_name] ?? 14 * 24 * 60 * 60 * 1000;
      const lastSync = row.last_sync_at ? new Date(row.last_sync_at).getTime() : 0;
      const age = now - lastSync;
      const health: 'ok' | 'stale' | 'missing' = !row.last_sync_at
        ? 'missing'
        : age > threshold
          ? 'stale'
          : 'ok';
      return { ...row, health, ageHours: Math.round(age / 3600000) };
    }
  );

  return NextResponse.json(enriched);
}
