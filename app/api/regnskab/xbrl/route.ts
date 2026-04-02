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
  error?: string;
}

// ─── XBRL Tag Mappings ───────────────────────────────────────────────────────

/**
 * Kendte XBRL-tags fra den danske årsregnskabslov-taksonomi (fsa).
 * Matcher tag-navnet (uden namespace) i case-insensitive sammenligning.
 */

/** Resultatopgørelse tags */
const RESULTAT_TAGS: Record<keyof Resultatopgoerelse, string[]> = {
  omsaetning: ['Revenue', 'Nettoomsaetning'],
  bruttofortjeneste: ['GrossProfitLoss', 'GrossProfit'],
  personaleomkostninger: ['EmployeeBenefitsExpense', 'StaffCosts'],
  afskrivninger: [
    'DepreciationAmortisationExpenseAndImpairmentLossesOfPropertyPlantAndEquipmentAndIntangibleAssetsRecognisedInProfitOrLoss',
    'DepreciationAmortisation',
  ],
  resultatFoerSkat: ['ProfitLossFromOrdinaryActivitiesBeforeTax', 'ProfitBeforeTax'],
  skatAfAaretsResultat: ['TaxExpenseOnOrdinaryActivities', 'TaxExpense', 'IncomeTaxExpense'],
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

/** Balance tags */
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
 * Udtager en numerisk værdi fra XBRL XML for et givent tag-navn.
 * Søger både med og uden namespace-prefix.
 *
 * @param xml - Rå XBRL XML-streng
 * @param tagNames - Mulige tag-navne at søge efter
 * @returns Den første fundne numeriske værdi, eller null
 */
function extractValue(xml: string, tagNames: string[]): number | null {
  for (const tag of tagNames) {
    // Match both <fsa:TagName ...>value</fsa:TagName> and <TagName ...>value</TagName>
    // Also handles ix:nonFraction with name attribute
    const patterns = [
      // Standard XBRL: <fsa:Revenue contextRef="...">12345</fsa:Revenue>
      new RegExp(`<[a-z]+:${tag}[^>]*>([^<]+)<\\/[a-z]+:${tag}>`, 'i'),
      // Without namespace: <Revenue ...>12345</Revenue>
      new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`, 'i'),
      // iXBRL inline: <ix:nonFraction name="fsa:Revenue" ...>12345</ix:nonFraction>
      new RegExp(`name="[^"]*:${tag}"[^>]*>([^<]+)<`, 'i'),
    ];

    for (const re of patterns) {
      const match = xml.match(re);
      if (match?.[1]) {
        // Rens: fjern tusindtalsseparatorer, håndter negative tal, decimaler
        const cleaned = match[1].trim().replace(/\s/g, '').replace(/,/g, '');
        const num = parseFloat(cleaned);
        if (!isNaN(num)) return num;
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

  // Resultatopgørelse
  const resultat: Resultatopgoerelse = {
    omsaetning: extractValue(xml, RESULTAT_TAGS.omsaetning),
    bruttofortjeneste: extractValue(xml, RESULTAT_TAGS.bruttofortjeneste),
    personaleomkostninger: extractValue(xml, RESULTAT_TAGS.personaleomkostninger),
    afskrivninger: extractValue(xml, RESULTAT_TAGS.afskrivninger),
    resultatFoerSkat: extractValue(xml, RESULTAT_TAGS.resultatFoerSkat),
    skatAfAaretsResultat: extractValue(xml, RESULTAT_TAGS.skatAfAaretsResultat),
    aaretsResultat: extractValue(xml, RESULTAT_TAGS.aaretsResultat),
    finansielleIndtaegter: extractValue(xml, RESULTAT_TAGS.finansielleIndtaegter),
    finansielleOmkostninger: extractValue(xml, RESULTAT_TAGS.finansielleOmkostninger),
    eksterneOmkostninger: extractValue(xml, RESULTAT_TAGS.eksterneOmkostninger),
    driftsomkostninger: extractValue(xml, RESULTAT_TAGS.driftsomkostninger),
  };

  // Balance
  const balance: Balance = {
    aktiverIAlt: extractValue(xml, BALANCE_TAGS.aktiverIAlt),
    anlaegsaktiverIAlt: extractValue(xml, BALANCE_TAGS.anlaegsaktiverIAlt),
    omsaetningsaktiverIAlt: extractValue(xml, BALANCE_TAGS.omsaetningsaktiverIAlt),
    egenkapital: extractValue(xml, BALANCE_TAGS.egenkapital),
    gaeldsforpligtelserIAlt: extractValue(xml, BALANCE_TAGS.gaeldsforpligtelserIAlt),
    kortfristetGaeld: extractValue(xml, BALANCE_TAGS.kortfristetGaeld),
    langfristetGaeld: extractValue(xml, BALANCE_TAGS.langfristetGaeld),
    selskabskapital: extractValue(xml, BALANCE_TAGS.selskabskapital),
    overfoertResultat: extractValue(xml, BALANCE_TAGS.overfoertResultat),
    likvideBeholdninger: extractValue(xml, BALANCE_TAGS.likvideBeholdninger),
    vaerdipapirer: extractValue(xml, BALANCE_TAGS.vaerdipapirer),
    grundeOgBygninger: extractValue(xml, BALANCE_TAGS.grundeOgBygninger),
    materielleAnlaeg: extractValue(xml, BALANCE_TAGS.materielleAnlaeg),
    investeringsejendomme: extractValue(xml, BALANCE_TAGS.investeringsejendomme),
  };

  // Nøgletal — direkte fra XBRL + beregnede
  const antalAnsatte = extractValue(xml, NOEGLETAL_TAGS.antalAnsatte ?? []);

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const cvr = searchParams.get('cvr') ?? '';

  if (!cvr || !/^\d{8}$/.test(cvr)) {
    return NextResponse.json({ years: [], error: 'Ugyldigt CVR-nummer' }, { status: 200 });
  }

  try {
    // Hent regnskaber fra intern regnskab-API
    const baseUrl = req.nextUrl.origin;
    const regnskabRes = await fetch(`${baseUrl}/api/regnskab?cvr=${cvr}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!regnskabRes.ok) {
      return NextResponse.json(
        { years: [], error: 'Kunne ikke hente regnskaber' },
        { status: 200 }
      );
    }

    const regnskabData = (await regnskabRes.json()) as {
      regnskaber: Array<{
        sagsNummer: string;
        periodeStart: string | null;
        periodeSlut: string | null;
        dokumenter: Array<{
          dokumentUrl: string;
          dokumentType: string;
          dokumentMimeType: string;
        }>;
      }>;
      tokenMangler: boolean;
    };

    if (regnskabData.tokenMangler) {
      return NextResponse.json({ years: [], error: 'CVR ES credentials mangler' }, { status: 200 });
    }

    // Filtrer regnskaber med XBRL (XML) dokumenter og periodedata
    const regnskaberMedXbrl = regnskabData.regnskaber
      .filter(
        (r) =>
          r.periodeStart &&
          r.periodeSlut &&
          r.dokumenter.some((d) => d.dokumentMimeType?.includes('xml'))
      )
      .slice(0, 20); // Hent op til 20 års regnskaber

    // Fetch alle XBRL-filer parallelt
    const years: RegnskabsAar[] = [];

    const fetchPromises = regnskaberMedXbrl.map(async (regnsk) => {
      const xbrlDok = regnsk.dokumenter.find((d) => d.dokumentMimeType?.includes('xml'));
      if (!xbrlDok || !regnsk.periodeStart || !regnsk.periodeSlut) return null;

      try {
        const xbrlRes = await fetch(xbrlDok.dokumentUrl, {
          signal: AbortSignal.timeout(10000),
          headers: { 'Accept-Encoding': 'gzip' },
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

    // Sorter nyeste først
    years.sort((a, b) => b.aar - a.aar);

    return NextResponse.json(
      { years },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
        },
      }
    );
  } catch (err) {
    console.error('[Regnskab XBRL] Error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ years: [], error: 'Intern fejl ved XBRL-parsing' }, { status: 200 });
  }
}
