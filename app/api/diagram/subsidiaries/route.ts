/**
 * GET /api/diagram/subsidiaries?cvr=XXXXXXXX
 *
 * BIZZ-1310: Henter alle datterselskab-CVR'er fra cvr_virksomhed_ejerskab
 * i 2 niveauer (direkte + datterdatter). Bruges som supplement til
 * CVR ES-baseret relaterede virksomheder for ejendomme-fetchen.
 *
 * @param cvr - Hoved-virksomhedens CVR-nummer
 * @returns { cvrs: string[] } — alle datterselskab-CVR'er (unikke, aktive)
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

/**
 * GET handler — hent datterselskab-CVR'er rekursivt fra ejerskabs-cache.
 *
 * @param request - GET med ?cvr=XXXXXXXX
 * @returns { cvrs: string[] }
 */
export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const cvr = request.nextUrl.searchParams.get('cvr');
  if (!cvr) return NextResponse.json({ error: 'Mangler cvr' }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const allCvrs = new Set<string>();

  // Niveau 1: direkte datterselskaber
  const { data: level1 } = await admin
    .from('cvr_virksomhed_ejerskab')
    .select('ejet_cvr')
    .eq('ejer_cvr', cvr)
    .is('gyldig_til', null)
    .limit(50);

  const l1Cvrs = ((level1 ?? []) as Array<{ ejet_cvr: string }>).map((r) => r.ejet_cvr);
  for (const c of l1Cvrs) allCvrs.add(c);

  // Niveau 2: datterdatter-selskaber
  if (l1Cvrs.length > 0) {
    const { data: level2 } = await admin
      .from('cvr_virksomhed_ejerskab')
      .select('ejet_cvr')
      .in('ejer_cvr', l1Cvrs.slice(0, 30))
      .is('gyldig_til', null)
      .limit(100);

    for (const r of (level2 ?? []) as Array<{ ejet_cvr: string }>) {
      allCvrs.add(r.ejet_cvr);
    }
  }

  // Fjern hovedvirksomheden selv
  allCvrs.delete(cvr);

  return NextResponse.json(
    { cvrs: [...allCvrs] },
    { headers: { 'Cache-Control': 'public, s-maxage=3600' } }
  );
}
