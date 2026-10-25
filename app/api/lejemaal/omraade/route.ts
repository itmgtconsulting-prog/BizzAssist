/**
 * GET /api/lejemaal/omraade — område-aggregater for erhvervslejeniveauer.
 *
 * Returnerer KUN aggregerede lejeniveauer (median/p25/p75 kr/m²/år + median
 * liggetid) pr. kommune/postnr/erhvervstype/periode. Eksponerer ALDRIG det
 * enkelte lejemål: datakilden (`lejemaal_omraade_statistik`) indeholder per
 * design kun grupper med antal_udbud >= 5 (re-identifikations-værn, ADR 0013),
 * og der er ingen sporbarhed tilbage til kilden.
 *
 * Input (query): mindst én af `kommune` eller `postnr`; valgfri `erhvervstype`.
 *   - kommune: string (fx "Hvidovre")
 *   - postnr: 4 cifre (fx "2650")
 *   - erhvervstype: kanonisk type (kontor|butik|lager|produktion|restaurant|klinik|showroom|andet)
 * Returnerer: { omraade, antalGrupper, statistik: OmraadeStatistik[] }
 *
 * Adgang: kræver gyldig tenant-session (resolveTenantId → 401). Data er delt
 * markedsdata (ikke tenant-scoped) og læses via admin-klienten, som bypasser
 * RLS; auth-tjekket gatekeeper adgangen. Ingen person-PII (kun erhverv).
 *
 * Retention: læser kun aggregater; ingen persistens i denne rute.
 *
 * @module app/api/lejemaal/omraade
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { parseQuery } from '@/app/lib/validate';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Gyldige kanoniske erhvervstyper (spejler Erhvervstype i normalize.ts). */
const ERHVERVSTYPER = [
  'kontor',
  'butik',
  'lager',
  'produktion',
  'restaurant',
  'klinik',
  'showroom',
  'andet',
] as const;

/** Query-parametre — mindst ét område-filter kræves (valideres i handleren). */
const schema = z.object({
  kommune: z.string().min(2).max(60).optional(),
  postnr: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  erhvervstype: z.enum(ERHVERVSTYPER).optional(),
});

/** Ét område-aggregat som eksponeret til klienten. */
interface OmraadeStatistik {
  kommune: string;
  postnr: number;
  erhvervstype: string;
  periode: string;
  antalUdbud: number;
  medianKrM2Aar: number | null;
  p25KrM2Aar: number | null;
  p75KrM2Aar: number | null;
  medianLiggetidDage: number | null;
}

/**
 * GET-handler — henter område-aggregater for erhvervslejemål.
 *
 * @param request - Next.js request med query-parametre (kommune/postnr/erhvervstype)
 * @returns JSON { omraade, antalGrupper, statistik } eller fejl-status
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, schema);
  if (!parsed.success) return NextResponse.json({ error: 'Ugyldige parametre' }, { status: 400 });
  const { kommune, postnr, erhvervstype } = parsed.data;

  // Kræv mindst ét område-filter — ellers ville ruten dumpe hele tabellen.
  if (!kommune && !postnr) {
    return NextResponse.json(
      { error: 'Angiv mindst ét område-filter: kommune eller postnr' },
      { status: 400 }
    );
  }

  try {
    const admin = createAdminClient();
    let query = admin
      .from('lejemaal_omraade_statistik')
      .select(
        'kommune, postnr, erhvervstype, periode, antal_udbud, median_kr_m2_aar, p25_kr_m2_aar, p75_kr_m2_aar, median_liggetid_dage'
      )
      .order('periode', { ascending: true });

    if (kommune) query = query.ilike('kommune', kommune);
    if (postnr) query = query.eq('postnr', Number(postnr));
    if (erhvervstype) query = query.eq('erhvervstype', erhvervstype);

    const { data, error } = await query;
    if (error) {
      logger.error('[lejemaal/omraade] db-fejl:', error.message);
      return NextResponse.json({ error: 'Kunne ikke hente lejeniveauer' }, { status: 500 });
    }

    const statistik: OmraadeStatistik[] = (data ?? []).map((r) => ({
      kommune: r.kommune,
      postnr: r.postnr,
      erhvervstype: r.erhvervstype,
      periode: r.periode,
      antalUdbud: r.antal_udbud,
      medianKrM2Aar: r.median_kr_m2_aar,
      p25KrM2Aar: r.p25_kr_m2_aar,
      p75KrM2Aar: r.p75_kr_m2_aar,
      medianLiggetidDage: r.median_liggetid_dage,
    }));

    return NextResponse.json({
      omraade: {
        kommune: kommune ?? null,
        postnr: postnr ?? null,
        erhvervstype: erhvervstype ?? null,
      },
      antalGrupper: statistik.length,
      statistik,
    });
  } catch (e: unknown) {
    logger.error('[lejemaal/omraade] fejl:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Intern fejl' }, { status: 500 });
  }
}
