/**
 * GET /api/ejerskab/tvangsauktion?bfe=12345
 *
 * BIZZ-1734: Tjek om en ejendom er solgt på tvangsauktion.
 * Returnerer seneste tvangsauktion-ejerskifte hvis det findes.
 *
 * @param request - GET med ?bfe=XXXXX
 * @returns { tvangsauktion: { dato: string } | null }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bfe = request.nextUrl.searchParams.get('bfe');
  if (!bfe || !/^\d+$/.test(bfe)) {
    return NextResponse.json({ error: 'Ugyldigt bfe' }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from('ejf_ejerskifte')
      .select('overtagelsesdato')
      .eq('bfe_nummer', parseInt(bfe, 10))
      .eq('overdragelsesmaade', 'Tvangsauktion')
      .eq('status', 'gældende')
      .order('overtagelsesdato', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      return NextResponse.json({
        tvangsauktion: { dato: (data as Record<string, unknown>).overtagelsesdato as string },
      });
    }

    return NextResponse.json({ tvangsauktion: null });
  } catch {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
