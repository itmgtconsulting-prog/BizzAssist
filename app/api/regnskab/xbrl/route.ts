/**
 * GET /api/regnskab/xbrl?cvr=XXXXXXXX
 *
 * Henter og parser XBRL-regnskabsdata for et CVR-nummer.
 * Fetcher XML-dokumenter fra regnskaber.virk.dk og udtager nøgletal
 * via kendte danske XBRL-taxonomi-tags (fsa/gsd).
 *
 * @param cvr - 8-cifret CVR-nummer
 * @returns { years: RegnskabsAar[], error?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Resultatopgørelse — income statement */
export interface Resultatopgoerelse {
  omsaetning: number | null;
  bruttofortjeneste: number | null;
  personaleomkostninger: number | null;
  afskrivninger: number | null;
  resultatFoerSkat: number | null;
  skatAfAaretsResultat: number | null;
  aaretsResultat: number | null;
  finansielleIndtaegter: number | null;
  finansielleOmkostninger: number | null;
  eksterneOmkostninger: number | null;
  driftsomkostninger: number | null;
}

/** Balance — balance sheet */
export interface Balance {
  aktiverIAlt: number | null;
  anlaegsaktiverIAlt: number | null;
  omsaetningsaktiverIAlt: number | null;
  egenkapital: number | null;
  gaeldsforpligtelserIAlt: number | null;
  kortfristetGaeld: number | null;
  langfristetGaeld: number | null;
  selskabskapital: number | null;
  overfoertResultat: number | null;
  likvideBeholdninger: number | null;
  vaerdipapirer: number | null;
  grundeOgBygninger: number | null;
  materielleAnlaeg: number | null;
  investeringsejendomme: number | null;
}

/**
 * Pengestrømsopgørelse — cash flow statement (BIZZ-517a).
 *
 * Hentes via fsa: + ifrs-full: tags. Alle felter er nullable da mange
 * små selskaber ikke aflægger pengestrømsopgørelse (kun krævet for
 * regnskabsklasse C+).
 */
export interface Pengestroemme {
  /** Pengestrømme fra driftsaktivitet (operating activities) */
  fraDrift: number | null;
  /** Pengestrømme fra investeringsaktivitet (investing activities) — typisk negativ */
  fraInvestering: number | null;
  /** Pengestrømme fra finansieringsaktivitet (financing activities) */
  fraFinansiering: number | null;
  /** Årets samlede ændring i likvider */
  aaretsForskydning: number | null;
  /** Likvider primo (start af perioden) */
  likviderPrimo: number | null;
  /** Likvider ultimo (slut af perioden) */
  likviderUltimo: number | null;
}

/**
 * Revisor + revisionspåtegning — auditor info (BIZZ-559).
 *
 * Hentes via cmn:/arr: tags. Alle felter er nullable da små regnskabsklasse B-
 * selskaber kan have fravalgt revision, og fordi forskellige taksonomier bruger
 * forskellige felter (sustainability-revisor for ESG-rapporter etc.).
 */
export interface Revisor {
  /** Revisionsfirmaets navn (fx "PricewaterhouseCoopers Statsautoriseret Revisionspartnerselskab") */
  firmanavn: string | null;
  /** Revisionsfirmaets CVR-nummer (8 cifre, link til virksomhedsside) */
  firmaCvr: string | null;
  /** Underskrivende revisors navn */
  revisorNavn: string | null;
  /** Revisorens MNE-nummer (Member Number i Erhvervsstyrelsen) */
  revisorMNE: string | null;
  /** Underskriftssted (by) */
  signaturSted: string | null;
  /** Underskriftsdato (ISO format YYYY-MM-DD) */
  signaturDato: string | null;
  /** True hvis revisor har afgivet modificeret konklusion (forbehold) */
  harForbehold: boolean;
  /** Type forbehold hvis modificeret (fx "QualifiedOpinion", "AdverseOpinion") */
  forbeholdType: string | null;
}

/** Beregnede nøgletal — calculated key ratios */
export interface Noegletal {
  // ── Rentabilitet ──
  afkastningsgrad: number | null;
  soliditetsgrad: number | null;
  egenkapitalensForrentning: number | null;
  overskudsgrad: number | null;
  bruttomargin: number | null;
  ebitMargin: number | null;
  roic: number | null;
  // ── Likviditet ──
  likviditetsgrad: number | null;
  // ── Effektivitet ──
  aktivernesOmsaetningshastighed: number | null;
  omsaetningPrAnsat: number | null;
  resultatPrAnsat: number | null;
  // ── Kapitalstruktur ──
  finansielGearing: number | null;
  nettoGaeld: number | null;
  // ── Øvrige ──
  antalAnsatte: number | null;
}

/**
 * BIZZ-560: Tekst-noter fra årsregnskabet (HTML-strippet til ren tekst).
 * Alle felter er nullable — XBRL-noter er ikke obligatoriske og mange små
 * selskaber undlader dem helt.
 */
export interface RegnskabNoter {
  /** Virksomhedens formål / hovedaktivitet */
  formaal: string | null;
  /** Anvendt regnskabspraksis */
  regnskabspraksis: string | null;
  /** Begivenheder efter balancedagen */
  begivenhederEfterBalancedag: string | null;
  /** Going concern-vurdering */
  goingConcern: string | null;
}

/** Et regnskabsår med alle data */
export interface RegnskabsAar {
  /** Regnskabsår (f.eks. 2024) */
  aar: number;
  /** Regnskabsperiode start (ISO) */
  periodeStart: string;
  /** Regnskabsperiode slut (ISO) */
  periodeSlut: string;
  /** Resultatopgørelse */
  resultat: Resultatopgoerelse;
  /** Balance */
  balance: Balance;
  /** Beregnede nøgletal */
  noegletal: Noegletal;
  /** BIZZ-517a: Pengestrømsopgørelse (null hvis selskabet ikke aflægger en) */
  pengestroemme: Pengestroemme | null;
  /** BIZZ-559: Revisor + revisionspåtegning (null hvis revision fravalgt) */
  revisor: Revisor | null;
  /** BIZZ-560: Note-tekstblokke (formål, praksis, begivenheder, going concern) */
  noter: RegnskabNoter | null;
}

/** Response shape */
export interface RegnskabXbrlResponse {
  years: RegnskabsAar[];
  /** Totalt antal XBRL-regnskaber tilgængelige (for progressiv hentning) */
  total: number;
  error?: string;
}

// ─── XBRL Tag Mappings ───────────────────────────────────────────────────────

