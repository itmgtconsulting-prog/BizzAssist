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
import { z } from 'zod';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** Zod schema for the [id] dynamic param — UUID format */
const idParamSchema = z.object({
  id: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'Ugyldigt adresse-id'
    ),
});

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
  // BIZZ-598: Wrap fetchBbrForAddress (Datafordeler GraphQL) i try/catch
  // så uventet netværks-/parse-fejl ikke kaskader til klient.
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const rawParams = await context.params;
    const paramResult = idParamSchema.safeParse(rawParams);
    if (!paramResult.success) {
      return NextResponse.json(
        {
          dawaId: rawParams.id,
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
    const { id } = paramResult.data;

    const result = await fetchBbrForAddress(id);

    return NextResponse.json(
      { dawaId: id, ...result },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
          'X-Cache-Hit': 'false',
        },
      }
    );
  } catch (err) {
    logger.error('[ejendom/[id]] uventet fejl:', err);
    return NextResponse.json(
      {
        dawaId: null,
        bbr: null,
        enheder: null,
        bygningPunkter: null,
        ejendomsrelationer: null,
        ejerlejlighedBfe: null,
        moderBfe: null,
        bbrFejl: 'Ekstern API fejl',
      },
      { status: 500 }
    );
  }
}
