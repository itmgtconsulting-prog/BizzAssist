/**
 * GET /api/ai/find-ejerforening?bfeNummer=12345&adresse=Vigerslevvej+146&postnr=2500
 *
 * AI-baseret reverse-lookup: givet en ejerlejligheds BFE, find den
 * sandsynlige ejerforening der administrerer bygningen.
 *
 * Algoritme:
 *   1. Cache-check (24h TTL)
 *   2. Opslag i bfe_adresse_cache for ejendommens adresse (fallback: query params)
 *   3. Find nabo-ejendomme på samme gade+postnr
 *   4. Check ejf_administrator + ejf_ejerskab for nabo-BFE'er → grupper per CVR
 *   5. Filtrér til ejerforeninger (FFO/forening i cvr_virksomhed)
 *   6. Entydigt match → returner direkte (sparer tokens)
 *   7. Ellers → Claude Sonnet 4.6 evaluerer kandidater
 *   8. recordAiUsage() + cache resultat
 *
 * @param bfeNummer - BFE-nummer for ejendommen
 * @param adresse - Fallback-adresse (bruges når bfe_adresse_cache er tom)
 * @param postnr - Fallback-postnr
 * @returns JSON med { candidates, cachedAt? }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { recordAiUsage } from '@/app/lib/aiTracking';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** AI-fundet ejerforenings-kandidat */
export interface EjerforeningKandidat {
  cvr: string;
  navn: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  administeredCount: number;
}

/** Cache TTL: 24 timer */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ekstrahér gadenavn fra adressestreng (fjern husnummer, interval, etage/kælder-suffix).
 *
 * @param adresse - f.eks. "Vigerslevvej 144-148 (kælder)" eller "Skyttegårdsvej 3, kl."
 * @returns Gadenavn uden nr — f.eks. "Vigerslevvej"
 */