/**
 * Kendte XBRL-tags fra danske årsregnskabslov (fsa) og IFRS-taksonomi.
 * Tag-navne er uden namespace og matches case-insensitivt.
 */

/** Resultatopgørelse tags (fsa + IFRS) */
const RESULTAT_TAGS: Record<keyof Resultatopgoerelse, string[]> = {
  omsaetning: ['Revenue', 'Nettoomsaetning'],
  bruttofortjeneste: ['GrossProfitLoss', 'GrossProfit'],
  personaleomkostninger: ['EmployeeBenefitsExpense', 'StaffCosts'],
  afskrivninger: [
    'DepreciationAmortisationExpenseAndImpairmentLossesOfPropertyPlantAndEquipmentAndIntangibleAssetsRecognisedInProfitOrLoss',
    'DepreciationAmortisation',
    'DepreciationAndAmortisationExpense',
  ],
  resultatFoerSkat: [
    'ProfitLossFromOrdinaryActivitiesBeforeTax',
    'ProfitBeforeTax',
    'ProfitLossBeforeTax',
  ],
  skatAfAaretsResultat: [
    'TaxExpenseOnOrdinaryActivities',
    'TaxExpense',
    'IncomeTaxExpense',
    'IncomeTaxExpenseContinuingOperations',
  ],
  aaretsResultat: ['ProfitLoss'],
  finansielleIndtaegter: ['OtherFinanceIncome', 'FinanceIncome'],
  finansielleOmkostninger: ['OtherFinanceExpenses', 'FinanceCosts'],
  eksterneOmkostninger: [
    'ExternalExpenses',
    'OtherExternalExpenses',
    'RawMaterialsAndConsumablesUsed',
  ],
  driftsomkostninger: ['CostOfSales'],
};

/** Balance tags (fsa + IFRS) */
const BALANCE_TAGS: Record<keyof Balance, string[]> = {
  aktiverIAlt: ['Assets'],
  anlaegsaktiverIAlt: ['NoncurrentAssets', 'NonCurrentAssets'],
  omsaetningsaktiverIAlt: ['CurrentAssets'],
  egenkapital: ['Equity'],
  gaeldsforpligtelserIAlt: ['LiabilitiesOtherThanProvisions', 'Liabilities'],
  kortfristetGaeld: ['ShorttermLiabilitiesOtherThanProvisions', 'CurrentLiabilities'],
  langfristetGaeld: ['LongtermLiabilitiesOtherThanProvisions', 'NoncurrentLiabilities'],
  selskabskapital: ['ContributedCapital', 'IssuedCapital'],
  overfoertResultat: ['RetainedEarnings'],
  likvideBeholdninger: ['CashAndCashEquivalents'],
  vaerdipapirer: ['ShorttermInvestments', 'CurrentAssetInvestments'],
  grundeOgBygninger: ['LandAndBuildings'],
  materielleAnlaeg: ['PropertyPlantAndEquipment'],
  investeringsejendomme: ['InvestmentProperty'],
};

/** Nøgletal tags (direkte fra XBRL, ikke beregnede) */
const NOEGLETAL_TAGS: Partial<Record<keyof Noegletal, string[]>> = {
  antalAnsatte: ['AverageNumberOfEmployees', 'NumberOfEmployees'],
};

/**
 * BIZZ-559: Revisor-tags (cmn: + arr: namespace).
 *
 * cmn: = common (basis-info som navn, CVR). arr: = audit-related-report
 * (revisorerklæring, forbehold, key audit matters). Alle tags er text-blokke
 * der ofte indeholder HTML-formateret indhold — vi udtrækker kun rå-tekst
 * eller bool-flags her; sanitering/render er UI'ens ansvar.
 *
 * Bemærk: NameOfAuditFirm er i cmn: namespace, ikke fsa:.
 * Sustainability-varianter (NameOfAuditFirmSubstainability) ignoreres da
 * vi fokuserer på finansiel revisor.
 */
const REVISOR_TEXT_TAGS = {
  firmanavn: ['NameOfAuditFirm'],
  firmaCvr: ['IdentificationNumberCvrOfAuditFirm'],
  revisorNavn: ['NameAndSurnameOfAuditor'],
  revisorMNE: ['IdentificationNumberOfAuditor'],
  signaturSted: ['SignatureOfAuditorsPlace'],
  signaturDato: ['SignatureOfAuditorsDate'],
  forbeholdType: ['TypeOfModifiedOpinionOnAuditedFinancialStatements'],
} as const;

/**
 * BIZZ-560: Note-tekstblokke fra fsa: + ifrs-full: namespace.
 *
 * Tekstblokke er typisk fri-tekst HTML der beskriver virksomhedens formål,
 * regnskabspraksis, begivenheder efter balancedag etc. extractText
 * normaliserer HTML-stripping så vi får ren tekst tilbage.
 *
 * NB: Ingen Substainability-varianter — fokus er finansielle noter.
 */
const NOTER_TEXT_TAGS = {
  /** Virksomhedens hovedaktivitet/formål */
  formaal: [
    'DescriptionOfPrincipalActivities',
    'DescriptionOfActivities',
    'DescriptionOfNatureOfEntitysOperationsAndPrincipalActivities',
  ],
  /** Anvendt regnskabspraksis */
  regnskabspraksis: [
    'DisclosureOfAccountingPolicies',
    'DescriptionOfAccountingPolicies',
    'DisclosureOfSummaryOfSignificantAccountingPoliciesExplanatory',
  ],
  /** Begivenheder efter balancedagen */
  begivenhederEfterBalancedag: [
    'InformationAboutSubsequentEvents',
    'DisclosureOfNonadjustingEventsAfterReportingPeriodExplanatory',
    'DisclosureOfEventsAfterReportingPeriodExplanatory',
  ],
  /** Going concern-vurdering */
  goingConcern: ['InformationOnGoingConcernAssumption', 'DisclosureOfGoingConcernExplanatory'],
} as const;

/**
 * BIZZ-517a: Pengestrøm-tags (fsa + IFRS-taksonomi).
 *
 * fsa-tags følger Danish FSA taxonomy fra Erhvervsstyrelsen — bruges af
 * små/mellemstore danske selskaber. ifrs-full-tags bruges af børsnoterede
 * og store selskaber der aflægger regnskab efter IFRS.
 *
 * Alle tags er duration-context (regnskabsperioden), undtagen
 * likviderPrimo + likviderUltimo som er instant-context (pr. dato).
 */
