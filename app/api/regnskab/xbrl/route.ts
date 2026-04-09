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
          // Beregn reel DKK-værdi baseret på iXBRL scale eller standard XBRL
          const scaleMatch = attrs.match(/scale="(-?\d+)"/);
          const scale = scaleMatch ? parseInt(scaleMatch[1], 10) : 0;
          const hasScale = scaleMatch !== null;
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
          } else {
            // Standard XBRL: tal er i hele DKK (f.eks. 101933000000)
            dkkValue = num;
          }
          // Konverter til DKK tusinder (÷ 1000) — vores standard visningsenhed
          return Math.round(dkkValue / 1000);
        }
      }
    }
  }
  return null;
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

  return { aar, periodeStart, periodeSlut, resultat, balance, noegletal };
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
    const baseUrl = req.nextUrl.origin;
    const regnskabRes = await fetch(`${baseUrl}/api/regnskab?cvr=${cvr}`, {
      signal: AbortSignal.timeout(12000),
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
    const latestTimestamp = regnskabData.regnskaber[0]?.offentliggjort ?? '';

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
        if (cached?.years) {
          cachedYears = cached.years as RegnskabsAar[];
        }
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
    const uniqueYears = deduplicateYears(allYears);

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
    console.error('[Regnskab XBRL] Error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { years: [], total: 0, error: 'Intern fejl ved XBRL-parsing' },
      { status: 200 }
    );
  }
}