function extractStreetName(adresse: string): string {
  return adresse
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/,\s*\d*\.?\s*(?:kl|st|sal|th|tv|mf)\.?\s*$/i, '')
    .replace(/\s+\d+[\w-]*.*$/, '')
    .trim();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bfeParam = request.nextUrl.searchParams.get('bfeNummer');
  if (!bfeParam || !/^\d+$/.test(bfeParam)) {
    return NextResponse.json({ error: 'Ugyldigt bfeNummer' }, { status: 400 });
  }
  const bfeNummer = Number(bfeParam);

  const admin = createAdminClient();

  try {
    // ── 0. Cross-pollination: tjek verificerede records FØRST ──
    // BIZZ-1847: Hvis brugere har verificeret en ejerforening for denne BFE,
    // returner den som high-confidence kandidat uden at køre AI. Spar tokens
    // + giver konsistent UX på tværs af ejendoms- og virksomhedsview.
    // BIZZ-1848: Tjek også verifications på sibling/SFE-niveau — hvis
    // foreningen er verificeret for hovedejendommen, gælder den for alle
    // ejerlejligheder i samme bygning.
    const verificationBfeSet = new Set<number>([bfeNummer]);

    // Find sibling/SFE BFE'er via DAWA jordstykke for at udvide søgningen.
    // Bruger samme pattern som BIZZ-1841 SFE-hierarki traversal.
    try {
      // Hent adresse for target BFE først
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: targetAdr } = await (admin as any)
        .from('bfe_adresse_cache')
        .select('adresse, postnr')
        .eq('bfe_nummer', bfeNummer)
        .maybeSingle();
      if (targetAdr?.adresse && targetAdr?.postnr) {
        // Hent BFE'er på samme adgangsadresse (samme vejnavn+husnr)
        const husnrMatch = (targetAdr.adresse as string).match(/^(.+?)\s+(\d+\w*)/);
        if (husnrMatch) {
          const gade = husnrMatch[1];
          const husnr = husnrMatch[2];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: siblingRows } = await (admin as any)
            .from('bfe_adresse_cache')
            .select('bfe_nummer')
            .ilike('adresse', `${gade} ${husnr}%`)
            .eq('postnr', targetAdr.postnr)
            .limit(50);
          for (const row of (siblingRows ?? []) as Array<{ bfe_nummer: number }>) {
            verificationBfeSet.add(row.bfe_nummer);
          }
        }
      }
    } catch {
      /* sibling expansion non-critical for verification lookup */
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verifiedRows } = await (admin as any)
      .from('ejerforening_verification_counts')
      .select('bfe_nummer, candidate_cvr, verified_count, rejected_count')
      .in('bfe_nummer', [...verificationBfeSet]);

    // Aggregér per CVR på tværs af alle relaterede BFE'er
    const cvrAgg = new Map<string, { verified: number; rejected: number; bfes: Set<number> }>();
    for (const r of (verifiedRows ?? []) as Array<{
      bfe_nummer: number;
      candidate_cvr: string;
      verified_count: number;
      rejected_count: number;
    }>) {
      if (!cvrAgg.has(r.candidate_cvr)) {
        cvrAgg.set(r.candidate_cvr, { verified: 0, rejected: 0, bfes: new Set() });
      }
      const agg = cvrAgg.get(r.candidate_cvr)!;
      agg.verified += r.verified_count;
      agg.rejected += r.rejected_count;
      if (r.verified_count > 0) agg.bfes.add(r.bfe_nummer);
    }

    const verifiedCvrs = [...cvrAgg.entries()]
      .filter(([, v]) => v.verified > v.rejected && v.verified > 0)
      .sort((a, b) => b[1].verified - a[1].verified)
      .map(([cvr, v]) => ({
        cvr,
        verified: v.verified,
        rejected: v.rejected,
        directBfe: v.bfes.has(bfeNummer),
      }));

    if (verifiedCvrs.length > 0) {
      // Hent navne for verificerede CVRs
      const cvrList = verifiedCvrs.map((v) => v.cvr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: virkRows } = await (admin as any)
        .from('cvr_virksomhed')
        .select('cvr, navn')
        .in('cvr', cvrList);
      const navnMap = new Map(
        ((virkRows ?? []) as Array<{ cvr: string; navn: string }>).map((r) => [r.cvr, r.navn])
      );
      const verifiedResult: EjerforeningKandidat[] = verifiedCvrs.map((v) => ({
        cvr: v.cvr,
        navn: navnMap.get(v.cvr) ?? `CVR ${v.cvr}`,
        confidence: 'high' as const,
        reasoning: v.directBfe
          ? `Verificeret af ${v.verified} bruger${v.verified !== 1 ? 'e' : ''}${
              v.rejected > 0 ? ` (${v.rejected} afviste)` : ''
            }`
          : `Verificeret for hovedejendom (${v.verified} bruger${v.verified !== 1 ? 'e' : ''})`,
        administeredCount: v.verified,
      }));
      return NextResponse.json({ candidates: verifiedResult, verifiedFromCommunity: true });
    }

    // ── 0b. Matrikelnr for filtrering — fra klient-param (hurtigst) eller DAWA ──
    let ejendommensMatrikel: string | null = request.nextUrl.searchParams.get('matrikelnr') ?? null;
    const adresseParam = request.nextUrl.searchParams.get('adresse');
    const postnrParam = request.nextUrl.searchParams.get('postnr');
    if (!ejendommensMatrikel && adresseParam && postnrParam) {
      try {
        const matrRes = await fetch(
          `https://api.dataforsyningen.dk/adgangsadresser?q=${encodeURIComponent(adresseParam)}&postnr=${postnrParam}&format=json&per_side=1`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (matrRes.ok) {
          const matrData = (await matrRes.json()) as Array<{
            jordstykke?: { matrikelnr?: string };
          }>;
          ejendommensMatrikel = matrData[0]?.jordstykke?.matrikelnr ?? null;
        }
      } catch {
        /* matrikel lookup non-fatal */
      }
    }

    // ── 0c. Direkte matrikel-navne-match (hurtigste path) ────────
    // Hvis vi har matrikelnr, søg STRAKS efter ejerforening med matrikel i navn.
    // Undgår alle de tunge lookups + Claude-kald. ~200ms total.
    logger.log(`[ai/find-ejerforening] 0c: ejendommensMatrikel="${ejendommensMatrikel}"`);
    if (ejendommensMatrikel) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: directRows, error: directErr } = await (admin as any)
          .from('cvr_virksomhed')
          .select('cvr, navn')
          .textSearch('navn', `ejerforening ${ejendommensMatrikel}`, {
            type: 'plain',
            config: 'danish',
          })
          .limit(5);
        logger.log(
          `[ai/find-ejerforening] 0c: directRows=${directRows?.length ?? 'null'} err=${directErr?.message ?? 'none'}`
        );
        const directMatches = ((directRows ?? []) as Array<{ cvr: string; navn: string }>).filter(
          (row) => {
            const matrInName = row.navn.match(/\b(\d{1,5}[a-zæøå]{0,3})\b/gi) ?? [];
            return matrInName.some((m) => m.toLowerCase() === ejendommensMatrikel!.toLowerCase());
          }
        );
        logger.log(
          `[ai/find-ejerforening] 0c: directMatches=${directMatches.length} names=${directMatches.map((m) => m.navn).join(',')}`
        );
        if (directMatches.length === 1) {
          const m = directMatches[0];
          const directResult: EjerforeningKandidat[] = [
            {
              cvr: m.cvr,
              navn: m.navn,
              confidence: 'high',
              reasoning: `Foreningens navn matcher ejendommens matrikelnr ${ejendommensMatrikel}`,
              administeredCount: 0,
            },
          ];
          logger.log(`[ai/find-ejerforening] Direkte matrikel-match: ${m.navn} (CVR ${m.cvr})`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          void (admin as any)
            .from('ai_find_ejerforening_cache')
            .upsert(
              {
                bfe_nummer: bfeNummer,
                candidates: directResult,
                created_at: new Date().toISOString(),
              },
              { onConflict: 'bfe_nummer' }
            )
            .then(() => {});
          return NextResponse.json({ candidates: directResult });
        }
      } catch {
        /* direct matrikel match non-fatal — fall through to full search */
      }
    }

    // ── 1. Cache-check ──────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached } = await (admin as any)
      .from('ai_find_ejerforening_cache')
      .select('candidates, created_at')
      .eq('bfe_nummer', bfeNummer)
      .maybeSingle();

    if (cached?.candidates) {
      const age = Date.now() - new Date(cached.created_at).getTime();
      if (age < CACHE_TTL_MS) {
        // Matrikel-filter på cached resultater — forhindrer stale false positives
        // (fx "Carlsberg Byen 1218n" cached for en 1218e-ejendom)
        let cachedCandidates = cached.candidates as EjerforeningKandidat[];
        if (ejendommensMatrikel) {
          const matrLower = ejendommensMatrikel.toLowerCase();
          cachedCandidates = cachedCandidates.filter((c) => {
            const matrInName = c.navn.match(/\b(\d{1,5}[a-zæøå]{0,3})\b/gi) ?? [];
            if (matrInName.length === 0) return true;
            return matrInName.some((m) => m.toLowerCase() === matrLower);
          });
        }
        return NextResponse.json({
          candidates: cachedCandidates,
          cachedAt: cached.created_at,
        });
      }
    }

    // Fra dette punkt kræves billing-check + rate limit
    const blocked = await assertAiAllowed(auth.userId);
    if (blocked) return blocked as unknown as NextResponse;

    const rl = await checkRateLimit(request, aiRateLimit);
    if (rl) return rl;

    // ── 2. Opslag i bfe_adresse_cache (med fallback til query params) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: propertyRow } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('adresse, postnr, postnrnavn')
      .eq('bfe_nummer', bfeNummer)
      .maybeSingle();

    // Fallback: frontend sender adresse+postnr som query params
    const fallbackAdresse = request.nextUrl.searchParams.get('adresse');
    const fallbackPostnr = request.nextUrl.searchParams.get('postnr');

    const adresse = propertyRow?.postnr ? propertyRow.adresse : (fallbackAdresse ?? null);
    const postnr = propertyRow?.postnr ? propertyRow.postnr : (fallbackPostnr ?? null);
    const postnrnavn = propertyRow?.postnrnavn ?? null;

    if (!adresse || !postnr) {
      return NextResponse.json({ candidates: [] });
    }

    const gadenavn = extractStreetName(adresse);
    if (!gadenavn) {
      return NextResponse.json({ candidates: [] });
    }

    // ── 3. Find nabo-ejendomme ──────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: naboRows } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('bfe_nummer')
      .ilike('adresse', `${gadenavn}%`)
      .eq('postnr', postnr)
      .limit(200);

    const naboBfes = ((naboRows ?? []) as Array<{ bfe_nummer: number }>).map((r) => r.bfe_nummer);
    // BIZZ-1841: Inkludér target BFE — det kan selv have admin/ejer-registreringer

    // BIZZ-1841: SFE-hierarki traversal — find BFE'er på præcis samme
    // adresse (vejnavn+husnr) som er SFE/hovedejendom-niveauer der dækker
    // target ejerlejligheden. Deres ejf_administrator/ejf_ejerskab rækker
    // fanger ejerforeninger der er registreret på SFE-niveau.
    const husnrMatch = adresse.match(/\s+(\d+)/);
    const targetHusnr = husnrMatch ? husnrMatch[1] : null;
    if (targetHusnr) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: siblingRows } = await (admin as any)
        .from('bfe_adresse_cache')
        .select('bfe_nummer')
        .ilike('adresse', `${gadenavn} ${targetHusnr}%`)
        .eq('postnr', postnr)
        .limit(50);
      for (const row of (siblingRows ?? []) as Array<{ bfe_nummer: number }>) {
        if (!naboBfes.includes(row.bfe_nummer)) {
          naboBfes.push(row.bfe_nummer);
        }
      }
    }

    // Sørg for at target BFE selv er med
    if (!naboBfes.includes(bfeNummer)) {
      naboBfes.push(bfeNummer);
    }

    // BIZZ-1855: adgangsAdresseID-baseret sibling traversal.
    // For Carlsberg Byen-stil bygninger har mange lejligheder samme
    // adgangsAdresseID. Find target BFE's dawa_id, derefter alle andre
    // BFE'er der deler samme dawa_id. Fanger SFE-tilfælde hvor flere
    // indgange deler en hovedejerforening men har forskellige vejnavne.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: targetRow } = await (admin as any)
        .from('bfe_adresse_cache')
        .select('dawa_id')
        .eq('bfe_nummer', bfeNummer)
        .maybeSingle();
      const targetDawaId = (targetRow as { dawa_id?: string } | null)?.dawa_id;
      if (targetDawaId) {
        // Find adgangsadresse fra DAWA adresse-UUID (etage-niveau har eget UUID,
        // adgangsadresse er parent UUID for hele opgangen)
        const dawaRes = await fetch(
          `https://api.dataforsyningen.dk/adresser/${targetDawaId}?struktur=flad`,
          { signal: AbortSignal.timeout(5000) }
        );
        let adgAddrId: string | null = null;
        if (dawaRes.ok) {
          const adrData = (await dawaRes.json()) as { adgangsadresseid?: string };
          adgAddrId = adrData?.adgangsadresseid ?? null;
        }
        if (adgAddrId) {
          // Find alle adresser med samme adgangsadresse (= samme opgang/bygning)
          const siblingsRes = await fetch(
            `https://api.dataforsyningen.dk/adresser?adgangsadresseid=${adgAddrId}&struktur=mini&per_side=200`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (siblingsRes.ok) {
            const siblings = (await siblingsRes.json()) as Array<{ id: string }>;
            const siblingDawaIds = siblings.map((s) => s.id);
            if (siblingDawaIds.length > 0) {
              // Map DAWA-UUIDs til BFE'er via bfe_adresse_cache.dawa_id
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: siblingBfeRows } = await (admin as any)
                .from('bfe_adresse_cache')
                .select('bfe_nummer')
                .in('dawa_id', siblingDawaIds);
              for (const row of (siblingBfeRows ?? []) as Array<{ bfe_nummer: number }>) {
                if (!naboBfes.includes(row.bfe_nummer)) {
                  naboBfes.push(row.bfe_nummer);
                }
              }
              logger.log(
                `[ai/find-ejerforening] adgangsAdresseID traversal: ${siblingDawaIds.length} siblings`
              );
            }
          }
        }
      }
    } catch {
      /* adgangsAdresseID traversal non-fatal */
    }

    // BIZZ-1841: DAWA jordstykke-baseret SFE parent lookup.
    // En ejerlejlighed deler matrikel med sin SFE. Via DAWA adgangsadresse →
    // jordstykke finder vi SFE-BFE'en, som kan have ejf_ejerskab/administrator-
    // records for en ejerforening der ellers ikke dukker op i gadenavn-søgningen.
    // Opdater matrikelnr med mere præcis jordstykke-data
    try {
      const dawaAdrRes = await fetch(
        `https://api.dataforsyningen.dk/adgangsadresser?q=${encodeURIComponent(adresse)}&postnr=${postnr}&format=json&per_side=1`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (dawaAdrRes.ok) {
        const dawaAdresser = (await dawaAdrRes.json()) as Array<{
          id: string;
          jordstykke?: { matrikelnr?: string };
        }>;
        // Gem matrikelnr fra adgangsadresse-response
        ejendommensMatrikel = dawaAdresser[0]?.jordstykke?.matrikelnr ?? null;
        if (dawaAdresser[0]?.id) {
          const jordRes = await fetch(
            `https://api.dataforsyningen.dk/jordstykker?adgangsadresseid=${dawaAdresser[0].id}&format=json`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (jordRes.ok) {
            const jordstykker = (await jordRes.json()) as Array<{
              bfenummer?: number;
              matrikelnr?: string;
            }>;
            // Gem matrikelnr fra jordstykke (mere præcis)
            if (jordstykker[0]?.matrikelnr) ejendommensMatrikel = jordstykker[0].matrikelnr;
            for (const js of jordstykker) {
              if (js.bfenummer && !naboBfes.includes(js.bfenummer)) {
                naboBfes.push(js.bfenummer);
                logger.log('[ai/find-ejerforening] DAWA SFE parent found:', js.bfenummer);
              }
            }
          } else {
            logger.warn('[ai/find-ejerforening] DAWA jordstykke failed:', jordRes.status);
          }
        }
      } else {
        logger.warn('[ai/find-ejerforening] DAWA adgangsadresse failed:', dawaAdrRes.status);
      }
    } catch (dawaErr) {
      logger.warn(
        '[ai/find-ejerforening] DAWA fallback error:',
        dawaErr instanceof Error ? dawaErr.message : 'unknown'
      );
    }

    // BIZZ-1841: Direkte EJF-søgning for foreninger i samme postnr (fallback
    // når DAWA er langsom eller gadenavn-søgning er tom). Find alle forenings-CVR'er
    // der har ejf_administrator/ejf_ejerskab records for BFE'er i dette postnr.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: postnrBfes } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('bfe_nummer')
      .eq('postnr', postnr)
      .limit(500);
    const postnrBfeList = ((postnrBfes ?? []) as Array<{ bfe_nummer: number }>).map(
      (r) => r.bfe_nummer
    );
    if (postnrBfeList.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: postnrAdminRows } = await (admin as any)
        .from('ejf_administrator')
        .select('bfe_nummer')
        .in('bfe_nummer', postnrBfeList.slice(0, 200))
        .eq('status', 'gældende')
        .not('virksomhed_cvr', 'is', null);
      for (const row of (postnrAdminRows ?? []) as Array<{ bfe_nummer: number }>) {
        if (!naboBfes.includes(row.bfe_nummer)) {
          naboBfes.push(row.bfe_nummer);
        }
      }
    }

    if (naboBfes.length === 0) {
      return NextResponse.json({ candidates: [] });
    }

    // ── 4. Check ejf_administrator + ejf_ejerskab for naboer ────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: adminRows } = await (admin as any)
      .from('ejf_administrator')
      .select('bfe_nummer, virksomhed_cvr')
      .in('bfe_nummer', naboBfes.slice(0, 200))
      .eq('status', 'gældende')
      .not('virksomhed_cvr', 'is', null);

    // Søg i ejf_ejerskab — gældende ejere
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejerRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_cvr')
      .in('bfe_nummer', naboBfes.slice(0, 200))
      .eq('status', 'gældende')
      .not('ejer_cvr', 'is', null);

    // Søg i ejf_ejerskab — historiske ejere (fanger ejendomme der tidligere
    // tilhørte ejerforeningen, stærkt signal for ejerlejligheder i samme struktur)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: histEjerRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_cvr')
      .in('bfe_nummer', naboBfes.slice(0, 200))
      .eq('status', 'historisk')
      .not('ejer_cvr', 'is', null);

    // Grupper per CVR — track match-årsager for reasoning
    const cvrCounts = new Map<string, number>();
    const cvrReasons = new Map<string, string[]>();
    const adminCvrCount = new Map<string, number>();
    const ejerCvrCount = new Map<string, number>();
    const histEjerCvrCount = new Map<string, number>();

    for (const row of (adminRows ?? []) as Array<{
      bfe_nummer: number;
      virksomhed_cvr: string;
    }>) {
      // BIZZ-1841: Direkte admin-registrering på target/sibling BFE giver
      // højere score (10) end nabo-BFE (1)
      const score = row.bfe_nummer === bfeNummer ? 10 : 1;
      cvrCounts.set(row.virksomhed_cvr, (cvrCounts.get(row.virksomhed_cvr) ?? 0) + score);
      adminCvrCount.set(row.virksomhed_cvr, (adminCvrCount.get(row.virksomhed_cvr) ?? 0) + 1);
      if (row.bfe_nummer === bfeNummer) {
        if (!cvrReasons.has(row.virksomhed_cvr)) cvrReasons.set(row.virksomhed_cvr, []);
        cvrReasons.get(row.virksomhed_cvr)!.push('Direkte administrator for ejendommen');
      }
    }
    for (const row of (ejerRows ?? []) as Array<{
      bfe_nummer: number;
      ejer_cvr: string;
    }>) {
      const score = row.bfe_nummer === bfeNummer ? 10 : 1;
      cvrCounts.set(row.ejer_cvr, (cvrCounts.get(row.ejer_cvr) ?? 0) + score);
      ejerCvrCount.set(row.ejer_cvr, (ejerCvrCount.get(row.ejer_cvr) ?? 0) + 1);
      if (row.bfe_nummer === bfeNummer) {
        if (!cvrReasons.has(row.ejer_cvr)) cvrReasons.set(row.ejer_cvr, []);
        cvrReasons.get(row.ejer_cvr)!.push('Direkte ejer af ejendommen');
      }
    }
    for (const row of (histEjerRows ?? []) as Array<{
      bfe_nummer: number;
      ejer_cvr: string;
    }>) {
      // Historiske ejerskaber giver lavere score men er stadig et signal
      const score = row.bfe_nummer === bfeNummer ? 5 : 1;
      cvrCounts.set(row.ejer_cvr, (cvrCounts.get(row.ejer_cvr) ?? 0) + score);
      histEjerCvrCount.set(row.ejer_cvr, (histEjerCvrCount.get(row.ejer_cvr) ?? 0) + 1);
    }

    // ── 4b. Søg ejerforeninger via navn der matcher gadenavn ────
    // Stærkeste signal: foreningens navn indeholder gadenavn+husnumre.
    // Eksempel: "Ejerforeningen Skyttegårdsvej 1-11 Vigerslevvej 144-148"
    // matcher for en ejendom på Vigerslevvej 146.
    // Filtrerer direkte i query til foreninger (ejerforening/e/f/a/b/andelsbolig)
    // for at undgå at irrelevante virksomheder fylder limit op.
    // FTS i stedet for ILIKE (ILIKE timeouter på 2.1M rows).
    // Søger ejerforeninger hvis navn indeholder gadenavn via GIN tsv-index.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: navnMatchRows } = await (admin as any)
      .from('cvr_virksomhed')
      .select('cvr, navn')
      .textSearch(
        'navn',
        `${gadenavn} ejerforening | ${gadenavn} forening | ${gadenavn} andelsbolig`,
        {
          type: 'plain',
          config: 'danish',
        }
      )
      .limit(50);

    // Matrikel-baseret navne-søgning: find foreninger hvis navn indeholder
    // ejendommens matrikelnummer (fx "Carlsberg Byen 1218E" for matrikel 1218e).
    // Fanger ejerforeninger der ikke har gadenavn i navnet.
    if (ejendommensMatrikel) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: matrNavnRows } = await (admin as any)
        .from('cvr_virksomhed')
        .select('cvr, navn')
        .textSearch('navn', `ejerforening ${ejendommensMatrikel}`, {
          type: 'plain',
          config: 'danish',
        })
        .limit(10);
      const matrMatches: Array<{ cvr: string; navn: string }> = [];
      for (const row of (matrNavnRows ?? []) as Array<{ cvr: string; navn: string }>) {
        const matrInName = row.navn.match(/\b(\d{1,5}[a-zæøå]{0,3})\b/gi) ?? [];
        const matches = matrInName.some(
          (m) => m.toLowerCase() === ejendommensMatrikel!.toLowerCase()
        );
        if (matches) {
          matrMatches.push(row);
          cvrCounts.set(row.cvr, (cvrCounts.get(row.cvr) ?? 0) + 15);
          if (!cvrReasons.has(row.cvr)) cvrReasons.set(row.cvr, []);
          cvrReasons
            .get(row.cvr)!
            .push(`Foreningens navn matcher matrikelnr ${ejendommensMatrikel}`);
          logger.log(`[ai/find-ejerforening] Matrikel-navnematch: ${row.navn} (CVR ${row.cvr})`);
        }
      }
      // Direkte return ved eksakt matrikel-match — ingen Claude nødvendig
      if (matrMatches.length === 1) {
        const m = matrMatches[0];
        const directResult: EjerforeningKandidat[] = [
          {
            cvr: m.cvr,
            navn: m.navn,
            confidence: 'high',
            reasoning: `Foreningens navn matcher ejendommens matrikelnr ${ejendommensMatrikel}`,
            administeredCount: 0,
          },
        ];
        // Cache
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (admin as any)
          .from('ai_find_ejerforening_cache')
          .upsert(
            {
              bfe_nummer: bfeNummer,
              candidates: directResult,
              created_at: new Date().toISOString(),
            },
            { onConflict: 'bfe_nummer' }
          )
          .then(() => {});
        return NextResponse.json({ candidates: directResult });
      }
    }

    // Ekstrahér husnummer fra adressen for range-matching
    const husnr = targetHusnr ? Number(targetHusnr) : null;

    for (const row of (navnMatchRows ?? []) as Array<{ cvr: string; navn: string }>) {
      let score = 5; // Base-score for navne-match

      // Bonus: check om foreningens husnummer-range inkluderer vores husnr.
      // Eksempel: "Vigerslevvej 144-148" og husnr=146 → match
      if (husnr !== null) {
        const rangePattern = new RegExp(
          gadenavn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d+)(?:\\s*-\\s*(\\d+))?',
          'i'
        );
        const rm = row.navn.match(rangePattern);
        if (rm) {
          const lo = Number(rm[1]);
          const hi = rm[2] ? Number(rm[2]) : lo;
          if (husnr >= lo && husnr <= hi) {
            score = 20; // Stærkt match — husnummer er i range
          }
        }
      }

      cvrCounts.set(row.cvr, (cvrCounts.get(row.cvr) ?? 0) + score);
      if (score >= 20) {
        if (!cvrReasons.has(row.cvr)) cvrReasons.set(row.cvr, []);
        cvrReasons.get(row.cvr)!.push(`Foreningens navn dækker adressen`);
      } else {
        if (!cvrReasons.has(row.cvr)) cvrReasons.set(row.cvr, []);
        cvrReasons.get(row.cvr)!.push(`Foreningens navn nævner ${gadenavn}`);
      }
    }

    if (cvrCounts.size === 0) {
      // Ingen administratorer/ejere/navnematch fundet — cache tomt resultat
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (admin as any)
        .from('ai_find_ejerforening_cache')
        .upsert(
          { bfe_nummer: bfeNummer, candidates: [], created_at: new Date().toISOString() },
          { onConflict: 'bfe_nummer' }
        )
        .then(() => {});
      return NextResponse.json({ candidates: [] });
    }

    // ── 4c. Filtrér til ejerforeninger (FFO/forening) ───────────
    // Ikke alle CVR'er er ejerforeninger — filtrér via cvr_virksomhed
    const allCvrList = [...cvrCounts.keys()];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: allVirkRows } = await (admin as any)
      .from('cvr_virksomhed')
      .select('cvr, navn, virksomhedsform')
      .in('cvr', allCvrList);

    // Behold kun foreninger (FFO, forening, ejerforening i navn/form)
    const foreningCvrs = new Set<string>();
    for (const row of (allVirkRows ?? []) as Array<{
      cvr: string;
      navn: string;
      virksomhedsform: string | null;
    }>) {
      const navnLower = row.navn.toLowerCase();
      const formLower = (row.virksomhedsform ?? '').toLowerCase();
      if (
        formLower.includes('ffo') ||
        formLower.includes('forening') ||
        navnLower.includes('ejerforening') ||
        navnLower.includes('e/f') ||
        navnLower.includes('a/b') ||
        navnLower.includes('andelsbolig') ||
        navnLower.includes('boligforening')
      ) {
        foreningCvrs.add(row.cvr);
      }
    }

    // Hvis ingen foreninger fundet, prøv med alle CVR'er (fallback)
    const filteredCvrs =
      foreningCvrs.size > 0
        ? new Map([...cvrCounts].filter(([cvr]) => foreningCvrs.has(cvr)))
        : cvrCounts;

    if (filteredCvrs.size === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (admin as any)
        .from('ai_find_ejerforening_cache')
        .upsert(
          { bfe_nummer: bfeNummer, candidates: [], created_at: new Date().toISOString() },
          { onConflict: 'bfe_nummer' }
        )
        .then(() => {});
      return NextResponse.json({ candidates: [] });
    }

    // Hent virksomhedsnavne for filtrerede CVR'er
    const cvrList = [...filteredCvrs.keys()];
    const cvrNavne = new Map<string, string>();
    for (const row of (allVirkRows ?? []) as Array<{ cvr: string; navn: string }>) {
      if (filteredCvrs.has(row.cvr)) {
        cvrNavne.set(row.cvr, row.navn);
      }
    }

    /**
     * Byg reasoning-streng baseret på match-kilder for et CVR.
     *
     * @param cvr - CVR-nummer
     * @returns Reasoning-tekst på dansk
     */
    function buildReasoning(cvr: string): string {
      const parts: string[] = [];
      const ac = adminCvrCount.get(cvr);
      const ec = ejerCvrCount.get(cvr);
      const hc = histEjerCvrCount.get(cvr);
      if (ac && ac > 0) parts.push(`Administrator for ${ac} ejendomme i ejendomsstrukturen`);
      if (ec && ec > 0) parts.push(`Registreret ejer af ${ec} ejendomme på ${gadenavn}`);
      if (hc && hc > 0) parts.push(`Historisk registreret på ${hc} ejendomme i ejendomsstrukturen`);
      const extraReasons = cvrReasons.get(cvr) ?? [];
      for (const r of extraReasons) {
        if (!parts.includes(r)) parts.push(r);
      }
      return parts.length > 0 ? parts.join('. ') : `Fundet i nærområdet`;
    }

    // ── 5. Entydigt match → returner direkte ────────────────────
    if (filteredCvrs.size === 1) {
      const [cvr, count] = [...filteredCvrs.entries()][0];
      const result: EjerforeningKandidat[] = [
        {
          cvr,
          navn: cvrNavne.get(cvr) ?? `CVR ${cvr}`,
          confidence: count >= 3 ? 'high' : 'medium',
          reasoning: buildReasoning(cvr),
          administeredCount: count,
        },
      ];

      // Cache
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (admin as any)
        .from('ai_find_ejerforening_cache')
        .upsert(
          { bfe_nummer: bfeNummer, candidates: result, created_at: new Date().toISOString() },
          { onConflict: 'bfe_nummer' }
        )
        .then(() => {});

      // Matrikel-filter på entydigt match
      if (ejendommensMatrikel) {
        const matrLower = ejendommensMatrikel.toLowerCase();
        const filtered = result.filter((c) => {
          const m = c.navn.match(/\b(\d{1,5}[a-zæøå]{0,3})\b/gi) ?? [];
          return m.length === 0 || m.some((x) => x.toLowerCase() === matrLower);
        });
        // Alle filtreret væk — søg efter den RIGTIGE forening via matrikel-navn
        if (filtered.length === 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: correctRows } = await (admin as any)
            .from('cvr_virksomhed')
            .select('cvr, navn')
            .textSearch('navn', `ejerforening ${ejendommensMatrikel}`, {
              type: 'plain',
              config: 'danish',
            })
            .limit(3);
          const correctMatch = ((correctRows ?? []) as Array<{ cvr: string; navn: string }>).find(
            (r) => {
              const m = r.navn.match(/\b(\d{1,5}[a-zæøå]{0,3})\b/gi) ?? [];
              return m.some((x) => x.toLowerCase() === matrLower);
            }
          );
          if (correctMatch) {
            const correctResult: EjerforeningKandidat[] = [
              {
                cvr: correctMatch.cvr,
                navn: correctMatch.navn,
                confidence: 'high',
                reasoning: `Foreningens navn matcher ejendommens matrikelnr ${ejendommensMatrikel}`,
                administeredCount: 0,
              },
            ];
            return NextResponse.json({
              candidates: correctResult,
              _debug: { ejendommensMatrikel, path: 'matrikel-corrected' },
            });
          }
        }
        return NextResponse.json({
          candidates: filtered,
          _debug: { ejendommensMatrikel, path: 'unique-filtered' },
        });
      }
      return NextResponse.json({
        candidates: result,
        _debug: { ejendommensMatrikel, path: 'unique' },
      });
    }

    // ── 6. Flere kandidater → Claude evaluerer ──────────────────
    const kandidatListe = cvrList
      .map((cvr) => {
        const navn = cvrNavne.get(cvr) ?? `CVR ${cvr}`;
        const count = filteredCvrs.get(cvr) ?? 0;
        return `CVR ${cvr}: ${navn} (ejer/administrerer ${count} ejendomme i området)`;
      })
      .join('\n');

    const systemPrompt = `Du er en dansk ejendomsanalytiker. Du skal finde den mest sandsynlige ejerforening for en specifik ejerlejlighed.

Du modtager:
1. Ejerlejlighedens adresse
2. En liste over ejerforeninger der administrerer andre ejendomme på samme gade

Din opgave: Vurdér hvilken ejerforening der mest sandsynligt administrerer den givne ejerlejlighed.

VURDERINGSKRITERIER:
- Antal administrerede ejendomme på gaden: Flere = mere sandsynligt
- Foreningens navn: Matcher det gadenavn eller husnummer-range?
- Hvis én forening klart dominerer gaden, er den mest sandsynlig

REGLER:
- confidence: "high" (>80% sikker), "medium" (50-80%), "low" (<50%)
- Vær konservativ — hellere "medium" end forkert "high"
- Skriv kort reasoning på dansk (max 1 sætning per kandidat)
- Returnér ALLE kandidater, sorteret efter sandsynlighed

Svar UDELUKKENDE med valid JSON array:
[{"cvr": "12345678", "confidence": "high", "reasoning": "Administrerer flest ejendomme på gaden og navnet matcher"}]

Ingen markdown, ingen forklaring uden for arrayet.`;

    const userPrompt = `Ejerlejlighed: ${adresse}, ${postnr} ${postnrnavn ?? ''}

Kandidat-ejerforeninger:
${kandidatListe}`;

    const client = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Track AI usage
    const usage = response.usage;
    void recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'ai.find-ejerforening',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      model: 'claude-sonnet-4-6',
    });

    // Parse AI response
    const aiText = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '[]';
    let aiCandidates: Array<{ cvr: string; confidence: string; reasoning: string }> = [];
    try {
      const cleaned = aiText
        .replace(/```json?\s*/g, '')
        .replace(/```/g, '')
        .trim();
      aiCandidates = JSON.parse(cleaned);
    } catch {
      logger.warn('[ai/find-ejerforening] Could not parse AI response:', aiText.slice(0, 200));
      // Fallback: returner alle kandidater med medium confidence
      aiCandidates = cvrList.map((cvr) => ({
        cvr,
        confidence: 'medium',
        reasoning: buildReasoning(cvr),
      }));
    }

    // ── 7. Berig + cache ────────────────────────────────────────
    const validConfidences = new Set(['high', 'medium', 'low']);
    const result: EjerforeningKandidat[] = aiCandidates
      .filter((c) => c.cvr && validConfidences.has(c.confidence))
      .map((c) => ({
        cvr: c.cvr,
        navn: cvrNavne.get(c.cvr) ?? `CVR ${c.cvr}`,
        confidence: c.confidence as 'high' | 'medium' | 'low',
        reasoning: c.reasoning ?? '',
        administeredCount: filteredCvrs.get(c.cvr) ?? 0,
      }));

    logger.log(
      `[ai/find-ejerforening] Pre-filter: ${result.length} candidates, ejendommensMatrikel=${ejendommensMatrikel}`
    );
    // Matrikel-filtrering: hvis en kandidats navn indeholder et matrikelnummer
    // (fx "1218n"), og ejendommens matrikel er FORSKELLIG (fx "1218e"),
    // fjern kandidaten. Undgår false positives på tværs af matrikler.
    if (ejendommensMatrikel) {
      const matrLower = ejendommensMatrikel.toLowerCase();
      const beforeFilter = result.length;
      const filtered = result.filter((c) => {
        // Ekstraher matrikelnumre fra foreningens navn (fx "1218n" fra "Carlsberg Byen 1218n")
        const matrInName = c.navn.match(/\b(\d{1,5}[a-zæøå]{0,3})\b/gi) ?? [];
        // Hvis ingen matrikel i navnet → behold (kan ikke filtrere)
        if (matrInName.length === 0) return true;
        // Behold kun hvis mindst ét matrikelnr i navnet matcher ejendommens
        return matrInName.some((m) => m.toLowerCase() === matrLower);
      });
      if (filtered.length < beforeFilter) {
        logger.log(
          `[ai/find-ejerforening] Matrikel-filter: ${beforeFilter} → ${filtered.length} (ejendom matr=${ejendommensMatrikel})`
        );
      }
      result.splice(0, result.length, ...filtered);
    }

    // Cache resultatet
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (admin as any)
      .from('ai_find_ejerforening_cache')
      .upsert(
        { bfe_nummer: bfeNummer, candidates: result, created_at: new Date().toISOString() },
        { onConflict: 'bfe_nummer' }
      )
      .then(() => {});

    // FINAL matrikel-filter — sidste chance at fjerne forkerte foreninger
    if (ejendommensMatrikel) {
      const matrLower = ejendommensMatrikel.toLowerCase();
      const before = result.length;
      const finalFiltered = result.filter((c) => {
        const matrInName = c.navn.match(/\b(\d{1,5}[a-zæøå]{0,3})\b/gi) ?? [];
        if (matrInName.length === 0) return true;
        return matrInName.some((m) => m.toLowerCase() === matrLower);
      });
      if (finalFiltered.length < before) {
        logger.log(
          `[ai/find-ejerforening] FINAL matrikel-filter: ${before} → ${finalFiltered.length}`
        );
      }
      return NextResponse.json({
        candidates: finalFiltered,
        _debug: { ejendommensMatrikel, filtered: before - finalFiltered.length },
      });
    }

    return NextResponse.json({ candidates: result, _debug: { ejendommensMatrikel } });
  } catch (err) {
    logger.error('[ai/find-ejerforening] Error:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