const PENGESTROM_TAGS: Record<keyof Pengestroemme, string[]> = {
  fraDrift: [
    'CashFlowsFromUsedInOperatingActivities',
    'CashFlowsFromOperatingActivities',
    'CashFlowFromOperatingActivities',
    'NetCashFlowsFromUsedInOperatingActivities',
  ],
  fraInvestering: [
    'CashFlowsFromUsedInInvestingActivities',
    'CashFlowsFromInvestingActivities',
    'CashFlowFromInvestingActivities',
    'NetCashFlowsFromUsedInInvestingActivities',
  ],
  fraFinansiering: [
    'CashFlowsFromUsedInFinancingActivities',
    'CashFlowsFromFinancingActivities',
    'CashFlowFromFinancingActivities',
    'NetCashFlowsFromUsedInFinancingActivities',
  ],
  aaretsForskydning: [
    'IncreaseDecreaseInCashAndCashEquivalents',
    'IncreaseDecreaseInCashAndCashEquivalentsBeforeEffectOfExchangeRateChanges',
    'CashFlowForPeriodIncreaseDecrease',
  ],
  likviderPrimo: [
    'CashAndCashEquivalentsAtBeginningOfPeriod',
    'CashAndCashEquivalentsBeginningOfPeriod',
  ],
  likviderUltimo: [
    'CashAndCashEquivalentsAtEndOfPeriod',
    'CashAndCashEquivalentsEndOfPeriod',
    // Fallback til Balance-tag hvis pengestrøm-specifikt ultimo mangler
    'CashAndCashEquivalents',
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parser XBRL contexts og bygger en map fra context-id til periode.
 * Returnerer også de context-ids der matcher regnskabsperioden
 * (for resultatopgørelse = duration-context, for balance = instant-context).
 */
function parseContexts(xml: string, periodeStart: string, periodeSlut: string) {
  /** Context-ids for duration-perioden (resultatopgørelse) — uden dimensioner */
  const durationCtxIds = new Set<string>();
  /** Context-ids for instant = periodeSlut (balance) — uden dimensioner */
  const instantCtxIds = new Set<string>();

  // Match contexts (multiline) — standard XBRL format
  const ctxRegex = /<xbrli:context\s+id="([^"]*)">([\s\S]*?)<\/xbrli:context>/gi;
  let m: RegExpExecArray | null;
  while ((m = ctxRegex.exec(xml)) !== null) {
    const id = m[1];
    const body = m[2];
    // Skip contexts med dimensioner (bestyrelse, revisorer, etc.)
    // Undtagen ConsolidatedSoloDimension som bruges i IFRS-koncernregnskaber
    const hasDim = /xbrldi:explicitMember|xbrldi:typedMember/i.test(body);
    if (hasDim) {
      const isConsolidated = /ConsolidatedMember|ConsolidatedSoloDimension/i.test(body);
      if (!isConsolidated) continue;
    }

    const startMatch = body.match(/<xbrli:startDate>([^<]+)/);
    const endMatch = body.match(/<xbrli:endDate>([^<]+)/);
    const instantMatch = body.match(/<xbrli:instant>([^<]+)/);

    if (startMatch && endMatch) {
      if (startMatch[1] === periodeStart && endMatch[1] === periodeSlut) {
        durationCtxIds.add(id);
      }
    } else if (instantMatch) {
      if (instantMatch[1] === periodeSlut) {
        instantCtxIds.add(id);
      }
    }
  }

  return { durationCtxIds, instantCtxIds };
}

/**
 * Udtager en numerisk værdi fra XBRL for et tag-navn, filtreret på context-ref.
 * Understøtter:
 * - Standard XBRL: <fsa:Tag contextRef="ctx1">123</fsa:Tag>
 * - iXBRL inline: <ix:nonFraction name="fsa:Tag" contextRef="ctx1">123</ix:nonFraction>
 *
 * @param xml - Rå XBRL/iXBRL-streng
 * @param tagNames - Mulige tag-navne at søge efter (uden namespace)
 * @param validCtxIds - Gyldige context-refs (tomme = accepter alle)
 */
function extractValue(xml: string, tagNames: string[], validCtxIds?: Set<string>): number | null {
  for (const tag of tagNames) {
    // Alle matches for dette tag — vi vælger den med korrekt context
    const patterns: Array<{ re: RegExp; attrsGroup: number; valGroup: number }> = [
      // Standard XBRL: <ns:Tag contextRef="..." ...>value</ns:Tag>
      {
        re: new RegExp(`<[a-z-]+:${tag}\\s+([^>]*)>([^<]+)<\\/[a-z-]+:${tag}>`, 'gi'),
        attrsGroup: 1,
        valGroup: 2,
      },
      // Without namespace: <Tag ...>value</Tag>
      { re: new RegExp(`<${tag}\\s+([^>]*)>([^<]+)<\\/${tag}>`, 'gi'), attrsGroup: 1, valGroup: 2 },
      // iXBRL: <ix:nonFraction ...name="...:Tag"...>value</ix:nonFraction>
      // Fanger ALLE attributter i hele taget (inkl. format, scale, decimals)
      {
        re: new RegExp(`<ix:nonFraction\\s+([^>]*name="[^"]*:${tag}"[^>]*)>([^<]+)<`, 'gi'),
        attrsGroup: 1,
        valGroup: 2,
      },
    ];

    for (const { re, attrsGroup, valGroup } of patterns) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(xml)) !== null) {
        const attrs = match[attrsGroup];
        const rawVal = match[valGroup];

        // Check context-ref hvis vi har gyldige ids
        if (validCtxIds && validCtxIds.size > 0) {
          const ctxMatch = attrs.match(/contextRef="([^"]*)"/i);
          if (!ctxMatch || !validCtxIds.has(ctxMatch[1])) continue;
        }

        // Parse numerisk værdi
        // iXBRL "ixt:num-dot-decimal": punkt er decimal, komma er tusindtals
        // iXBRL "ixt:num-comma-decimal": komma er decimal, punkt er tusindtals
        // Standard XBRL: tal i ren numerisk form (evt. med tusindtals-kommaer)
        const format = attrs.match(/format="([^"]*)"/i)?.[1] ?? '';
        let cleaned: string;
        if (/num-comma-decimal/i.test(format)) {
          // Komma = decimal, punkt = tusindtals (EU)
          cleaned = rawVal.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
        } else {
          // num-dot-decimal (standard) + standard XBRL: komma = tusindtals, punkt = decimal
          cleaned = rawVal.trim().replace(/\s/g, '').replace(/,/g, '');
        }
        const num = parseFloat(cleaned);
        if (!isNaN(num)) {
          // Beregn reel DKK-værdi baseret på iXBRL scale eller standard XBRL decimals
          const scaleMatch = attrs.match(/scale="(-?\d+)"/);
          const scale = scaleMatch ? parseInt(scaleMatch[1], 10) : 0;
          const hasScale = scaleMatch !== null;
          // BIZZ-449: Standard XBRL bruger decimals-attribut til at angive enhed
          // decimals="-3" → tusinder, decimals="-6" → millioner, "INF"/0 → hele DKK
          const decimalsMatch = attrs.match(/decimals="(-?\d+|INF)"/i);
          let dkkValue: number;

          if (hasScale && scale > 0) {
            // iXBRL med scale > 0: visuelt tal × 10^scale = DKK
            // F.eks. scale="6" + 154944 = 154944 × 10^6 = 154,944,000,000 DKK
            dkkValue = num * Math.pow(10, scale);
          } else if (hasScale && scale === 0 && num > 0 && num < 10_000_000) {
            // iXBRL scale="0" med relativt små tal (< 10M):
            // Sandsynligvis i millioner DKK (visuel display-enhed ikke i XBRL).
            // Heuristik: hvis scale=0 men tal < 10M, antag millioner.
            dkkValue = num * 1_000_000;
          } else if (decimalsMatch && decimalsMatch[1] !== 'INF') {
            // BIZZ-449: Standard XBRL med decimals-attribut (mest almindelig for danske SMB'er)
            // decimals="-3" → værdi er i tusinder → gang med 1.000
            const d = parseInt(decimalsMatch[1], 10);
            dkkValue = d < 0 ? num * Math.pow(10, -d) : num;
          } else {
            // Standard XBRL uden scale/decimals: tal er i hele DKK
            dkkValue = num;
          }
          // BIZZ-435: Return hele DKK — UI formatter selv med toLocaleString
          return Math.round(dkkValue);
        }
      }
    }
  }
  return null;
}

