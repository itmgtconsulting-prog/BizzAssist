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
import { createAdminClient } from '@/lib/supabase/admin';
import { logActivity } from '@/app/lib/activityLog';
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

    // BIZZ-1627: Cache-first fra bbr_ejendom_status (46k ejendomme, <50ms).
    // Hvis cached og <7 dage gammel, returner direkte. Fetch live i baggrunden.
    const admin = createAdminClient();
    const BBR_STALE_MS = 7 * 24 * 60 * 60 * 1000;
    let cachedResult: Awaited<ReturnType<typeof fetchBbrForAddress>> | null = null;
    let cacheHit = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: row } = await (admin as any)
        .from('bbr_ejendom_status')
        .select(
          'bfe_nummer, kommune_kode, samlet_boligareal, samlet_erhvervsareal, grundareal, bebygget_areal, opfoerelsesaar, ombygningsaar, byg021_anvendelse, energimaerke, energimaerke_dato, antal_etager, antal_boligenheder, tagmateriale, ydervaeg_materiale, varmeinstallation, opvarmningsform, supplerende_varme, vandforsyning, afloebsforhold, fredning, bevaringsvaerdighed, ejerforholdskode, berigelse_sidst'
        )
        .eq('adgangsadresse_id', id)
        .maybeSingle();
      if (row?.bfe_nummer && row.berigelse_sidst) {
        const age = Date.now() - new Date(row.berigelse_sidst).getTime();
        if (age < BBR_STALE_MS) {
          cacheHit = true;
          // Byg minimal EjendomApiResponse fra cache-data
          cachedResult = {
            bbr: [
              {
                id: `cache-${row.bfe_nummer}`,
                anvendelse: row.byg021_anvendelse != null ? String(row.byg021_anvendelse) : '',
                anvendelseskode: row.byg021_anvendelse,
                opfoerelsesaar: row.opfoerelsesaar,
                ombygningsaar: row.ombygningsaar,
                samletBoligareal: row.samlet_boligareal,
                samletBygningsareal: null,
                samletErhvervsareal: row.samlet_erhvervsareal,
                grundareal: row.grundareal,
                bebyggetAreal: row.bebygget_areal,
                antalEtager: row.antal_etager,
                antalBoligenheder: row.antal_boligenheder,
                antalErhvervsenheder: null,
                kaelder: null,
                tagetage: null,
                tagkonstruktion: '',
                tagmateriale: row.tagmateriale ?? '',
                ydervaeg: row.ydervaeg_materiale ?? '',
                varmeinstallation: row.varmeinstallation ?? '',
                opvarmningsform: row.opvarmningsform ?? '',
                vandforsyning: row.vandforsyning ?? '',
                afloeb: row.afloebsforhold ?? '',
                energimaerke: row.energimaerke,
                fredning: row.fredning,
                supplerendeVarme: row.supplerende_varme,
                bevaringsvaerdighed:
                  row.bevaringsvaerdighed != null ? String(row.bevaringsvaerdighed) : null,
                status: null,
                bygningsnr: null,
                koordinater: null,
              },
            ],
            enheder: null,
            bygningPunkter: null,
            ejendomsrelationer: [
              {
                bfeNummer: row.bfe_nummer,
                ejendomsnummer: null,
                ejendomstype: null,
                ejerlavKode: null,
                matrikelnr: null,
              },
            ],
            ejerlejlighedBfe: null,
            moderBfe: null,
            bbrFejl: null,
          } as unknown as Awaited<ReturnType<typeof fetchBbrForAddress>>;
        }
      }
    } catch {
      // Cache-fejl er non-fatal — fortsæt med live fetch
    }

    // Live BBR fetch (skip hvis cache-hit og vi bare sender stale-while-revalidate)
    let result: Awaited<ReturnType<typeof fetchBbrForAddress>>;
    if (cacheHit && cachedResult) {
      result = cachedResult;
    } else {
      result = await fetchBbrForAddress(id);
    }

    // Fire-and-forget: log property_open for usage analytics.
    // DAWA adresse-UUID is not PII — it's a public infrastructure identifier.
    logActivity(admin, auth.tenantId, auth.userId, 'property_open', {
      dawaId: id,
    });

    return NextResponse.json(
      { dawaId: id, ...result },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
          ...(cacheHit
            ? { 'X-Cache-Hit': 'true', 'X-Synced-At': cachedResult ? 'bbr_ejendom_status' : '' }
            : {}),
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
