/**
 * GET /api/ejerskab/person-properties?navn=...&fdato=YYYY-MM-DD
 *
 * BIZZ-534: Returnerer alle BFE-numre for ejendomme som en person ejer
 * personligt (ikke via virksomhed). Lookup sker mod den dagligt-opdaterede
 * public.ejf_ejerskab tabel der bulk-ingesteres fra Datafordeler EJF.
 *
 * Hvorfor SQL-lookup vs. live EJF-API:
 * - EJF_Ejerskab kræver speciel grant vi ikke har
 * - EJFCustom_EjerskabBegraenset (vores adgang) understøtter kun BFE/CVR-filter
 * - Bulk-data er offentlig og giver os deterministisk person-lookup uden grant
 *
 * @param navn  - Personens fulde navn (case-insensitive lookup)
 * @param fdato - Fødselsdato YYYY-MM-DD (deterministisk match med navn)
 *
 * @returns { bfes: number[], count: number, sourceFreshness: ISO-string | null }
 *
 * Retention: 24 timer (matcher cron-frekvensen).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';

export const runtime = 'nodejs';
export const maxDuration = 15;

/** Response shape */
export interface PersonPropertiesResponse {
  /** BFE-numre for ejendomme personen ejer (gældende ejerskab) */
  bfes: number[];
  /** Antal fundne ejendomme */
  count: number;
  /** Tidspunkt for seneste bulk-ingest af EJF-data (data freshness) */
  sourceFreshness: string | null;
  /** Fejlbesked hvis lookup fejlede */
  fejl?: string;
  /**
   * Bulk-data er endnu ikke initialiseret (cron har ikke kørt endnu eller
   * tabellen er tom). Returnerer tom liste men signalerer scenariet til UI.
   */
  bulkDataNotReady?: boolean;
}

const personPropertiesSchema = z.object({
  navn: z.string().min(2, 'navn er påkrævet'),
  fdato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fdato skal være YYYY-MM-DD'),
});

/**
 * GET /api/ejerskab/person-properties
 * Lookup person→ejendomme via bulk-ingested EJF-data.
 */
export async function GET(req: NextRequest): Promise<NextResponse<PersonPropertiesResponse>> {
  const session = await resolveTenantId();
  if (!session) {
    return NextResponse.json(
      { bfes: [], count: 0, sourceFreshness: null, fejl: 'Unauthorized' },
      { status: 401 }
    );
  }

  const parsed = parseQuery(req, personPropertiesSchema);
  if (!parsed.success) {
    return NextResponse.json(
      {
        bfes: [],
        count: 0,
        sourceFreshness: null,
        fejl: 'navn (string) og fdato (YYYY-MM-DD) er påkrævet',
      },
      { status: 400 }
    );
  }
  const { navn, fdato } = parsed.data;

  try {
    const admin = createAdminClient();
    // BIZZ-534: public.ejf_ejerskab + ejf_ingest_runs er nye tabeller der
    // endnu ikke er i auto-generated supabase types — cast for at tillade
    // kompil; regenerate types post-merge.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ingestRuns = (admin as any).from('ejf_ingest_runs');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ejfTbl = (admin as any).from('ejf_ejerskab');

    // Hent freshness først så vi kan signalere "bulk data not ready" når
    // tabellen er tom — bedre brugeroplevelse end stille tom liste
    const { data: lastRun } = await ingestRuns
      .select('finished_at')
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const sourceFreshness = (lastRun?.finished_at as string | null) ?? null;

    // Lookup via case-insensitive navn + eksakt fdato (matcher index)
    const { data: rows, error } = await ejfTbl
      .select('bfe_nummer')
      .ilike('ejer_navn', navn)
      .eq('ejer_foedselsdato', fdato)
      .eq('ejer_type', 'person')
      .eq('status', 'gældende');

    if (error) {
      logger.error('[person-properties] DB error:', error.message);
      return NextResponse.json(
        { bfes: [], count: 0, sourceFreshness, fejl: 'Database-fejl' },
        { status: 500 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bfes = [...new Set(((rows ?? []) as any[]).map((r) => Number(r.bfe_nummer)))];

    return NextResponse.json(
      {
        bfes,
        count: bfes.length,
        sourceFreshness,
        // Hvis vi aldrig har kørt cron, signalér dette så UI kan vise
        // en informativ besked i stedet for "ingen ejendomme fundet"
        ...(sourceFreshness == null ? { bulkDataNotReady: true } : {}),
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'private, max-age=3600' },
      }
    );
  } catch (err) {
    logger.error('[person-properties] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { bfes: [], count: 0, sourceFreshness: null, fejl: 'Intern fejl' },
      { status: 500 }
    );
  }
}
