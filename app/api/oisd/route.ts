/**
 * GET /api/oisd?bfe=<bfe>
 *
 * Henter historiske handelspriser fra Datafordeler OISD (Ejendomsvurdering).
 * Returnerer alle registrerede ejerskifter med købesum, dato og handelstype.
 *
 * Dette er den autoritative kilde for danske ejendomshandelspriser —
 * indeholder data som hverken Tinglysning REST eller EJF har.
 *
 * @param bfe - BFE-nummer
 * @returns Liste af handler med dato, købesum, handelstype
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

const OISD_BASE = 'https://services.datafordeler.dk/EJF/EJFCurrentPublic/1/rest';

export interface OisdHandel {
  dato: string | null;
  koebesum: number | null;
  handelsType: string | null;
  andel: string | null;
}

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

  try {
    // EJF Public REST — /HandelOffentlig endpoint med BFE-filter
    // Denne returnerer registrerede handler med købesum
    const url = `${OISD_BASE}/HandelOffentlig?BFENummer=${bfe}&pagesize=50`;
    logger.log(`[oisd] Fetching: ${url}`);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      // Prøv alternativt endpoint
      const altUrl = `https://services.datafordeler.dk/EJF/EJFCurrentPublic/1/rest/EjerlejlighedHandel?BFENummer=${bfe}&pagesize=50`;
      const altRes = await fetch(altUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!altRes.ok) {
        logger.warn(`[oisd] Both endpoints failed: ${res.status} / ${altRes.status}`);
        return NextResponse.json(
          { bfe: parseInt(bfe, 10), handler: [], error: `HTTP ${res.status}` },
          { headers: { 'Cache-Control': 'public, s-maxage=3600' } }
        );
      }

      const altData = await altRes.json();
      return NextResponse.json(
        { bfe: parseInt(bfe, 10), handler: parseHandelResponse(altData), raw: altData },
        { headers: { 'Cache-Control': 'public, s-maxage=86400' } }
      );
    }

    const data = await res.json();

    return NextResponse.json(
      { bfe: parseInt(bfe, 10), handler: parseHandelResponse(data), raw: data },
      { headers: { 'Cache-Control': 'public, s-maxage=86400' } }
    );
  } catch (err) {
    logger.error('[oisd] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

/** Parser handler fra Datafordeler JSON-response. */
function parseHandelResponse(data: unknown): OisdHandel[] {
  const handler: OisdHandel[] = [];

  // Datafordeler returnerer array eller objekt med samling
  const items = Array.isArray(data)
    ? data
    : (data as Record<string, unknown>)?.features
      ? ((data as Record<string, unknown>).features as unknown[])
      : [];

  for (const item of items) {
    const props = (item as Record<string, unknown>)?.properties ?? item;
    const p = props as Record<string, unknown>;

    handler.push({
      dato: (p.overtagelsesdato ?? p.OvertagelsesDato ?? p.Overtagelsesdato ?? p.dato) as
        | string
        | null,
      koebesum: parseKoebesum(
        p.kontantKoebesum ?? p.KontantKoebesum ?? p.iAltKoebesum ?? p.IAltKoebesum ?? p.koebesum
      ),
      handelsType: (p.overdragelsesmaade ??
        p.Overdragelsesmaade ??
        p.handelstype ??
        p.HandelsType) as string | null,
      andel: (p.andelProcent ?? p.AndelProcent ?? p.andel) as string | null,
    });
  }

  return handler.sort((a, b) => (b.dato ?? '').localeCompare(a.dato ?? ''));
}

/** Parser købesum fra diverse formater. */
function parseKoebesum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}
