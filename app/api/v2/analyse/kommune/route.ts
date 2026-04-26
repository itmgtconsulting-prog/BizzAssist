/**
 * GET /api/v2/analyse/kommune?kommunekode=0167
 *
 * BIZZ-920: Kommune-statistik fra materialized view mv_kommune_statistik.
 * Returnerer aggregerede nøgletal per kommune fra cached data.
 *
 * @param kommunekode - 3-4 cifret kommunekode
 * @returns Kommune-statistik med antal adresser
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

const querySchema = z.object({
  kommunekode: z.string().regex(/^\d{3,4}$/),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ugyldige parametre' }, { status: 400 });
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('mv_kommune_statistik')
    .select('*')
    .eq('kommunekode', parsed.data.kommunekode)
    .single();

  if (error) {
    return NextResponse.json(
      { error: 'Data ikke tilgængelig — materialized view er muligvis ikke refreshed endnu.' },
      { status: 404 }
    );
  }

  return NextResponse.json(data, {
    headers: { 'Cache-Control': 'public, s-maxage=3600' },
  });
}
