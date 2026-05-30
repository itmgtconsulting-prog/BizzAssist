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
  const adresse = req.nextUrl.searchParams.get('adresse');
  const etage = req.nextUrl.searchParams.get('etage');
  const doer = req.nextUrl.searchParams.get('doer');
  const postnr = req.nextUrl.searchParams.get('postnr');

  if (!dawaId && !adresse) return NextResponse.json({ bfe: null });

  try {
    const admin = createAdminClient();

    // Forsøg 1: dawa_id match (cache kan have adresse-ID eller adgangsadresse-ID)
    if (dawaId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from('bfe_adresse_cache')
        .select('bfe_nummer')
        .eq('dawa_id', dawaId)
        .maybeSingle();
      if (data?.bfe_nummer) return NextResponse.json({ bfe: data.bfe_nummer });
    }

    // Forsøg 2: adresse + etage + dør match (når DAWA-ID'er ikke matcher)
    if (adresse && postnr) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = (admin as any)
        .from('bfe_adresse_cache')
        .select('bfe_nummer')
        .ilike('adresse', `${adresse}%`)
        .eq('postnr', postnr);
      if (etage) query = query.eq('etage', etage);
      if (doer) query = query.eq('doer', doer);
      const { data } = await query.maybeSingle();
      if (data?.bfe_nummer) return NextResponse.json({ bfe: data.bfe_nummer });
    }

    return NextResponse.json({ bfe: null });
  } catch {
    return NextResponse.json({ bfe: null });
  }
}
