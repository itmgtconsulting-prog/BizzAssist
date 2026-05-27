/**
 * GET /api/ejerforening-verification/community?gadenavn=Vigerslevvej&postnr=2500&husnr=146
 *
 * Finder community-verificerede ejerforeninger for ejendomme i samme
 * bygning/opgang. Bruges til at vise verificeret ejerforening automatisk
 * for alle brugere i ejendomsstrukturen — uden at de klikker AI-knappen.
 *
 * Algoritme:
 *   1. Find alle BFE'er på samme gade+postnr i bfe_adresse_cache
 *   2. Hent ejerforening_verifications for disse BFE'er
 *   3. Aggregér per candidate_cvr — behold kun net-positive (verified > rejected)
 *   4. Check om foreningens navn dækker det specifikke husnummer (range-match)
 *   5. Berig med virksomhedsnavne
 *
 * @param gadenavn - Gadenavn (fx "Vigerslevvej")
 * @param postnr - Postnummer (fx "2500")
 * @param husnr - Husnummer (fx "146") — bruges til range-match i foreningens navn
 * @returns Array af verificerede ejerforenings-kandidater
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** Verificeret ejerforening med community-counts */
export interface CommunityVerifiedEjerforening {
  cvr: string;
  navn: string;
  verified_count: number;
  rejected_count: number;
  /** True hvis foreningens navn dækker det specifikke husnummer */
  nameCoversAddress: boolean;
  /** BFE'er i nærområdet der har verificeringer for denne CVR */
  verifiedByBfes: number;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const gadenavn = req.nextUrl.searchParams.get('gadenavn');
    const postnr = req.nextUrl.searchParams.get('postnr');
    const husnrParam = req.nextUrl.searchParams.get('husnr');
    const bfeParam = req.nextUrl.searchParams.get('bfeNummer');

    if (!gadenavn || !postnr) {
      return NextResponse.json({ error: 'gadenavn og postnr er påkrævet' }, { status: 400 });
    }
    const husnr = husnrParam ? Number(husnrParam) : null;
    const currentBfe = bfeParam ? Number(bfeParam) : null;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return NextResponse.json([], { status: 200 });
    }

    const admin = createAdminClient();
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── 1. Find BFE'er på samme gade+postnr ─────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: naboRows } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('bfe_nummer')
      .ilike('adresse', `${gadenavn}%`)
      .eq('postnr', postnr)
      .limit(200);

    const bfeSet = new Set(
      ((naboRows ?? []) as Array<{ bfe_nummer: number }>).map((r) => r.bfe_nummer)
    );
    // Inkludér altid det aktuelle BFE — det kan mangle i adressecachen
    if (currentBfe) bfeSet.add(currentBfe);

    if (bfeSet.size === 0) {
      return NextResponse.json([]);
    }

    const naboBfes = [...bfeSet];

    // ── 2. Hent verificeringer for nabo-BFE'er + eget BFE ───────
    const { data: verRows, error: verErr } = await serviceClient
      .from('ejerforening_verifications')
      .select('bfe_nummer, candidate_cvr, verdict')
      .in('bfe_nummer', naboBfes);

    if (verErr) {
      logger.error('[community-verification] query error:', verErr.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!verRows || verRows.length === 0) {
      return NextResponse.json([]);
    }

    // ── 3. Aggregér per candidate_cvr ───────────────────────────
    const agg = new Map<string, { verified: number; rejected: number; bfeSet: Set<number> }>();
    for (const row of verRows as Array<{
      bfe_nummer: number;
      candidate_cvr: string;
      verdict: string;
    }>) {
      if (!agg.has(row.candidate_cvr)) {
        agg.set(row.candidate_cvr, { verified: 0, rejected: 0, bfeSet: new Set() });
      }
      const entry = agg.get(row.candidate_cvr)!;
      if (row.verdict === 'verified') entry.verified++;
      else if (row.verdict === 'rejected') entry.rejected++;
      entry.bfeSet.add(row.bfe_nummer);
    }

    // Behold kun net-positive (verified > rejected)
    const positiveCvrs = [...agg.entries()].filter(([, v]) => v.verified > v.rejected);
    if (positiveCvrs.length === 0) {
      return NextResponse.json([]);
    }

    // ── 4. Berig med virksomhedsnavne + range-match ─────────────
    const cvrList = positiveCvrs.map(([cvr]) => cvr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: virkRows } = await (admin as any)
      .from('cvr_virksomhed')
      .select('cvr, navn')
      .in('cvr', cvrList);

    const cvrNavne = new Map<string, string>();
    for (const row of (virkRows ?? []) as Array<{ cvr: string; navn: string }>) {
      cvrNavne.set(row.cvr, row.navn);
    }

    const result: CommunityVerifiedEjerforening[] = positiveCvrs.map(([cvr, counts]) => {
      const navn = cvrNavne.get(cvr) ?? `CVR ${cvr}`;
      let nameCoversAddress = false;

      // Check om foreningens navn dækker husnummeret via range-match
      if (husnr !== null) {
        const rangePattern = new RegExp(
          gadenavn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d+)(?:\\s*-\\s*(\\d+))?',
          'i'
        );
        const rm = navn.match(rangePattern);
        if (rm) {
          const lo = Number(rm[1]);
          const hi = rm[2] ? Number(rm[2]) : lo;
          nameCoversAddress = husnr >= lo && husnr <= hi;
        }
      }

      return {
        cvr,
        navn,
        verified_count: counts.verified,
        rejected_count: counts.rejected,
        nameCoversAddress,
        verifiedByBfes: counts.bfeSet.size,
      };
    });

    // Matrikel-filtrering: hvis foreningens navn indeholder et matrikelnummer
    // der IKKE matcher ejendommens matrikel → fjern. Forhindrer at en
    // ejerforening verificeret for matrikel 1218n foreslås for matrikel 1218e.
    const matrikelParam = req.nextUrl.searchParams.get('matrikelnr');
    if (matrikelParam) {
      const matrLower = matrikelParam.toLowerCase();
      const beforeLen = result.length;
      const filtered = result.filter((c) => {
        const matrInName = c.navn.match(/\b(\d{1,5}[a-zæøå]{0,3})\b/gi) ?? [];
        if (matrInName.length === 0) return true;
        return matrInName.some((m) => m.toLowerCase() === matrLower);
      });
      result.splice(0, result.length, ...filtered);
      if (filtered.length < beforeLen) {
        logger.log(
          `[community-verification] Matrikel-filter: ${beforeLen} → ${filtered.length} (matr=${matrikelParam})`
        );
      }
    }

    // Sortér: name-match først, derefter flest verificeringer
    result.sort((a, b) => {
      if (a.nameCoversAddress !== b.nameCoversAddress) return a.nameCoversAddress ? -1 : 1;
      return b.verified_count - a.verified_count;
    });

    return NextResponse.json(result);
  } catch (err) {
    logger.error('[community-verification] uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}
