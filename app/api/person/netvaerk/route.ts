/**
 * GET /api/person/netvaerk?enhedsNummer=X&max_results=20
 *
 * BIZZ-894 (audit G6): Person-netværk — find personer der oftest er
 * deltager i de samme virksomheder som den valgte person. Primært brug
 * i AI-tool `hent_person_netvaerk`, men også genbrugelig til UI-tab.
 *
 * Data-kilde: public.cvr_deltagerrelation (BIZZ-830) — joinet til
 * public.cvr_deltager for navne.
 *
 * Retention: tabellerne opdateres via CVR ES delta-sync (BIZZ-830 cron).
 * Ingen separat retention — tabellen er source-of-truth for person-
 * filtrering.
 *
 * Auth: kræver autentificeret session. Bruger admin client til DB-adgang
 * siden cvr_deltager har RLS=service_role-only (054 pattern).
 *
 * @param enhedsNummer - Personens enhedsNummer fra CVR ES
 * @param max_results  - Max antal netværks-personer (default 20, cap 50)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

const querySchema = z.object({
  enhedsNummer: z.coerce.number().int().positive(),
  max_results: z.coerce.number().int().positive().max(50).optional().default(20),
});

export interface NetvaerkEntry {
  enhedsNummer: number;
  navn: string;
  antalFaellesVirksomheder: number;
  /** Fælles-virksomheder (CVR-liste), cap'et til 10 for payload-begrænsning. */
  faellesCvrListe: string[];
  /** Distinkt roller denne person har i de fælles virksomheder. */
  roller: string[];
}

export interface NetvaerkResponse {
  enhedsNummer: number;
  antalDinevirksomheder: number;
  antalNetvaerk: number;
  netvaerk: NetvaerkEntry[];
  fejl?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse<NetvaerkResponse>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json(
      {
        enhedsNummer: 0,
        antalDinevirksomheder: 0,
        antalNetvaerk: 0,
        netvaerk: [],
        fejl: 'Unauthorized',
      },
      { status: 401 }
    );
  }

  const parsed = querySchema.safeParse({
    enhedsNummer: request.nextUrl.searchParams.get('enhedsNummer'),
    max_results: request.nextUrl.searchParams.get('max_results') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        enhedsNummer: 0,
        antalDinevirksomheder: 0,
        antalNetvaerk: 0,
        netvaerk: [],
        fejl: 'enhedsNummer skal være et positivt heltal',
      },
      { status: 400 }
    );
  }

  const { enhedsNummer, max_results: maxResults } = parsed.data;

  try {
    const admin = createAdminClient();

    // Step 1: Find personens aktive virksomhed-CVR'er.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: relations } = (await (admin as any)
      .from('cvr_deltagerrelation')
      .select('virksomhed_cvr')
      .eq('deltager_enhedsnummer', enhedsNummer)
      .is('gyldig_til', null)) as { data: Array<{ virksomhed_cvr: string }> | null };

    const cvrListe = Array.from(new Set((relations ?? []).map((r) => r.virksomhed_cvr)));
    if (cvrListe.length === 0) {
      return NextResponse.json({
        enhedsNummer,
        antalDinevirksomheder: 0,
        antalNetvaerk: 0,
        netvaerk: [],
      });
    }

    // Step 2: Find alle andre deltagere i de samme virksomheder (aktive roller).
    // PostgREST capper .in() ved ~1000, men en person har sjældent >1000 virksomheder.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: coDeltagere } = (await (admin as any)
      .from('cvr_deltagerrelation')
      .select('deltager_enhedsnummer, virksomhed_cvr, type')
      .in('virksomhed_cvr', cvrListe)
      .is('gyldig_til', null)
      .neq('deltager_enhedsnummer', enhedsNummer)) as {
      data: Array<{
        deltager_enhedsnummer: number;
        virksomhed_cvr: string;
        type: string;
      }> | null;
    };

    // Step 3: Aggregér pr. deltager_enhedsnummer.
    const agg = new Map<number, { faellesCvr: Set<string>; roller: Set<string> }>();
    for (const row of coDeltagere ?? []) {
      let bucket = agg.get(row.deltager_enhedsnummer);
      if (!bucket) {
        bucket = { faellesCvr: new Set(), roller: new Set() };
        agg.set(row.deltager_enhedsnummer, bucket);
      }
      bucket.faellesCvr.add(row.virksomhed_cvr);
      bucket.roller.add(row.type);
    }

    // Step 4: Sortér efter antal fælles virksomheder DESC, cap til maxResults.
    const top = Array.from(agg.entries())
      .map(([enheds, b]) => ({
        enhedsNummer: enheds,
        antalFaellesVirksomheder: b.faellesCvr.size,
        faellesCvrListe: Array.from(b.faellesCvr).slice(0, 10),
        roller: Array.from(b.roller),
      }))
      .sort((a, b) => b.antalFaellesVirksomheder - a.antalFaellesVirksomheder)
      .slice(0, maxResults);

    if (top.length === 0) {
      return NextResponse.json({
        enhedsNummer,
        antalDinevirksomheder: cvrListe.length,
        antalNetvaerk: 0,
        netvaerk: [],
      });
    }

    // Step 5: Join mod cvr_deltager for navne.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: deltagere } = (await (admin as any)
      .from('cvr_deltager')
      .select('enhedsnummer, navn')
      .in(
        'enhedsnummer',
        top.map((t) => t.enhedsNummer)
      )) as { data: Array<{ enhedsnummer: number; navn: string }> | null };

    const navnMap = new Map((deltagere ?? []).map((d) => [d.enhedsnummer, d.navn]));

    const netvaerk: NetvaerkEntry[] = top.map((t) => ({
      enhedsNummer: t.enhedsNummer,
      navn: navnMap.get(t.enhedsNummer) ?? `Person ${t.enhedsNummer}`,
      antalFaellesVirksomheder: t.antalFaellesVirksomheder,
      faellesCvrListe: t.faellesCvrListe,
      roller: t.roller,
    }));

    return NextResponse.json({
      enhedsNummer,
      antalDinevirksomheder: cvrListe.length,
      antalNetvaerk: netvaerk.length,
      netvaerk,
    });
  } catch (err) {
    logger.error('[person/netvaerk]', err);
    return NextResponse.json(
      {
        enhedsNummer,
        antalDinevirksomheder: 0,
        antalNetvaerk: 0,
        netvaerk: [],
        fejl: 'Ekstern API fejl',
      },
      { status: 500 }
    );
  }
}