/**
 * BIZZ-559: Udtager en TEKST-værdi fra XBRL for et tag-navn.
 *
 * Handles both standard XBRL (<ns:Tag>text</ns:Tag>) og iXBRL inline
 * (<ix:nonNumeric name="ns:Tag">text</ix:nonNumeric>). Bruges til
 * revisor-info, noter, og andre ikke-numeriske felter.
 *
 * Vi accepterer ALLE contexts (ingen filter) — revisor-info bruger ofte
 * dimensions for primary auditor vs sustainability auditor og en separat
 * audit-context der ikke matcher regnskabs-perioden. Vi tager den FØRSTE
 * non-Substainability variant så vi får hovedrevisoren.
 *
 * @param xml - Rå XBRL/iXBRL-streng
 * @param tagNames - Mulige tag-navne at søge efter (uden namespace)
 */
function extractText(xml: string, tagNames: readonly string[]): string | null {
  for (const tag of tagNames) {
    // Skip Substainability-varianter eksplicit — de er ESG-revisor, ikke
    // den finansielle hovedrevisor som dette ticket dækker
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // BIZZ-559 v3 (BIZZ-562 fix): ESEF iXBRL kan inkludere SAMME tag flere
    // gange — typisk:
    //   - en TRUNCATED version med continuedAt-attribut (visible HTML chunk)
    //   - en FULD version (hidden complete value, ofte i ix:hidden-section)
    // Tidligere returnerede vi første match → fik truncated. Nu samler vi
    // ALLE matches og returnerer den længste (= den fulde værdi).
    const patterns: RegExp[] = [
      // Standard XBRL: <ns:Tag attrs>text</ns:Tag>
      new RegExp(`<[a-z-]+:${escapedTag}\\s+[^>]*>([\\s\\S]*?)<\\/[a-z-]+:${escapedTag}>`, 'gi'),
      // iXBRL nonNumeric: <ix:nonNumeric name="ns:Tag" ...>text</ix:nonNumeric>
      new RegExp(
        `<ix:nonNumeric\\s+[^>]*name="[^"]*:${escapedTag}"[^>]*>([\\s\\S]*?)<\\/ix:nonNumeric>`,
        'gi'
      ),
      // iXBRL nonFraction (CVR-numre etc.) — bruger closing tag for at få fuld bredde
      new RegExp(
        `<ix:nonFraction\\s+[^>]*name="[^"]*:${escapedTag}"[^>]*>([\\s\\S]*?)<\\/ix:nonFraction>`,
        'gi'
      ),
    ];
    let longestText: string | null = null;
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        if (!m[1]) continue;
        const text = normaliseInline(m[1]);
        if (!text) continue;
        if (longestText == null || text.length > longestText.length) {
          longestText = text;
        }
      }
    }
    if (longestText) return longestText;
  }
  return null;
}

/**
 * BIZZ-559 v2: Normaliserer en text-værdi der kan indeholde inline HTML
 * fra ESEF iXBRL (span, br, &nbsp;). Stripper alle tags og dekoder de
 * mest almindelige HTML-entities + numeriske character references.
 */
function normaliseInline(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '') // strip all HTML tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parser XBRL XML og returnerer strukturerede regnskabsdata.
 *
 * @param xml - Rå XBRL XML-streng
 * @param periodeStart - Regnskabsperiodens start (ISO)
 * @param periodeSlut - Regnskabsperiodens slut (ISO)
 */
