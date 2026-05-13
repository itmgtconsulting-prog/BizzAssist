/**
 * crossChecks — Auto-triggered cross-checks mod eksterne datakilder.
 *
 * BIZZ-1369: BBR cross-check (areal-mismatch, anvendelse-mismatch)
 * BIZZ-1370: Tinglysning cross-check (hæftelser vs police-sum)
 * BIZZ-1371: VUR cross-check (vurdering vs police-sum)
 * BIZZ-1372: Klyngerisiko (geografisk + branche koncentration)
 * BIZZ-1373: Restaurant-køkken-krav
 * BIZZ-1374: D&O/Cyber/Driftstab anbefalinger
 *
 * Alle funktioner er best-effort — fejl i eksterne API'er logges
 * men afbryder ikke analysen.
 *
 * @module
 */

import { runGapEngine, computeRiskScore } from './gapEngine';
import type { BbrPropertyFacts, DetectedGap } from './types';
import type { Aktiv } from './koncernWalk';
import type { MatchResult } from './assetMatcher';
import { logger } from '@/app/lib/logger';

/** Cross-check resultat med gaps + berigede aktiv-data */
export interface CrossCheckResult {
  /** Nye gaps fundet af cross-checks */
  gaps: Array<DetectedGap & { riskScore: number; policyId: string }>;
  /** BBR-data for ejendomme (til UI-visning) */
  bbrByBfe: Map<number, BbrPropertyFacts>;
  /** Hæftelser pr. BFE */
  haeftelserByBfe: Map<number, number>;
  /** Vurdering pr. BFE */
  vurderingByBfe: Map<number, number>;
}

/**
 * BIZZ-1369: Hent BBR-data for ejendomme og kør gap-engine med BBR-fakta.
 * Detekterer GAP-001 (areal-mismatch) og GAP-040 (anvendelse-mismatch).
 *
 * @param matches - Match-resultater fra assetMatcher
 * @param host - Request host for interne API-kald
 * @param cookie - Auth cookie
 * @returns BBR-fakta map + detekterede gaps
 */
