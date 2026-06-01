/**
 * BIZZ-1936: Direct-port af app/api/regnskab/xbrl/route.ts parser-logik
 * til pure JS .mjs så vi kan backfille regnskab_cache uden HTTP roundtrip.
 *
 * Holder samme PARSER_VERSION som route.ts ('v7') så cache er kompatibel.
 * Skema for years[i] er identisk med RegnskabsAar interface i route.ts.
 *
 * Vedligehold: hvis route.ts parseren ændres, opdater også denne fil.
 */

export const PARSER_VERSION = 'v7';

// ─── Tag mappings (identisk med route.ts) ─────────────────────────────────────

const RESULTAT_TAGS = {
  omsaetning: ['Revenue', 'Nettoomsaetning'],
  bruttofortjeneste: ['GrossProfitLoss', 'GrossProfit'],
  personaleomkostninger: ['EmployeeBenefitsExpense', 'StaffCosts'],
  afskrivninger: [
    'DepreciationAmortisationExpenseAndImpairmentLossesOfPropertyPlantAndEquipmentAndIntangibleAssetsRecognisedInProfitOrLoss',
    'DepreciationAmortisation',
    'DepreciationAndAmortisationExpense',
  ],
  resultatFoerSkat: ['ProfitLossFromOrdinaryActivitiesBeforeTax', 'ProfitBeforeTax', 'ProfitLossBeforeTax'],
  skatAfAaretsResultat: ['TaxExpenseOnOrdinaryActivities', 'TaxExpense', 'IncomeTaxExpense', 'IncomeTaxExpenseContinuingOperations'],
  aaretsResultat: ['ProfitLoss'],
  finansielleIndtaegter: ['OtherFinanceIncome', 'FinanceIncome'],
  finansielleOmkostninger: ['OtherFinanceExpenses', 'FinanceCosts'],
  eksterneOmkostninger: ['ExternalExpenses', 'OtherExternalExpenses', 'RawMaterialsAndConsumablesUsed'],
  driftsomkostninger: ['CostOfSales'],
};