function parseXbrl(xml: string, periodeStart: string, periodeSlut: string): RegnskabsAar | null {
  const aar = new Date(periodeSlut).getFullYear();
  if (isNaN(aar)) return null;

  // Parser contexts for at finde de rigtige context-refs
  const { durationCtxIds, instantCtxIds } = parseContexts(xml, periodeStart, periodeSlut);

  // Resultat-tags bruger duration-context, balance bruger instant-context.
  // Hvis ingen contexts fundet (simpel XBRL uden contexts), fald tilbage til at acceptere alle.
  const durCtx = durationCtxIds.size > 0 ? durationCtxIds : undefined;
  const instCtx = instantCtxIds.size > 0 ? instantCtxIds : undefined;
  // For tags der kan forekomme i begge (f.eks. antal ansatte): prøv duration først
  const anyCtx = durCtx ?? instCtx;

  // Resultatopgørelse (duration-context)
  const resultat: Resultatopgoerelse = {
    omsaetning: extractValue(xml, RESULTAT_TAGS.omsaetning, durCtx),
    bruttofortjeneste: extractValue(xml, RESULTAT_TAGS.bruttofortjeneste, durCtx),
    personaleomkostninger: extractValue(xml, RESULTAT_TAGS.personaleomkostninger, durCtx),
    afskrivninger: extractValue(xml, RESULTAT_TAGS.afskrivninger, durCtx),
    resultatFoerSkat: extractValue(xml, RESULTAT_TAGS.resultatFoerSkat, durCtx),
    skatAfAaretsResultat: extractValue(xml, RESULTAT_TAGS.skatAfAaretsResultat, durCtx),
    aaretsResultat: extractValue(xml, RESULTAT_TAGS.aaretsResultat, durCtx),
    finansielleIndtaegter: extractValue(xml, RESULTAT_TAGS.finansielleIndtaegter, durCtx),
    finansielleOmkostninger: extractValue(xml, RESULTAT_TAGS.finansielleOmkostninger, durCtx),
    eksterneOmkostninger: extractValue(xml, RESULTAT_TAGS.eksterneOmkostninger, durCtx),
    driftsomkostninger: extractValue(xml, RESULTAT_TAGS.driftsomkostninger, durCtx),
  };

  // Balance (instant-context = pr. ultimodato)
  const balance: Balance = {
    aktiverIAlt: extractValue(xml, BALANCE_TAGS.aktiverIAlt, instCtx),
    anlaegsaktiverIAlt: extractValue(xml, BALANCE_TAGS.anlaegsaktiverIAlt, instCtx),
    omsaetningsaktiverIAlt: extractValue(xml, BALANCE_TAGS.omsaetningsaktiverIAlt, instCtx),
    egenkapital: extractValue(xml, BALANCE_TAGS.egenkapital, instCtx),
    gaeldsforpligtelserIAlt: extractValue(xml, BALANCE_TAGS.gaeldsforpligtelserIAlt, instCtx),
    kortfristetGaeld: extractValue(xml, BALANCE_TAGS.kortfristetGaeld, instCtx),
    langfristetGaeld: extractValue(xml, BALANCE_TAGS.langfristetGaeld, instCtx),
    selskabskapital: extractValue(xml, BALANCE_TAGS.selskabskapital, instCtx),
    overfoertResultat: extractValue(xml, BALANCE_TAGS.overfoertResultat, instCtx),
    likvideBeholdninger: extractValue(xml, BALANCE_TAGS.likvideBeholdninger, instCtx),
    vaerdipapirer: extractValue(xml, BALANCE_TAGS.vaerdipapirer, instCtx),
    grundeOgBygninger: extractValue(xml, BALANCE_TAGS.grundeOgBygninger, instCtx),
    materielleAnlaeg: extractValue(xml, BALANCE_TAGS.materielleAnlaeg, instCtx),
    investeringsejendomme: extractValue(xml, BALANCE_TAGS.investeringsejendomme, instCtx),
  };

  // BIZZ-517a: Pengestrømsopgørelse.
  // fraDrift/Investering/Finansiering + aaretsForskydning er duration-context.
  // likviderPrimo/Ultimo er instant-context (start/slut af perioden).
  const pengestroemmeRaw: Pengestroemme = {
    fraDrift: extractValue(xml, PENGESTROM_TAGS.fraDrift, durCtx),
    fraInvestering: extractValue(xml, PENGESTROM_TAGS.fraInvestering, durCtx),
    fraFinansiering: extractValue(xml, PENGESTROM_TAGS.fraFinansiering, durCtx),
    aaretsForskydning: extractValue(xml, PENGESTROM_TAGS.aaretsForskydning, durCtx),
    likviderPrimo: extractValue(xml, PENGESTROM_TAGS.likviderPrimo, instCtx),
    likviderUltimo: extractValue(xml, PENGESTROM_TAGS.likviderUltimo, instCtx),
  };
  // Hvis ALLE pengestrøm-felter er null, har selskabet ikke aflagt en pengestrømsopgørelse
  // (typisk små regnskabsklasse B-selskaber). Returnér null så UI kan skjule sektionen.
  const harPengestroem = Object.values(pengestroemmeRaw).some((v) => v != null);
  const pengestroemme: Pengestroemme | null = harPengestroem ? pengestroemmeRaw : null;

  // BIZZ-559: Revisor + revisionspåtegning.
  // Tags ligger typisk i en separat audit-context (ikke regnskabs-perioden) så
  // vi accepterer ALLE contexts via extractText. Trim trailing tegn (komma etc.)
  // som nogle ESEF-renderers tilføjer.
  const trim = (s: string | null) => s?.replace(/[\s,;.]+$/, '').trim() || null;
  // BIZZ-559 v2: CVR-numre kan have whitespace fra ESEF iXBRL spans (fx "30 700228").
  // Strip alt whitespace så vi får ren 8-cifret string til /companies/{cvr}-link.
  const cvrClean = (s: string | null) => s?.replace(/\s+/g, '') || null;
  const forbeholdRaw = extractText(xml, REVISOR_TEXT_TAGS.forbeholdType);
  // ESEF-enum-værdier: "Opinion" = ren konklusion (ikke modificeret).
  // Modificerede typer: QualifiedOpinion, AdverseOpinion, DisclaimerOfOpinion.
  const harForbehold =
    forbeholdRaw != null && forbeholdRaw !== '' && !/^opinion$/i.test(forbeholdRaw);
  const revisorRaw: Revisor = {
    firmanavn: trim(extractText(xml, REVISOR_TEXT_TAGS.firmanavn)),
    firmaCvr: cvrClean(extractText(xml, REVISOR_TEXT_TAGS.firmaCvr)),
    revisorNavn: trim(extractText(xml, REVISOR_TEXT_TAGS.revisorNavn)),
    revisorMNE: extractText(xml, REVISOR_TEXT_TAGS.revisorMNE),
    signaturSted: trim(extractText(xml, REVISOR_TEXT_TAGS.signaturSted)),
    signaturDato: extractText(xml, REVISOR_TEXT_TAGS.signaturDato),
    harForbehold,
    forbeholdType: harForbehold ? forbeholdRaw : null,
  };
  // Hvis ingen revisor-felter findes (revision fravalgt eller selskabet er
  // udenlandsk uden dansk revisor-tagging), returnér null så UI skjuler sektionen.
  const harRevisor =
    revisorRaw.firmanavn != null || revisorRaw.revisorNavn != null || revisorRaw.firmaCvr != null;
  const revisor: Revisor | null = harRevisor ? revisorRaw : null;

  // BIZZ-560: Note-tekstblokke (formål, regnskabspraksis, begivenheder, going concern).
  // Brug extractText som allerede håndterer iXBRL HTML-stripping via normaliseInline.
  // Returnér null-objekt når INGEN noter er fundet — UI skjuler hele sektionen.
  const noterRaw: RegnskabNoter = {
    formaal: extractText(xml, NOTER_TEXT_TAGS.formaal),
    regnskabspraksis: extractText(xml, NOTER_TEXT_TAGS.regnskabspraksis),
    begivenhederEfterBalancedag: extractText(xml, NOTER_TEXT_TAGS.begivenhederEfterBalancedag),
    goingConcern: extractText(xml, NOTER_TEXT_TAGS.goingConcern),
  };
  const harNoter = Object.values(noterRaw).some((v) => v != null && v.length > 0);
  const noter: RegnskabNoter | null = harNoter ? noterRaw : null;

  // Nøgletal — direkte fra XBRL + beregnede
  const antalAnsatte = extractValue(xml, NOEGLETAL_TAGS.antalAnsatte ?? [], anyCtx);

  const afkastningsgrad =
    resultat.aaretsResultat != null && balance.aktiverIAlt
      ? (resultat.aaretsResultat / balance.aktiverIAlt) * 100
      : null;
  const soliditetsgrad =
    balance.egenkapital != null && balance.aktiverIAlt
      ? (balance.egenkapital / balance.aktiverIAlt) * 100
      : null;
  const egenkapitalensForrentning =
    resultat.aaretsResultat != null && balance.egenkapital
      ? (resultat.aaretsResultat / balance.egenkapital) * 100
      : null;
  const overskudsgrad =
    resultat.aaretsResultat != null && resultat.omsaetning
      ? (resultat.aaretsResultat / resultat.omsaetning) * 100
      : null;
  const bruttomargin =
    resultat.bruttofortjeneste != null && resultat.omsaetning
      ? (resultat.bruttofortjeneste / resultat.omsaetning) * 100
      : null;

  // EBIT = Resultat før skat + Finansielle omkostninger
  const ebit =
    resultat.resultatFoerSkat != null && resultat.finansielleOmkostninger != null
      ? resultat.resultatFoerSkat + Math.abs(resultat.finansielleOmkostninger)
      : null;

  const ebitMargin =
    ebit != null && resultat.omsaetning ? (ebit / resultat.omsaetning) * 100 : null;

  // Investeret kapital = Aktiver i alt - Kortfristet gæld (operationel)
  const investCapital =
    balance.aktiverIAlt != null && balance.kortfristetGaeld != null
      ? balance.aktiverIAlt - balance.kortfristetGaeld
      : null;

  const roic =
    ebit != null && investCapital && investCapital > 0 ? (ebit / investCapital) * 100 : null;

  // Likviditetsgrad = Omsætningsaktiver / Kortfristet gæld × 100
  const likviditetsgrad =
    balance.omsaetningsaktiverIAlt != null && balance.kortfristetGaeld
      ? (balance.omsaetningsaktiverIAlt / balance.kortfristetGaeld) * 100
      : null;

  // Aktivernes omsætningshastighed = Omsætning / Aktiver i alt
  const aktivernesOmsaetningshastighed =
    resultat.omsaetning != null && balance.aktiverIAlt
      ? resultat.omsaetning / balance.aktiverIAlt
      : null;

  // Omsætning pr. ansat
  const omsaetningPrAnsat =
    resultat.omsaetning != null && antalAnsatte && antalAnsatte > 0
      ? Math.round(resultat.omsaetning / antalAnsatte)
      : null;

  // Resultat pr. ansat
  const resultatPrAnsat =
    resultat.aaretsResultat != null && antalAnsatte && antalAnsatte > 0
      ? Math.round(resultat.aaretsResultat / antalAnsatte)
      : null;

  // Finansiel gearing = Gæld i alt / Egenkapital
  const finansielGearing =
    balance.gaeldsforpligtelserIAlt != null && balance.egenkapital && balance.egenkapital > 0
      ? balance.gaeldsforpligtelserIAlt / balance.egenkapital
      : null;

  // Nettogæld = (Kort + langfristet gæld) - Likvider
  const nettoGaeld =
    balance.gaeldsforpligtelserIAlt != null && balance.likvideBeholdninger != null
      ? balance.gaeldsforpligtelserIAlt - balance.likvideBeholdninger
      : null;

  /** Afrunder til 1 decimal */
  const r1 = (v: number | null): number | null => (v != null ? Math.round(v * 10) / 10 : null);

  const noegletal: Noegletal = {
    afkastningsgrad: r1(afkastningsgrad),
    soliditetsgrad: r1(soliditetsgrad),
    egenkapitalensForrentning: r1(egenkapitalensForrentning),
    overskudsgrad: r1(overskudsgrad),
    bruttomargin: r1(bruttomargin),
    ebitMargin: r1(ebitMargin),
    roic: r1(roic),
    likviditetsgrad: r1(likviditetsgrad),
    aktivernesOmsaetningshastighed: r1(aktivernesOmsaetningshastighed),
    omsaetningPrAnsat,
    resultatPrAnsat,
    finansielGearing: r1(finansielGearing),
    nettoGaeld,
    antalAnsatte,
  };

  return {
    aar,
    periodeStart,
    periodeSlut,
    resultat,
    balance,
    noegletal,
    pengestroemme,
    revisor,
    noter,
  };
}

