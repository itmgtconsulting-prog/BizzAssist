/**
 * GET /api/bfe-lookup?dawaId=UUID
 *
 * BIZZ-1894: Slår BFE-nummer op fra bfe_adresse_cache via DAWA adresse-UUID.
 * Bruges som fallback når BBR returnerer 404 og ejerlejlighedBfe er null.
 *
 * @returns { bfe: number | null }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dawaId = req.nextUrl.searchParams.get('dawaId');
  if (!dawaId) return NextResponse.json({ bfe: null });

  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('bfe_nummer')
      .eq('dawa_id', dawaId)
      .maybeSingle();

    return NextResponse.json({ bfe: data?.bfe_nummer ?? null });
  } catch {
    return NextResponse.json({ bfe: null });
  }
}