const BALANCE_TAGS = {
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

const NOEGLETAL_TAGS = {
  antalAnsatte: ['AverageNumberOfEmployees', 'NumberOfEmployees'],
};

const PENGESTROM_TAGS = {
  fraDrift: ['CashFlowsFromUsedInOperatingActivities', 'CashFlowsFromOperatingActivities', 'CashFlowFromOperatingActivities', 'NetCashFlowsFromUsedInOperatingActivities'],
  fraInvestering: ['CashFlowsFromUsedInInvestingActivities', 'CashFlowsFromInvestingActivities', 'CashFlowFromInvestingActivities', 'NetCashFlowsFromUsedInInvestingActivities'],
  fraFinansiering: ['CashFlowsFromUsedInFinancingActivities', 'CashFlowsFromFinancingActivities', 'CashFlowFromFinancingActivities', 'NetCashFlowsFromUsedInFinancingActivities'],
  aaretsForskydning: ['IncreaseDecreaseInCashAndCashEquivalents', 'IncreaseDecreaseInCashAndCashEquivalentsBeforeEffectOfExchangeRateChanges', 'CashFlowForPeriodIncreaseDecrease'],
  likviderPrimo: ['CashAndCashEquivalentsAtBeginningOfPeriod', 'CashAndCashEquivalentsBeginningOfPeriod'],
  likviderUltimo: ['CashAndCashEquivalentsAtEndOfPeriod', 'CashAndCashEquivalentsEndOfPeriod', 'CashAndCashEquivalents'],
};

const REVISOR_TEXT_TAGS = {
  firmanavn: ['NameOfAuditFirm'],
  firmaCvr: ['IdentificationNumberCvrOfAuditFirm'],
  revisorNavn: ['NameAndSurnameOfAuditor'],
  revisorMNE: ['IdentificationNumberOfAuditor'],
  signaturSted: ['SignatureOfAuditorsPlace'],
  signaturDato: ['SignatureOfAuditorsDate'],
  forbeholdType: ['TypeOfModifiedOpinionOnAuditedFinancialStatements'],
};

const NOTER_TEXT_TAGS = {
  formaal: ['DescriptionOfPrincipalActivities', 'DescriptionOfActivities', 'DescriptionOfNatureOfEntitysOperationsAndPrincipalActivities'],
  regnskabspraksis: ['DisclosureOfAccountingPolicies', 'DescriptionOfAccountingPolicies', 'DisclosureOfSummaryOfSignificantAccountingPoliciesExplanatory'],
  begivenhederEfterBalancedag: ['InformationAboutSubsequentEvents', 'DisclosureOfNonadjustingEventsAfterReportingPeriodExplanatory', 'DisclosureOfEventsAfterReportingPeriodExplanatory'],
  goingConcern: ['InformationOnGoingConcernAssumption', 'DisclosureOfGoingConcernExplanatory'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseContexts(xml, periodeStart, periodeSlut) {
  const durationCtxIds = new Set();
  const instantCtxIds = new Set();
  const ctxRegex = /<xbrli:context\s+id="([^"]*)">([\s\S]*?)<\/xbrli:context>/gi;
  let m;
  while ((m = ctxRegex.exec(xml)) !== null) {
    const id = m[1];
    const body = m[2];
    const hasDim = /xbrldi:explicitMember|xbrldi:typedMember/i.test(body);
    if (hasDim) {
      const isConsolidated = /ConsolidatedMember|ConsolidatedSoloDimension/i.test(body);
      if (!isConsolidated) continue;
    }
    const startMatch = body.match(/<xbrli:startDate>([^<]+)/);
    const endMatch = body.match(/<xbrli:endDate>([^<]+)/);
    const instantMatch = body.match(/<xbrli:instant>([^<]+)/);
    if (startMatch && endMatch) {
      if (startMatch[1] === periodeStart && endMatch[1] === periodeSlut) durationCtxIds.add(id);
    } else if (instantMatch) {
      if (instantMatch[1] === periodeSlut) instantCtxIds.add(id);
    }
  }
  return { durationCtxIds, instantCtxIds };
}

function extractValue(xml, tagNames, validCtxIds) {
  for (const tag of tagNames) {
    const patterns = [
      { re: new RegExp(`<[a-z-]+:${tag}\\s+([^>]*)>([^<]+)<\\/[a-z-]+:${tag}>`, 'gi'), attrsGroup: 1, valGroup: 2 },
      { re: new RegExp(`<${tag}\\s+([^>]*)>([^<]+)<\\/${tag}>`, 'gi'), attrsGroup: 1, valGroup: 2 },
      { re: new RegExp(`<ix:nonFraction\\s+([^>]*name="[^"]*:${tag}"[^>]*)>([^<]+)<`, 'gi'), attrsGroup: 1, valGroup: 2 },
    ];
    for (const { re, attrsGroup, valGroup } of patterns) {
      let match;
      while ((match = re.exec(xml)) !== null) {
        const attrs = match[attrsGroup];
        const rawVal = match[valGroup];
        if (validCtxIds && validCtxIds.size > 0) {
          const ctxMatch = attrs.match(/contextRef="([^"]*)"/i);
          if (!ctxMatch || !validCtxIds.has(ctxMatch[1])) continue;
        }
        const format = attrs.match(/format="([^"]*)"/i)?.[1] ?? '';
        let cleaned;
        if (/num-comma-decimal/i.test(format)) {
          cleaned = rawVal.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
        } else {
          cleaned = rawVal.trim().replace(/\s/g, '').replace(/,/g, '');
        }
        const num = parseFloat(cleaned);
        if (!isNaN(num)) {
          const scaleMatch = attrs.match(/scale="(-?\d+)"/);
          const scale = scaleMatch ? parseInt(scaleMatch[1], 10) : 0;
          const hasScale = scaleMatch !== null;
          const decimalsMatch = attrs.match(/decimals="(-?\d+|INF)"/i);
          let dkkValue;
          if (hasScale && scale > 0) {
            dkkValue = num * Math.pow(10, scale);
          } else if (hasScale && scale === 0 && num > 0 && num < 10_000_000) {
            dkkValue = num * 1_000_000;
          } else if (decimalsMatch && decimalsMatch[1] !== 'INF') {
            const d = parseInt(decimalsMatch[1], 10);
            dkkValue = d < 0 ? num * Math.pow(10, -d) : num;
          } else {
            dkkValue = num;
          }
          return Math.round(dkkValue);
        }
      }
    }
  }
  return null;
}