// ─── Route Handler ────────────────────────────────────────────────────────────

// ─── Supabase cache helpers ─────────────────────────────────────────────────

/**
 * Returns the typed Supabase admin client for cache read/write operations.
 * Returns null if required environment variables are not set.
 *
 * @returns Typed admin client or null when credentials are unavailable
 */
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createAdminClient();
}

// ─── Deduplication helpers ──────────────────────────────────────────────────

/** Tæl udfyldte felter i et RegnskabsAar */
function countFields(y: RegnskabsAar): number {
  let n = 0;
  for (const v of Object.values(y.resultat)) if (v !== null) n++;
  for (const v of Object.values(y.balance)) if (v !== null) n++;
  return n;
}

/** Beregn periodelængde i dage */
function periodeDage(y: RegnskabsAar): number {
  return (new Date(y.periodeSlut).getTime() - new Date(y.periodeStart).getTime()) / 86400000;
}

/**
 * Beregn max absolutværdi af alle monetære felter i et regnskabsår.
 *
 * @param year - Regnskabsår at inspicere
 * @returns Højeste absolutværdi, eller 0 hvis ingen monetære felter
 */
function maksMonetaerVaerdi(year: RegnskabsAar): number {
  const monetaereFelter = [
    ...Object.values(year.resultat),
    ...Object.values(year.balance),
    year.noegletal.nettoGaeld,
    ...(year.pengestroemme ? Object.values(year.pengestroemme) : []),
  ].filter((v): v is number => typeof v === 'number');
  if (monetaereFelter.length === 0) return 0;
  return Math.max(...monetaereFelter.map((v) => Math.abs(v)));
}

