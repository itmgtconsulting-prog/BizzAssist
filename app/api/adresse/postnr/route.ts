/**
 * GET /api/adresse/postnr?nr=2650 — postnummer → by-navn via DAR/v2 GraphQL.
 *
 * Erstatter et client-side DAWA-kald (api.dataforsyningen.dk/postnumre/{nr},
 * nu HTTP 410 Gone) brugt af dækningsanalysens datavask-berigelse. Lagt
 * server-side så apiKey/proxy håndteres korrekt og klienten rammer samme-origin.
 *
 * Retention: ingen persistens — offentligt postnummer-opslag, ingen PII.
 *
 * @param nr - 4-cifret postnummer (query-param)
 * @returns `{ by: string }` (tom streng hvis ukendt/fejl — by-navn er valgfrit)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { parseQuery } from '@/app/lib/validate';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { DAR_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { logger } from '@/app/lib/logger';

/** Zod schema — 4-cifret postnummer */
const postnrSchema = z.object({ nr: z.string().regex(/^\d{4}$/) });

/**
 * GET handler — slår by-navn op for et postnummer via DAR_Postnummer.
 *
 * @param request - NextRequest med ?nr=NNNN
 * @returns `{ by: string }`
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, postnrSchema);
  if (!parsed.success) return NextResponse.json({ by: '' }, { status: 400 });
  const { nr } = parsed.data;

  const apiKey = process.env.DATAFORDELER_API_KEY;
  if (!apiKey) return NextResponse.json({ by: '' });

  try {
    const ts = new Date().toISOString();
    const query = `{ DAR_Postnummer(first: 1 virkningstid: "${ts}" registreringstid: "${ts}" where: { postnr: { eq: "${nr}" } }) { nodes { navn } } }`;
    const res = await fetch(proxyUrl(`${DAR_ENDPOINT}?apiKey=${encodeURIComponent(apiKey)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    if (!res.ok) return NextResponse.json({ by: '' });
    const json = (await res.json()) as {
      data?: { DAR_Postnummer?: { nodes?: Array<{ navn?: string }> } };
    };
    const by = json.data?.DAR_Postnummer?.nodes?.[0]?.navn ?? '';
    return NextResponse.json({ by }, { headers: { 'Cache-Control': 'public, s-maxage=86400' } });
  } catch (err) {
    logger.warn('[adresse/postnr] fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ by: '' });
  }
}
