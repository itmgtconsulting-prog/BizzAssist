/**
 * GET /api/heritage?bfe=XXXXXXX
 *
 * BIZZ-951: Fredede og bevaringsværdige bygninger — heritage status.
 *
 * Strategi:
 *   1. Primær: Kulturarvsstyrelsen FBB WFS (teledata.kulturarv.dk)
 *   2. Fallback: BBR-data (fredning + bevaringsværdighed allerede i cache)
 *
 * Returnerer fredningsstatus, SAVE-vurdering, fredningsår og begrundelse.
 *
 * @param bfe - BFE-nummer
 * @returns HeritageResponse
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';

const querySchema = z.object({
  bfe: z.string().regex(/^\d+$/),
});

/** Heritage status for en bygning */
export interface HeritageBuilding {
  /** Bygnings-ID fra BBR */
  bygningId: string | null;
  /** Fredningsstatus: fredet, bevaringsværdig, ingen */
  fredningsstatus: 'fredet' | 'bevaringsværdig' | 'ingen';
  /** SAVE-vurdering (1-9, 1=højest bevaringsværdig) */
  saveVurdering: number | null;
  /** Fredningsår */
  fredningsaar: number | null;
  /** Byggeår */
  byggeaar: number | null;
  /** Bygningsanvendelse */
  anvendelse: string | null;
}

/** API-svar */
export interface HeritageResponse {
  bfe: number;
  bygninger: HeritageBuilding[];
  /** Samlet status for ejendommen */
  samletStatus: 'fredet' | 'bevaringsværdig' | 'ingen';
  kilde: 'bbr' | 'wfs';
  fejl: string | null;
}

/**
 * Forsøg WFS-lookup mod Kulturarvsstyrelsen FBB.
 * Returnerer null ved timeout eller fejl.
 */
async function fetchKulturarv(bfe: number): Promise<HeritageBuilding[] | null> {
  try {
    const wfsUrl = `https://teledata.kulturarv.dk/geoserver/fbb/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=fbb:fredede_bygninger&outputFormat=application/json&CQL_FILTER=bfe_nummer=${bfe}&count=50`;
    const res = await fetch(wfsUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      features?: Array<{
        properties?: {
          fredningsaar?: number;
          save_vaerdi?: number;
          bygningsanvendelse?: string;
          bygning_id?: string;
        };
      }>;
    };

    if (!data.features?.length) return null;

    return data.features.map((f) => ({
      bygningId: f.properties?.bygning_id ?? null,
      fredningsstatus: 'fredet' as const,
      saveVurdering: f.properties?.save_vaerdi ?? null,
      fredningsaar: f.properties?.fredningsaar ?? null,
      byggeaar: null,
      anvendelse: f.properties?.bygningsanvendelse ?? null,
    }));
  } catch {
    return null;
  }
}

/**
 * Fallback: hent fredning/bevaringsværdighed fra BBR cache (bbr_ejendom_status).
 */
async function fetchFromBbr(bfe: number): Promise<HeritageBuilding[]> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from('bbr_ejendom_status')
      .select('bbr_data')
      .eq('bfe_nummer', bfe)
      .maybeSingle();

    if (!data?.bbr_data) return [];

    const bbrData = data.bbr_data as {
      bbr?: Array<{
        id?: string;
        fredning?: string;
        bevaringsvaerdighed?: number;
        opfoerelsesAar?: number;
        anvendelse?: string;
      }>;
    };

    return (bbrData.bbr ?? []).map((b) => {
      const erFredet = b.fredning && b.fredning !== '0' && b.fredning !== 'Ej fredet';
      const harSave = b.bevaringsvaerdighed != null && b.bevaringsvaerdighed > 0;

      return {
        bygningId: b.id ?? null,
        fredningsstatus: erFredet
          ? ('fredet' as const)
          : harSave
            ? ('bevaringsværdig' as const)
            : ('ingen' as const),
        saveVurdering: b.bevaringsvaerdighed ?? null,
        fredningsaar: null,
        byggeaar: b.opfoerelsesAar ?? null,
        anvendelse: b.anvendelse ?? null,
      };
    });
  } catch (err) {
    logger.warn('[heritage] BBR fallback fejl:', err);
    return [];
  }
}

/**
 * GET handler — hent heritage status.
 *
 * @param request - GET med ?bfe=XXXXXXX
 * @returns HeritageResponse
 */
export async function GET(request: NextRequest): Promise<NextResponse<HeritageResponse>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json(
      { bfe: 0, bygninger: [], samletStatus: 'ingen', kilde: 'bbr', fejl: 'Unauthorized' },
      { status: 401 }
    );
  }

  const parsed = parseQuery(request, querySchema);
  if (!parsed.success) {
    return NextResponse.json(
      {
        bfe: 0,
        bygninger: [],
        samletStatus: 'ingen',
        kilde: 'bbr',
        fejl: 'bfe parameter påkrævet',
      },
      { status: 400 }
    );
  }

  const bfe = parseInt(parsed.data.bfe, 10);

  // Primær: WFS
  const wfsResult = await fetchKulturarv(bfe);
  if (wfsResult && wfsResult.length > 0) {
    const samletStatus = wfsResult.some((b) => b.fredningsstatus === 'fredet')
      ? ('fredet' as const)
      : wfsResult.some((b) => b.fredningsstatus === 'bevaringsværdig')
        ? ('bevaringsværdig' as const)
        : ('ingen' as const);

    return NextResponse.json(
      { bfe, bygninger: wfsResult, samletStatus, kilde: 'wfs', fejl: null },
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
    );
  }

  // Fallback: BBR
  const bbrResult = await fetchFromBbr(bfe);
  const samletStatus = bbrResult.some((b) => b.fredningsstatus === 'fredet')
    ? ('fredet' as const)
    : bbrResult.some((b) => b.fredningsstatus === 'bevaringsværdig')
      ? ('bevaringsværdig' as const)
      : ('ingen' as const);

  return NextResponse.json(
    { bfe, bygninger: bbrResult, samletStatus, kilde: 'bbr', fejl: null },
    { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' } }
  );
}