/**
 * Divider alle monetære felter i et regnskabsår med 1.000 (fuld DKK → T DKK).
 *
 * @param year - Regnskabsår i fuld DKK
 * @returns Regnskabsår normaliseret til T DKK
 */
function dividerAarMed1000(year: RegnskabsAar): RegnskabsAar {
  const divider = (v: number | null): number | null => (v == null ? v : Math.round(v / 1000));
  const divideAll = (obj: Record<string, number | null>): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = divider(v);
    return out;
  };

  return {
    ...year,
    resultat: divideAll(
      year.resultat as unknown as Record<string, number | null>
    ) as unknown as Resultatopgoerelse,
    balance: divideAll(
      year.balance as unknown as Record<string, number | null>
    ) as unknown as Balance,
    noegletal: {
      ...year.noegletal,
      nettoGaeld: divider(year.noegletal.nettoGaeld),
    },
    pengestroemme: year.pengestroemme
      ? (divideAll(
          year.pengestroemme as unknown as Record<string, number | null>
        ) as unknown as Pengestroemme)
      : null,
  };
}

/**
 * BIZZ-459/466 + BIZZ-1134: Normaliser numeriske felter til T DKK (tusinder).
 *
 * Enkelt-år: Hvis max abs(monetært felt) > 10M → fuld DKK → divider med 1.000.
 * Bruges som fallback for enkeltstående år.
 *
 * @param year - Regnskabsår at normalisere
 * @returns Normaliseret regnskabsår i T DKK
 */
function normaliserTilTDKK(year: RegnskabsAar): RegnskabsAar {
  const maks = maksMonetaerVaerdi(year);
  if (maks === 0 || maks <= 10_000_000) return year;
  return dividerAarMed1000(year);
}

/**
 * BIZZ-1134: Normaliser alle regnskabsår konsistent til T DKK.
 *
 * Når en virksomhed skifter revisor/XBRL-format mellem år, kan ældre år
 * være i fuld DKK mens nyere er i T DKK (eller omvendt). Per-år heuristik
 * fejler for disse tilfælde fordi en lille virksomhed i fuld DKK kan have
 * max < 10M (tærsklen for enkelt-år detektion).
 *
 * Strategi:
 * 1. Beregn max monetær værdi per år.
 * 2. Find anker-året (året med højest max — mest sandsynligt fuld DKK).
 * 3. For hvert andet år: beregn ratio = ankerMax / årMax.
 *    Ratio 200–5000 → året er allerede T DKK mens ankeret er fuld DKK
 *    → divider ankeret (og lignende "store" år) med 1.000.
 * 4. Enkelt-år: brug standard normaliserTilTDKK().
 *
 * @param years - Alle regnskabsår (deduplikerede, sorteret)
 * @returns Konsistent normaliserede regnskabsår i T DKK
 */
export function normaliserAlleAar(years: RegnskabsAar[]): RegnskabsAar[] {
  if (years.length <= 1) return years.map(normaliserTilTDKK);

  // Beregn max monetær værdi per år
  const maxPerYear = years.map((y) => ({ year: y, maks: maksMonetaerVaerdi(y) }));

  // Find anker = året med højest max
  const anker = maxPerYear.reduce((best, cur) => (cur.maks > best.maks ? cur : best));
  if (anker.maks === 0) return years;

  // Tjek om der er en magnitude-forskel mellem år (ratio ~1000 = format-skift)
  const yearsWithData = maxPerYear.filter((m) => m.maks > 0);
  if (yearsWithData.length < 2) return years.map(normaliserTilTDKK);

  // Find mindste max blandt år med data
  const minMaks = Math.min(...yearsWithData.map((m) => m.maks));
  const globalRatio = anker.maks / minMaks;

  // Ratio 200–5000 indikerer formatskift (typisk ~1000x forskel)
  const harFormatSkift = globalRatio >= 200 && globalRatio <= 5000;

  if (!harFormatSkift) {
    // Ingen formatskift — brug standard per-år heuristik
    return years.map(normaliserTilTDKK);
  }

  // Formatskift detekteret: år med max > midtpunkt er i fuld DKK
  // Midtpunkt = geometrisk gennemsnit af anker og min (≈ sqrt(anker * min))
  const midtpunkt = Math.sqrt(anker.maks * minMaks);

  return maxPerYear.map(({ year, maks }) => {
    if (maks === 0) return year;
    // År over midtpunktet er i fuld DKK → divider med 1.000
    if (maks > midtpunkt) return dividerAarMed1000(year);
    // År under midtpunktet er allerede i T DKK
    return year;
  });
}

/** Dedupliker RegnskabsAar-array: ét regnskab per år, bedste vinder */
function deduplicateYears(years: RegnskabsAar[]): RegnskabsAar[] {
  const perAar = new Map<number, RegnskabsAar>();
  for (const y of years) {
    const existing = perAar.get(y.aar);
    if (!existing) {
      perAar.set(y.aar, y);
      continue;
    }
    const newHasData = countFields(y) > 0;
    const oldHasData = countFields(existing) > 0;
    if (newHasData && !oldHasData) {
      perAar.set(y.aar, y);
      continue;
    }
    if (!newHasData && oldHasData) continue;
    const nd = periodeDage(y),
      od = periodeDage(existing);
    if (nd > od || (nd === od && countFields(y) > countFields(existing))) {
      perAar.set(y.aar, y);
    }
  }
  return [...perAar.values()].sort((a, b) => b.aar - a.aar);
}

// ─── Route Handler ────────────────────────────────────────────────────────────

interface RegnskabEntry {
  sagsNummer: string;
  offentliggjort?: string;
  periodeStart: string | null;
  periodeSlut: string | null;
  dokumenter: Array<{
    dokumentUrl: string;
    dokumentType: string;
    dokumentMimeType: string;
  }>;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { searchParams } = req.nextUrl;
  const cvr = searchParams.get('cvr') ?? '';