function normaliseInline(raw) {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractText(xml, tagNames) {
  for (const tag of tagNames) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<[a-z-]+:${escapedTag}\\s+[^>]*>([\\s\\S]*?)<\\/[a-z-]+:${escapedTag}>`, 'gi'),
      new RegExp(`<ix:nonNumeric\\s+[^>]*name="[^"]*:${escapedTag}"[^>]*>([\\s\\S]*?)<\\/ix:nonNumeric>`, 'gi'),
      new RegExp(`<ix:nonFraction\\s+[^>]*name="[^"]*:${escapedTag}"[^>]*>([\\s\\S]*?)<\\/ix:nonFraction>`, 'gi'),
    ];
    let longestText = null;
    for (const re of patterns) {
      let m;
      while ((m = re.exec(xml)) !== null) {
        if (!m[1]) continue;
        const text = normaliseInline(m[1]);
        if (!text) continue;
        if (longestText == null || text.length > longestText.length) longestText = text;
      }
    }
    if (longestText) return longestText;
  }
  return null;
}

// ─── parseXbrl: build RegnskabsAar ───────────────────────────────────────────

export function parseXbrl(xml, periodeStart, periodeSlut) {
  const aar = new Date(periodeSlut).getFullYear();
  if (isNaN(aar)) return null;

  const { durationCtxIds, instantCtxIds } = parseContexts(xml, periodeStart, periodeSlut);
  const durCtx = durationCtxIds.size > 0 ? durationCtxIds : undefined;
  const instCtx = instantCtxIds.size > 0 ? instantCtxIds : undefined;
  const anyCtx = durCtx ?? instCtx;

  const resultat = {};
  for (const k of Object.keys(RESULTAT_TAGS)) resultat[k] = extractValue(xml, RESULTAT_TAGS[k], durCtx);
  const balance = {};
  for (const k of Object.keys(BALANCE_TAGS)) balance[k] = extractValue(xml, BALANCE_TAGS[k], instCtx);

  const pengestroemmeRaw = {
    fraDrift: extractValue(xml, PENGESTROM_TAGS.fraDrift, durCtx),
    fraInvestering: extractValue(xml, PENGESTROM_TAGS.fraInvestering, durCtx),
    fraFinansiering: extractValue(xml, PENGESTROM_TAGS.fraFinansiering, durCtx),
    aaretsForskydning: extractValue(xml, PENGESTROM_TAGS.aaretsForskydning, durCtx),
    likviderPrimo: extractValue(xml, PENGESTROM_TAGS.likviderPrimo, instCtx),
    likviderUltimo: extractValue(xml, PENGESTROM_TAGS.likviderUltimo, instCtx),
  };
  const harPengestroem = Object.values(pengestroemmeRaw).some(v => v != null);
  const pengestroemme = harPengestroem ? pengestroemmeRaw : null;

  const trim = s => s?.replace(/[\s,;.]+$/, '').trim() || null;
  const cvrClean = s => s?.replace(/\s+/g, '') || null;
  const forbeholdRaw = extractText(xml, REVISOR_TEXT_TAGS.forbeholdType);
  const harForbehold = forbeholdRaw != null && forbeholdRaw !== '' && !/^opinion$/i.test(forbeholdRaw);
  const revisorRaw = {
    firmanavn: trim(extractText(xml, REVISOR_TEXT_TAGS.firmanavn)),
    firmaCvr: cvrClean(extractText(xml, REVISOR_TEXT_TAGS.firmaCvr)),
    revisorNavn: trim(extractText(xml, REVISOR_TEXT_TAGS.revisorNavn)),
    revisorMNE: extractText(xml, REVISOR_TEXT_TAGS.revisorMNE),
    signaturSted: trim(extractText(xml, REVISOR_TEXT_TAGS.signaturSted)),
    signaturDato: extractText(xml, REVISOR_TEXT_TAGS.signaturDato),
    harForbehold,
    forbeholdType: harForbehold ? forbeholdRaw : null,
  };
  const harRevisor = revisorRaw.firmanavn != null || revisorRaw.revisorNavn != null || revisorRaw.firmaCvr != null;
  const revisor = harRevisor ? revisorRaw : null;

  const noterRaw = {
    formaal: extractText(xml, NOTER_TEXT_TAGS.formaal),
    regnskabspraksis: extractText(xml, NOTER_TEXT_TAGS.regnskabspraksis),
    begivenhederEfterBalancedag: extractText(xml, NOTER_TEXT_TAGS.begivenhederEfterBalancedag),
    goingConcern: extractText(xml, NOTER_TEXT_TAGS.goingConcern),
  };
  const harNoter = Object.values(noterRaw).some(v => v != null && v.length > 0);
  const noter = harNoter ? noterRaw : null;

  const antalAnsatte = extractValue(xml, NOEGLETAL_TAGS.antalAnsatte, anyCtx);

  const afkastningsgrad = resultat.aaretsResultat != null && balance.aktiverIAlt
    ? (resultat.aaretsResultat / balance.aktiverIAlt) * 100 : null;
  const soliditetsgrad = balance.egenkapital != null && balance.aktiverIAlt
    ? (balance.egenkapital / balance.aktiverIAlt) * 100 : null;
  const egenkapitalensForrentning = resultat.aaretsResultat != null && balance.egenkapital
    ? (resultat.aaretsResultat / balance.egenkapital) * 100 : null;
  const overskudsgrad = resultat.aaretsResultat != null && resultat.omsaetning
    ? (resultat.aaretsResultat / resultat.omsaetning) * 100 : null;
  const bruttomargin = resultat.bruttofortjeneste != null && resultat.omsaetning
    ? (resultat.bruttofortjeneste / resultat.omsaetning) * 100 : null;
  const ebit = resultat.resultatFoerSkat != null && resultat.finansielleOmkostninger != null
    ? resultat.resultatFoerSkat + Math.abs(resultat.finansielleOmkostninger) : null;
  const ebitMargin = ebit != null && resultat.omsaetning ? (ebit / resultat.omsaetning) * 100 : null;
  const investCapital = balance.aktiverIAlt != null && balance.kortfristetGaeld != null
    ? balance.aktiverIAlt - balance.kortfristetGaeld : null;
  const roic = ebit != null && investCapital && investCapital > 0 ? (ebit / investCapital) * 100 : null;
  const likviditetsgrad = balance.omsaetningsaktiverIAlt != null && balance.kortfristetGaeld
    ? (balance.omsaetningsaktiverIAlt / balance.kortfristetGaeld) * 100 : null;
  const aktivernesOmsaetningshastighed = resultat.omsaetning != null && balance.aktiverIAlt
    ? resultat.omsaetning / balance.aktiverIAlt : null;
  const omsaetningPrAnsat = resultat.omsaetning != null && antalAnsatte && antalAnsatte > 0
    ? Math.round(resultat.omsaetning / antalAnsatte) : null;
  const resultatPrAnsat = resultat.aaretsResultat != null && antalAnsatte && antalAnsatte > 0
    ? Math.round(resultat.aaretsResultat / antalAnsatte) : null;
  const finansielGearing = balance.gaeldsforpligtelserIAlt != null && balance.egenkapital && balance.egenkapital > 0
    ? balance.gaeldsforpligtelserIAlt / balance.egenkapital : null;
  const nettoGaeld = balance.gaeldsforpligtelserIAlt != null && balance.likvideBeholdninger != null
    ? balance.gaeldsforpligtelserIAlt - balance.likvideBeholdninger : null;
  const r1 = v => v != null ? Math.round(v * 10) / 10 : null;

  const noegletal = {
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

  return { aar, periodeStart, periodeSlut, resultat, balance, noegletal, pengestroemme, revisor, noter };
}

// ─── Dedup + normalisering ───────────────────────────────────────────────────

function countFields(y) {
  let n = 0;
  for (const v of Object.values(y.resultat)) if (v !== null) n++;
  for (const v of Object.values(y.balance)) if (v !== null) n++;
  return n;
}

function periodeDage(y) {
  return (new Date(y.periodeSlut).getTime() - new Date(y.periodeStart).getTime()) / 86400000;
}

function maksMonetaerVaerdi(year) {
  const felter = [
    ...Object.values(year.resultat),
    ...Object.values(year.balance),
    year.noegletal.nettoGaeld,
    ...(year.pengestroemme ? Object.values(year.pengestroemme) : []),
  ].filter(v => typeof v === 'number');
  if (felter.length === 0) return 0;
  return Math.max(...felter.map(v => Math.abs(v)));
}

function dividerAarMed1000(year) {
  const divider = v => v == null ? v : Math.round(v / 1000);
  const divideAll = obj => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = divider(v);
    return out;
  };
  return {
    ...year,
    resultat: divideAll(year.resultat),
    balance: divideAll(year.balance),
    noegletal: { ...year.noegletal, nettoGaeld: divider(year.noegletal.nettoGaeld) },
    pengestroemme: year.pengestroemme ? divideAll(year.pengestroemme) : null,
  };
}