export async function runBbrCrossCheck(
  matches: MatchResult[],
  host: string,
  cookie: string
): Promise<{ gaps: CrossCheckResult['gaps']; bbrByBfe: Map<number, BbrPropertyFacts> }> {
  const gaps: CrossCheckResult['gaps'] = [];
  const bbrByBfe = new Map<number, BbrPropertyFacts>();

  // Saml BFE-numre fra ejendom-aktiver
  const ejendomMatches = matches.filter(
    (m) => m.aktiv.type === 'ejendom' && m.aktiv.bfe && m.bestMatch
  );
  if (ejendomMatches.length === 0) return { gaps, bbrByBfe };

  const bfes = ejendomMatches.map((m) => m.aktiv.bfe!);

  try {
    // Hent BBR-data via bfe-addresses API (batch)
    const res = await fetch(`${host}/api/bfe-addresses?bfes=${bfes.join(',')}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { gaps, bbrByBfe };

    const addrData: Record<
      string,
      {
        adresse: string | null;
        postnr: string | null;
        by: string | null;
        dawaId: string | null;
      }
    > = await res.json();

    // Hent BBR-detaljer for hver ejendom
    for (const match of ejendomMatches) {
      const bfe = match.aktiv.bfe!;
      const policy = match.bestMatch!.policy;

      try {
        const addrInfo = addrData[String(bfe)];
        if (!addrInfo?.dawaId) continue;

        const bbrRes = await fetch(`${host}/api/ejendom/${addrInfo.dawaId}`, {
          headers: { cookie },
          signal: AbortSignal.timeout(8_000),
        });
        if (!bbrRes.ok) continue;

        const bbrData = await bbrRes.json();
        const bygning = bbrData?.bygninger?.[0];

        if (bygning) {
          const bbrFacts: BbrPropertyFacts = {
            bfe: String(bfe),
            matrikel: null,
            bebygget_areal_m2: bygning.bebyggetAreal ?? null,
            antal_etager: bygning.etager ?? null,
            opfoert_aar: bygning.opfoerelsesaar ?? null,
            has_kaelder: bygning.kaelder != null,
            anvendelseskode: bygning.anvendelseskode ?? null,
            anvendelse_label: bygning.anvendelse ?? null,
            tag_materiale_kode: null,
          };
          bbrByBfe.set(bfe, bbrFacts);

          // Kør gap-engine med BBR-fakta
          const engineGaps = runGapEngine({
            policy,
            coverages: [], // Coverages hentes separat
            bbr: bbrFacts,
            asOfDate: new Date(),
            asset: {
              type: 'ejendom',
              vaerdiDkk: match.aktiv.vaerdiDkk,
              byggeaar: bbrFacts.opfoert_aar ?? undefined,
            },
          });

          // Kun tilføj BBR-relaterede gaps (GAP-001, GAP-040)
          for (const gap of engineGaps) {
            if (gap.check_id === 'GAP-001' || gap.check_id === 'GAP-040') {
              gaps.push({
                ...gap,
                riskScore: computeRiskScore(gap, {
                  type: 'ejendom',
                  byggeaar: bbrFacts.opfoert_aar ?? undefined,
                }),
                policyId: policy.id,
              });
            }
          }
        }
      } catch (err) {
        logger.warn(`[crossChecks] BBR fetch for BFE ${bfe} fejlede:`, err);
      }
    }
  } catch (err) {
    logger.warn('[crossChecks] BBR batch-fetch fejlede:', err);
  }

  return { gaps, bbrByBfe };
}

/**
 * BIZZ-1370: Hent hæftelser fra tinglysning og tjek mod police-sum.
 * Detekterer GAP-102 (realkredit-gab).
 *
 * @param matches - Match-resultater fra assetMatcher
 * @param host - Request host
 * @param cookie - Auth cookie
 * @returns Hæftelser-map + gaps
 */
export async function runTinglysningCrossCheck(
  matches: MatchResult[],
  host: string,
  cookie: string
): Promise<{ gaps: CrossCheckResult['gaps']; haeftelserByBfe: Map<number, number> }> {
  const gaps: CrossCheckResult['gaps'] = [];
  const haeftelserByBfe = new Map<number, number>();

  const ejendomMatches = matches.filter(
    (m) => m.aktiv.type === 'ejendom' && m.aktiv.bfe && m.bestMatch
  );

  for (const match of ejendomMatches.slice(0, 10)) {
    const bfe = match.aktiv.bfe!;
    const policy = match.bestMatch!.policy;

    try {
      const res = await fetch(`${host}/api/tinglysning?bfe=${bfe}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;

      const data = await res.json();
      const haeftelser = data?.haeftelser ?? [];
      const totalHaeftelser = haeftelser.reduce(
        (sum: number, h: { beloeb?: number }) => sum + (h.beloeb ?? 0),
        0
      );

      if (totalHaeftelser > 0) {
        haeftelserByBfe.set(bfe, totalHaeftelser);

        // Tjek om hæftelser > police-sum
        if (policy.sum_insured_dkk && totalHaeftelser > policy.sum_insured_dkk) {
          gaps.push({
            check_id: 'GAP-102',
            category: 'realkredit',
            severity: 'critical',
            title: 'Hæftelser overstiger forsikringssum',
            description: `Tinglyste hæftelser (${Math.round(totalHaeftelser / 1000)}k DKK) overstiger forsikringssummen (${Math.round(policy.sum_insured_dkk / 1000)}k DKK).`,
            recommendation: 'Forhøj forsikringssummen til mindst hæftelsesbeløbet.',
            estimated_impact_dkk: totalHaeftelser - policy.sum_insured_dkk,
            source_data: { bfe, haeftelser: totalHaeftelser, insured: policy.sum_insured_dkk },
            riskScore: 70,
            policyId: policy.id,
          });
        }
      }
    } catch (err) {
      logger.warn(`[crossChecks] Tinglysning for BFE ${bfe} fejlede:`, err);
    }
  }

  return { gaps, haeftelserByBfe };
}

/**
 * BIZZ-1371: Sammenlign vurdering med police-sum.
 * Flagger info hvis vurdering > police × 1.5.
 *
 * @param matches - Match-resultater
 * @param host - Request host
 * @param cookie - Auth cookie
 * @returns Vurdering-map + gaps
 */
