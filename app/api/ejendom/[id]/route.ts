/**
 * GET /api/ejendom/[id]
 *
 * Server-side aggregation endpoint for property data.
 * Fetches and merges data from multiple sources:
 *  1. Datafordeler BBR v2 GraphQL — building data (opførelsesår, areal, materialer)
 *  2. Datafordeler BBR v2 GraphQL — units (enheder) for the property
 *
 * Authentication: API Key via ?apiKey= query param (frie data).
 * All Datafordeler calls are made server-side so credentials stay hidden.
 * BBR calls degrade gracefully to null on auth error.
 *
 * Core logic lives in app/lib/fetchBbrData.ts so server components can call
 * it directly without an HTTP round-trip (required on Vercel ISR).
 *
 * @param params.id - DAWA adgangsadresse UUID (also used as husnummer in BBR)
 * @returns JSON with { dawaId, bbr, enheder, bbrFejl }
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';

// Re-export all types so existing importers (dashboard page etc.) keep working
export type {
  RawBBRBygning,
  LiveBBRBygning,
  LiveBBREnhed,
  BBRBygningPunkt,
  BBREjendomsrelation,
  EjendomApiResponse,
} from '@/app/lib/fetchBbrData';
export { normaliseBygning, normaliseEnhed, UUID_RE } from '@/app/lib/fetchBbrData';

// ─── Route handler ─────────────────────────────────────────────────────────

/**
 * GET /api/ejendom/[id]
 * Aggregates property BBR data for the given DAWA adgangsadresse UUID.
 *
 * @param _req - Next.js request (unused)
 * @param context - Route context with the DAWA id
 * @returns { dawaId, bbr, enheder, bbrFejl }
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;

  // UUID validation
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(id)) {
    return NextResponse.json(
      {
        dawaId: id,
        bbr: null,
        enheder: null,
        bygningPunkter: null,
        ejendomsrelationer: null,
        ejerlejlighedBfe: null,
        moderBfe: null,
        bbrFejl: 'Ugyldigt adresse-id',
      },
      { status: 400 }
    );
  }

  const result = await fetchBbrForAddress(id);

  return NextResponse.json(
    { dawaId: id, ...result },
    {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    }
  );
}
