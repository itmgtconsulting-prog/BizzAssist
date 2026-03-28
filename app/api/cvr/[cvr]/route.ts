/**
 * GET /api/cvr/[cvr]
 *
 * Server-side proxy for cvrapi.dk company lookup.
 * Fetches company data by CVR number — free Danish company registry.
 *
 * Keeps the User-Agent header server-side to avoid rate-limit issues.
 * Caches responses for 1 hour to reduce external API load.
 *
 * @param context.cvr - 8-digit Danish CVR number
 * @returns JSON with company details or { error } on failure
 */

import { NextRequest, NextResponse } from 'next/server';

/** Normalised CVR company data returned to client */
export interface CVRSelskab {
  cvr: string;
  navn: string;
  adresse: string;
  postnr: string;
  by: string;
  telefon: string | null;
  email: string | null;
  branche: string | null;
  branchekode: number | null;
  selskabsform: string | null;
  startdato: string | null;
  slutdato: string | null;
  ansatte: number | null;
  reklamebeskyttet: boolean;
}

/**
 * GET /api/cvr/[cvr]
 * Looks up a Danish company by CVR number via cvrapi.dk.
 *
 * @param _req - Unused
 * @param context - Route context with CVR number
 * @returns Normalised company data or error
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ cvr: string }> }
): Promise<NextResponse> {
  const { cvr } = await context.params;

  // Validate: CVR must be 8 digits
  if (!/^\d{8}$/.test(cvr)) {
    return NextResponse.json({ error: 'Ugyldigt CVR-nummer' }, { status: 400 });
  }

  try {
    const res = await fetch(`https://cvrapi.dk/api?country=dk&vat=${cvr}`, {
      headers: {
        'User-Agent': 'BizzAssist/1.0 (jakob@bizzassist.dk)',
      },
      signal: AbortSignal.timeout(6000),
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      return NextResponse.json({ error: `CVR-opslag fejlede (${res.status})` }, { status: 502 });
    }

    const raw: Record<string, unknown> = await res.json();

    if (raw.error) {
      return NextResponse.json(
        { error: String(raw.message ?? 'CVR ikke fundet') },
        { status: 404 }
      );
    }

    const selskab: CVRSelskab = {
      cvr: String(raw.vat ?? cvr),
      navn: String(raw.name ?? ''),
      adresse: String(raw.address ?? ''),
      postnr: String(raw.zipcode ?? ''),
      by: String(raw.city ?? ''),
      telefon: raw.phone ? String(raw.phone) : null,
      email: raw.email ? String(raw.email) : null,
      branche: raw.industrydesc ? String(raw.industrydesc) : null,
      branchekode: typeof raw.industrycode === 'number' ? raw.industrycode : null,
      selskabsform: raw.companydesc ? String(raw.companydesc) : null,
      startdato: raw.startdate ? String(raw.startdate) : null,
      slutdato: raw.enddate ? String(raw.enddate) : null,
      ansatte: typeof raw.employees === 'number' ? raw.employees : null,
      reklamebeskyttet: Boolean(raw.protected),
    };

    return NextResponse.json(selskab, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
      },
    });
  } catch {
    return NextResponse.json({ error: 'CVR-opslag mislykkedes' }, { status: 502 });
  }
}