export async function runVurCrossCheck(
  matches: MatchResult[],
  host: string,
  cookie: string
): Promise<{ gaps: CrossCheckResult['gaps']; vurderingByBfe: Map<number, number> }> {
  const gaps: CrossCheckResult['gaps'] = [];
  const vurderingByBfe = new Map<number, number>();

  const ejendomMatches = matches.filter(
    (m) => m.aktiv.type === 'ejendom' && m.aktiv.bfe && m.bestMatch
  );

  for (const match of ejendomMatches.slice(0, 10)) {
    const bfe = match.aktiv.bfe!;
    const policy = match.bestMatch!.policy;

    try {
      const res = await fetch(`${host}/api/vurdering?bfeNummer=${bfe}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;

      const data = await res.json();
      const vurdering = data?.vurdering?.ejendomsvaerdi ?? null;

      if (vurdering && vurdering > 0) {
        vurderingByBfe.set(bfe, vurdering);

        // Flag hvis vurdering > police × 1.5
        if (policy.sum_insured_dkk && vurdering > policy.sum_insured_dkk * 1.5) {
          gaps.push({
            check_id: 'GAP-104',
            category: 'underforsikret',
            severity: 'info',
            title: 'Offentlig vurdering væsentligt højere end forsikringssum',
            description: `Ejendomsvurdering (${Math.round(vurdering / 1000)}k DKK) er over 50% højere end forsikringssummen (${Math.round(policy.sum_insured_dkk / 1000)}k DKK). Mulig underforsikring.`,
            recommendation: 'Verificér at forsikringssummen matcher ejendommens reelle nyværdi.',
            estimated_impact_dkk: vurdering - policy.sum_insured_dkk,
            source_data: { bfe, vurdering, insured: policy.sum_insured_dkk },
            riskScore: 25,
            policyId: policy.id,
          });
        }
      }
    } catch (err) {
      logger.warn(`[crossChecks] VUR for BFE ${bfe} fejlede:`, err);
    }
  }

  return { gaps, vurderingByBfe };
}

/**
 * BIZZ-1372: Klyngerisiko — flag geografisk koncentration.
 *
 * @param aktiver - Alle aktiver
 * @param matches - Match-resultater
 * @returns Gaps for klyngerisiko
 */
export function detectKlyngerisiko(
  aktiver: Aktiv[],
  matches: MatchResult[]
): CrossCheckResult['gaps'] {
  const gaps: CrossCheckResult['gaps'] = [];

  // Gruppér efter postnummer
  const postnrSums = new Map<string, number>();
  let totalInsured = 0;

  for (const match of matches) {
    if (!match.bestMatch?.policy.sum_insured_dkk) continue;
    const sum = match.bestMatch.policy.sum_insured_dkk;
    totalInsured += sum;

    const adresse = match.aktiv.adresse ?? match.bestMatch.policy.property_address ?? '';
    const postnrMatch = adresse.match(/(\d{4})/);
    if (postnrMatch) {
      const postnr = postnrMatch[1];
      postnrSums.set(postnr, (postnrSums.get(postnr) ?? 0) + sum);
    }
  }

  if (totalInsured === 0) return gaps;

  // Flag hvis > 50% af total sum er i ét postnummer
  for (const [postnr, sum] of postnrSums) {
    const pct = (sum / totalInsured) * 100;
    if (pct > 50 && postnrSums.size > 1) {
      gaps.push({
        check_id: 'GAP-105',
        category: 'klyngerisiko',
        severity: 'warning',
        title: `Geografisk koncentration: ${Math.round(pct)}% i postnr ${postnr}`,
        description: `Over halvdelen af den samlede forsikringssum (${Math.round(sum / 1_000_000)}M DKK af ${Math.round(totalInsured / 1_000_000)}M DKK) er koncentreret i postnummer ${postnr}. Ved en storskade (brand, oversvømmelse) rammes en uforholdsmæssig stor del af porteføljen.`,
        recommendation:
          'Overvej geografisk spredning af ejendomsporteføljen eller tegn katastrofedækning.',
        estimated_impact_dkk: sum,
        source_data: { postnr, sum, totalInsured, pct: Math.round(pct) },
        riskScore: 35,
        policyId: matches[0]?.bestMatch?.policy.id ?? '',
      });
    }
  }

  return gaps;
}

/**
 * BIZZ-1373: Restaurant-køkken-krav tjekliste.
 *
 * @param aktiver - Alle aktiver
 * @param matches - Match-resultater
 * @returns Info-gaps for restaurant-krav
 */
export function detectRestaurantKrav(
  aktiver: Aktiv[],
  matches: MatchResult[]
): CrossCheckResult['gaps'] {
  const gaps: CrossCheckResult['gaps'] = [];

  for (const match of matches) {
    if (!match.bestMatch) continue;
    const policy = match.bestMatch.policy;

    // Tjek om branche er restaurant
    const branche = [policy.business_activity, policy.building_use]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const isRestaurant =
      branche.includes('restaurant') || branche.includes('café') || branche.includes('kantine');

    if (!isRestaurant) continue;

    gaps.push({
      check_id: 'GAP-106',
      category: 'restaurant_krav',
      severity: 'info',
      title: 'Restaurant/café — særlige krav til brandsikring',
      description:
        'Ejendommen bruges til restaurant/café. Forsikringsbetingelserne kræver typisk: fedthåndslukker ved friturer, CO2-slukker, brandtæppe, emfang-rensning min. 2x/år, automatisk slukning over friturer.',
      recommendation:
        'Verificér at alle brand- og sikkerhedskrav er opfyldt og dokumenteret. Manglende dokumentation kan medføre afvisning ved skade.',
      estimated_impact_dkk: null,
      source_data: { branche, address: policy.property_address },
      riskScore: 20,
      policyId: policy.id,
    });
  }

  return gaps;
}

/**
 * BIZZ-1374: D&O, Cyber og Driftstab anbefalinger.
 *
 * @param aktiver - Alle aktiver
 * @param matches - Match-resultater
 * @returns Warning-gaps for manglende standardforsikringer
 */
export function detectAnbefalinger(
  aktiver: Aktiv[],
  matches: MatchResult[]
): CrossCheckResult['gaps'] {
  const gaps: CrossCheckResult['gaps'] = [];

  const hasAS = aktiver.some(
    (a) => a.type === 'bestyrelsespost' && a.rawData?.virksomhedsform === 'A/S'
  );
  const hasAnsatte = aktiver.some((a) => a.type === 'virksomhed' && a.ansatte && a.ansatte > 0);
  const hasUdlejning = matches.some((m) => {
    const ba = m.bestMatch?.policy.business_activity?.toLowerCase() ?? '';
    return ba.includes('udlejning') || ba.includes('rental');
  });

  // Tjek om der allerede er D&O, Cyber, Driftstab policer
  const policyTexts = matches
    .filter((m) => m.bestMatch)
    .map((m) =>
      [m.bestMatch!.policy.business_activity, JSON.stringify(m.bestMatch!.policy.raw_metadata)]
        .join(' ')
        .toLowerCase()
    );
  const hasDnO = policyTexts.some((t) => t.includes('d&o') || t.includes('directors'));
  const hasCyber = policyTexts.some((t) => t.includes('cyber') || t.includes('gdpr'));
  const hasDriftstab = policyTexts.some(
    (t) => t.includes('driftstab') || t.includes('business interruption')
  );

  const policyId = matches[0]?.bestMatch?.policy.id ?? '';

  if (hasAS && !hasDnO) {
    gaps.push({
      check_id: 'GAP-107',
      category: 'anbefaling',
      severity: 'warning',
      title: 'Anbefaling: D&O-forsikring',
      description:
        'Koncernen har A/S-bestyrelsesposter uden Directors & Officers forsikring. Bestyrelsesmedlemmer hæfter personligt for beslutninger.',
      recommendation: 'Tegn D&O-forsikring. Typisk pris: 15.000-50.000 kr/år for SMV.',
      estimated_impact_dkk: null,
      source_data: { reason: 'A/S bestyrelse uden D&O' },
      riskScore: 45,
      policyId,
    });
  }

  if (hasAnsatte && !hasCyber) {
    gaps.push({
      check_id: 'GAP-108',
      category: 'anbefaling',
      severity: 'info',
      title: 'Anbefaling: Cyber/GDPR-forsikring',
      description:
        'Koncernen har ansatte og håndterer sandsynligvis persondata. En cyberforsikring dækker databrud, ransomware og GDPR-bøder.',
      recommendation: 'Overvej cyberforsikring. Typisk pris: 5.000-20.000 kr/år for SMV.',
      estimated_impact_dkk: null,
      source_data: { reason: 'Ansatte uden cyber-police' },
      riskScore: 20,
      policyId,
    });
  }

  if (hasUdlejning && !hasDriftstab) {
    gaps.push({
      check_id: 'GAP-109',
      category: 'anbefaling',
      severity: 'warning',
      title: 'Anbefaling: Driftstabsforsikring',
      description:
        'Koncernen har erhvervsudlejning uden driftstabsforsikring. Ved brand eller vandskade mistes lejeindtægt under genopbygning.',
      recommendation:
        'Tegn driftstabsforsikring der dækker tabt lejeindtægt i genopbygningsperioden.',
      estimated_impact_dkk: null,
      source_data: { reason: 'Udlejning uden driftstab' },
      riskScore: 40,
      policyId,
    });
  }

  return gaps;
}