function normaliserTilTDKK(year) {
  const maks = maksMonetaerVaerdi(year);
  if (maks === 0 || maks <= 10_000_000) return year;
  return dividerAarMed1000(year);
}

export function normaliserAlleAar(years) {
  if (years.length <= 1) return years.map(normaliserTilTDKK);
  const maxPerYear = years.map(y => ({ year: y, maks: maksMonetaerVaerdi(y) }));
  const anker = maxPerYear.reduce((best, cur) => cur.maks > best.maks ? cur : best);
  if (anker.maks === 0) return years;
  const yearsWithData = maxPerYear.filter(m => m.maks > 0);
  if (yearsWithData.length < 2) return years.map(normaliserTilTDKK);
  const minMaks = Math.min(...yearsWithData.map(m => m.maks));
  const globalRatio = anker.maks / minMaks;
  const harFormatSkift = globalRatio >= 200 && globalRatio <= 5000;
  if (!harFormatSkift) return years.map(normaliserTilTDKK);
  const midtpunkt = Math.sqrt(anker.maks * minMaks);
  return maxPerYear.map(({ year, maks }) => {
    if (maks === 0) return year;
    if (maks > midtpunkt) return dividerAarMed1000(year);
    return year;
  });
}

export function deduplicateYears(years) {
  const perAar = new Map();
  for (const y of years) {
    const existing = perAar.get(y.aar);
    if (!existing) { perAar.set(y.aar, y); continue; }
    const newHasData = countFields(y) > 0;
    const oldHasData = countFields(existing) > 0;
    if (newHasData && !oldHasData) { perAar.set(y.aar, y); continue; }
    if (!newHasData && oldHasData) continue;
    const nd = periodeDage(y), od = periodeDage(existing);
    if (nd > od || (nd === od && countFields(y) > countFields(existing))) perAar.set(y.aar, y);
  }
  return [...perAar.values()].sort((a, b) => b.aar - a.aar);
}
