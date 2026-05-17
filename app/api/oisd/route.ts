/**
 * GET /api/oisd?bfe=<bfe>
 *
 * Henter historiske handelspriser fra Datafordeler EJF REST API.
 * Prøver flere views: HandelsoplysningsView, EjerskifteView, EjerskabsskifteView.
 *
 * @param bfe - BFE-nummer
 * @returns Handler med dato, købesum, handelstype
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

const EJF_BASE = 'https://services.datafordeler.dk/EJF/EJFCurrentPublic/1/rest';

/** Views der kan indeholde handelsdata — prøves i rækkefølge. */
const VIEWS = [
  'HandelsoplysningsView',
  'EjerskifteView',
  'EjerskabsskifteView',
  'HistEjendomsejerView',
];

export async function GET(req: NextRequest) {
  const limited = await checkRateLimit(req, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bfe = req.nextUrl.searchParams.get('bfe');
  if (!bfe || !/^\d+$/.test(bfe)) {
    return NextResponse.json({ error: 'bfe parameter er påkrævet' }, { status: 400 });
  }

  const token = await getSharedOAuthToken();
  if (!token) {
    return NextResponse.json({ error: 'Datafordeler token fejl' }, { status: 503 });
  }

  const results: Record<string, { status: number; data: unknown }> = {};

  // Prøv alle views parallelt
  await Promise.all(
    VIEWS.map(async (view) => {
      const url = `${EJF_BASE}/${view}?BFENummer=${bfe}&pagesize=50`;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        const body = res.ok ? await res.json() : null;
        results[view] = { status: res.status, data: body };
        logger.log(`[oisd] ${view}: HTTP ${res.status}`);
      } catch (err) {
        results[view] = { status: 0, data: String(err) };
      }
    })
  );

  return NextResponse.json(
    { bfe: parseInt(bfe, 10), views: results },
    { headers: { 'Cache-Control': 'public, s-maxage=86400' } }
  );
}
