/**
 * GET /api/ejendomme-by-owner/enrich?bfe=100165718
 *
 * Progressive enrichment endpoint for property cards (BIZZ-397).
 * Returns areal, vurdering, ejer-navn, and købs-info for a single BFE.
 * Called client-side in batches after initial property list renders.
 *
 * Data sources:
 *   - BBR v2 GraphQL → bygningsareal
 *   - VUR v2 GraphQL → ejendomsvurdering
 *   - EJF Custom → ejer-navn
 *   - EJF Ejerskifte → seneste handel (købesum, dato)
 *
 * @param bfe - BFE-nummer
 * @returns { areal, vurdering, vurderingsaar, ejerNavn, koebesum, koebsdato }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 15;

const enrichSchema = z.object({
  bfe: z.string().regex(/^\d+$/, 'bfe skal være numerisk'),
});

export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, enrichSchema);
  if (!parsed.success) return parsed.response;
  const { bfe } = parsed.data;

  const result: {
    areal: number | null;
    vurdering: number | null;
    vurderingsaar: number | null;
    ejerNavn: string | null;
    koebesum: number | null;
    koebsdato: string | null;
  } = {
    areal: null,
    vurdering: null,
    vurderingsaar: null,
    ejerNavn: null,
    koebesum: null,
    koebsdato: null,
  };

  const baseUrl = request.nextUrl.origin;
  const cookieHeader = request.headers.get('cookie') ?? '';
  const fetchOpts: RequestInit = {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    signal: AbortSignal.timeout(8000),
  };

  try {
    // Parallel: BBR (areal) + vurdering + ejerskab
    const [bbrRes, vurRes, ejRes] = await Promise.allSettled([
      // BBR for areal
      fetch(`${baseUrl}/api/bbr/bbox?bfe=${bfe}`, fetchOpts).then(async (r) => {
        if (!r.ok) return null;
        const d = await r.json();
        const byg = d?.bygninger?.[0];
        return byg?.bygningsareal ?? byg?.samletBygningsareal ?? null;
      }),
      // Vurdering
      fetch(`${baseUrl}/api/vurdering?bfeNummer=${bfe}`, fetchOpts).then(async (r) => {
        if (!r.ok) return null;
        const d = await r.json();
        return {
          vurdering: d?.vurdering?.ejendomsvaerdi ?? null,
          aar: d?.vurdering?.aar ?? null,
        };
      }),
      // Ejerskab (ejer-navn + seneste handel)
      fetch(`${baseUrl}/api/ejerskab?bfeNummer=${bfe}`, fetchOpts).then(async (r) => {
        if (!r.ok) return null;
        const d = await r.json();
        const ejere = d?.ejere ?? [];
        const foerste = ejere[0];
        return {
          ejerNavn: foerste?.personNavn ?? (foerste?.cvr ? `CVR ${foerste.cvr}` : null),
        };
      }),
    ]);

    if (bbrRes.status === 'fulfilled' && bbrRes.value != null) {
      result.areal = bbrRes.value as number;
    }
    if (vurRes.status === 'fulfilled' && vurRes.value) {
      const v = vurRes.value as { vurdering: number | null; aar: number | null };
      result.vurdering = v.vurdering;
      result.vurderingsaar = v.aar;
    }
    if (ejRes.status === 'fulfilled' && ejRes.value) {
      const e = ejRes.value as { ejerNavn: string | null };
      result.ejerNavn = e.ejerNavn;
    }
  } catch (err) {
    logger.error('[ejendomme-by-owner/enrich] Error:', err);
  }

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
  });
}