  if (!cvr || !/^\d{8}$/.test(cvr)) {
    return NextResponse.json(
      { years: [], total: 0, error: 'Ugyldigt CVR-nummer' },
      { status: 200 }
    );
  }

  try {
    // ── 1. Hent regnskab-liste fra ES (hurtig — kun metadata) ──
    // Forward session cookie so the internal /api/regnskab auth guard passes.
    const baseUrl = req.nextUrl.origin;
    const regnskabRes = await fetch(`${baseUrl}/api/regnskab?cvr=${cvr}`, {
      signal: AbortSignal.timeout(12000),
      headers: { cookie: req.headers.get('cookie') ?? '' },
    });
    if (!regnskabRes.ok) {
      return NextResponse.json(
        { years: [], total: 0, error: 'Kunne ikke hente regnskaber' },
        { status: 200 }
      );
    }

    const regnskabData = (await regnskabRes.json()) as {
      regnskaber: RegnskabEntry[];
      tokenMangler: boolean;
    };

    if (regnskabData.tokenMangler) {
      return NextResponse.json(
        { years: [], total: 0, error: 'CVR ES credentials mangler' },
        { status: 200 }
      );
    }

    // Seneste offentliggørelsestidspunkt — bruges som cache-nøgle
    // BIZZ-449: Append parser version to timestamp so cache is invalidated when
    // the XBRL parser logic changes (e.g. decimals attribute handling fix).
    // v6: BIZZ-562 — extractText vælger LÆNGSTE match for ESEF continuation cases
    const PARSER_VERSION = 'v7';
    const latestTimestamp =
      (regnskabData.regnskaber[0]?.offentliggjort ?? '') + `_${PARSER_VERSION}`;

    // ── 2. Tjek Supabase cache ──
    const supabase = getSupabase();
    let cachedYears: RegnskabsAar[] = [];

    if (supabase && latestTimestamp) {
      try {
        const { data: cached } = await supabase
          .from('regnskab_cache')
          .select('years, es_timestamp')
          .eq('cvr', cvr)
          .single();

        if (cached?.es_timestamp === latestTimestamp && cached?.years) {
          // Fuld cache hit — ES-tidsstempel matcher, data er uændret
          return NextResponse.json(
            {
              years: cached.years as RegnskabsAar[],
              total: (cached.years as RegnskabsAar[]).length,
              cached: true,
            },
            {
              status: 200,
              headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
            }
          );
        }

        // Delvis cache — vi har ældre data, men ES har nyt. Behold det gamle.
        // BIZZ-561: MEN kun hvis kun offentliggjort-tidsstempel ændret — ikke
        // hvis PARSER_VERSION er bumpet. Hvis parser-versionen er ændret er
        // cachet data struktur-mæssigt forældet (mangler nye felter som
        // pengestroemme/revisor) og skal IKKE genbruges — ellers skipper
        // nyeRegnskaber-filtret allerede-cachede år, og deduplicateYears
        // taber pga. tie-break på countFields. Fuld re-parse kræves.
        const cachedVersion = (cached?.es_timestamp as string | undefined)?.split('_').pop();
        const versionMismatch = cachedVersion != null && cachedVersion !== PARSER_VERSION;
        if (cached?.years && !versionMismatch) {
          cachedYears = cached.years as RegnskabsAar[];
        }
        // versionMismatch = true → cachedYears forbliver tom → ALLE år re-parses
        // med ny parser-logik. Cache opdateres efter re-parse.
      } catch {
        // Cache-fejl — fortsæt med XBRL-fetch
      }
    }

    // ── 3. Cache miss — hent og parse XBRL ──
    const alleRegnskaberMedXbrl = regnskabData.regnskaber.filter(
      (r) =>
        r.periodeStart &&
        r.periodeSlut &&
        r.dokumenter.some(
          (d) => d.dokumentMimeType?.includes('xml') || d.dokumentMimeType?.includes('xhtml')
        )
    );

    // Find hvilke år vi allerede har cached — skip dem
    const cachedAar = new Set(cachedYears.map((y) => y.aar));
    const nyeRegnskaber = alleRegnskaberMedXbrl.filter((r) => {
      const aar = new Date(r.periodeSlut!).getFullYear();
      return !cachedAar.has(aar);
    });

    const total = nyeRegnskaber.length;

    // Hent offset/limit for progressiv loading
    const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50));
    const regnskaberMedXbrl = nyeRegnskaber.slice(offset, offset + limit);

    const years: RegnskabsAar[] = [];

    const fetchPromises = regnskaberMedXbrl.map(async (regnsk) => {
      const xbrlDok =
        regnsk.dokumenter.find((d) => d.dokumentMimeType?.includes('xhtml')) ??
        regnsk.dokumenter.find((d) => d.dokumentMimeType?.includes('xml'));
      if (!xbrlDok || !regnsk.periodeStart || !regnsk.periodeSlut) return null;

      try {
        const xbrlRes = await fetch(xbrlDok.dokumentUrl, {
          signal: AbortSignal.timeout(60000),
          headers: { 'Accept-Encoding': 'gzip, deflate' },
        });
        if (!xbrlRes.ok) return null;
        const xml = await xbrlRes.text();
        return parseXbrl(xml, regnsk.periodeStart, regnsk.periodeSlut);
      } catch {
        return null;
      }
    });

    const results = await Promise.all(fetchPromises);
    for (const result of results) {
      if (result) years.push(result);
    }

    // Merge nye parsede data med cached data
    const allYears = [...cachedYears, ...years];
    // BIZZ-459/466: Normaliser hver år til T DKK før vi dedupliker/returnerer,
    // så UI'en kan vise konsistent "T DKK"-label uanset om den underliggende
    // XBRL var deklareret i T DKK eller fuld DKK.
    const uniqueYears = normaliserAlleAar(deduplicateYears(allYears));

    // ── 4. Gem opdateret cache i Supabase (kun ved komplet fetch) ──
    if (supabase && latestTimestamp && offset === 0 && limit >= total && uniqueYears.length > 0) {
      try {
        await supabase.from('regnskab_cache').upsert(
          {
            cvr,
            years: uniqueYears,
            es_timestamp: latestTimestamp,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: 'cvr' }
        );
      } catch {
        // Cache-skrivefejl — ignorer
      }
    }

    return NextResponse.json(
      { years: uniqueYears, total },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    logger.error('[Regnskab XBRL] Error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { years: [], total: 0, error: 'Intern fejl ved XBRL-parsing' },
      { status: 200 }
    );
  }
}
