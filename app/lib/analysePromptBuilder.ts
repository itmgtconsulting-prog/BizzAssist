/**
 * Bygger strukturerede prompts for analyse-moduler.
 *
 * BIZZ-1231: Hvert analyse-modul definerer et AnalyseModul-objekt med
 * instruktioner, relevante tools, og output-format. promptBuilder
 * sammensætter dette med target-data til en færdig prompt.
 *
 * @module app/lib/analysePromptBuilder
 */

/** Analyse-modul definition */
export interface AnalyseModul {
  /** Unikt modul-ID */
  id: string;
  /** Dansk label */
  label: string;
  /** Kort beskrivelse */
  beskrivelse: string;
  /** Ikon-navn (lucide) */
  ikon: string;
  /** System-instruktioner til Claude */
  instruktioner: string;
  /** Hvilke tools Claude skal bruge */
  anbefaletTools: string[];
  /** Output-format beskrivelse */
  outputFormat: string;
}

/** Target for analyse */
export interface AnalyseTarget {
  type: 'person' | 'virksomhed' | 'ejendom';
  id: string;
  label: string;
}

/** Registrerede analyse-moduler */
export const ANALYSE_MODULER: AnalyseModul[] = [
  {
    id: 'annonce',
    label: 'Boligannonce',
    beskrivelse: 'AI-genereret boligannonce med BBR-data, nærområde og sammenlignelige salg',
    ikon: 'Sparkles',
    instruktioner: `Skriv en professionel dansk boligannonce for den valgte ejendom.
VIGTIGT: Kald ALTID disse tools FØRST (parallelt) for at hente konkret ejendomsdata:
- hent_bbr_data (boligareal m², værelser, etager, byggeår, materialer, energiforsyning)
- hent_vurdering (ejendomsværdi, grundværdi)
- hent_energimaerke (energimærke A-G)
- hent_salgshistorik (seneste salgspris og dato)
Brug derefter de konkrete data i annoncen — OPFIND ALDRIG fakta.
Tone: Brugeren vælger tone (luksus, familievenlig, investor, erhverv, social media).
Struktur: Overskrift (max 10 ord), Intro (2-3 sæt.), Rumbeskrivelse (brug BBR-data: areal, værelser, materialer), Beliggenhed, Praktisk info (energimærke, byggeår, vurdering), Afslutning.
Maks 500 ord. Skriv på dansk. Brug markdown.`,
    anbefaletTools: [
      'dawa_adresse_soeg',
      'hent_bbr_data',
      'hent_vurdering',
      'hent_energimaerke',
      'hent_salgshistorik',
    ],
    outputFormat:
      'Professionel boligannonce i markdown med overskrift, intro, rumbeskrivelse, beliggenhed og praktisk info.',
  },
  {
    id: 'forsikring-gap',
    label: 'Forsikrings-gap-analyse',
    beskrivelse: 'Identificér dækningsgab i kundens forsikringsportefølje',
    ikon: 'Shield',
    instruktioner: `Udfør en forsikrings-gap-analyse. Hent alle aktiver (ejendomme, biler, virksomheder, bestyrelsesposter) og krydsreference med kundens eksisterende policer.
Identificér: uforsikrede aktiver, underforsikrede (dækning < 90% af vurdering), manglende D&O for bestyrelsesmedlemmer, risikofaktorer (byggeår < 1960, fredskov, forurening).`,
    anbefaletTools: [
      'hent_ejendomme_for_person',
      'hent_bbr_data',
      'hent_vurdering',
      'hent_bilbog',
      'hent_person_virksomheder',
    ],
    outputFormat:
      'Tabel: Aktiv | Dækning | Gap | Risiko (Høj/Middel/Lav). Afslut med samlet mersalgspotentiale.',
  },
  {
    id: 'kreditvurdering',
    label: 'Kreditvurdering',
    beskrivelse: 'Virksomheds-kreditpakke med nøgletal, ejerskab og risiko-scoring',
    ikon: 'CreditCard',
    instruktioner: `Udfør en kreditvurdering af virksomheden. Hent regnskabsdata (3-5 år), ejerskabsstruktur, ejendomsportefølje og tinglysninger.
Beregn: soliditetsgrad, likviditetsgrad, gældsfaktor, cash flow trend.
Vurdér: kreditrisiko (lav/middel/høj), max kreditramme (baseret på egenkapital × 3), anbefaling.`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_regnskab_noegletal',
      'hent_datterselskaber',
      'hent_ejendomme_for_virksomhed',
      'hent_ejerskab',
    ],
    outputFormat:
      'Nøgletalsoversigt (tabel), ejer-/koncernoverblik, kreditrisiko-vurdering (traffic light), anbefaling.',
  },
  {
    id: 'due-diligence',
    label: 'Due Diligence',
    beskrivelse: 'Automatisk DD-rapport med virksomheds-, ejendoms- og persondata',
    ikon: 'FileSearch',
    instruktioner: `Udfør en due diligence undersøgelse. Hent ALT tilgængelig data: virksomhedsinfo, regnskaber (5 år), ejerskabsstruktur, alle ejendomme, tinglysninger, personer med roller.
Strukturér som DD-rapport: 1) Virksomhedsoverblik, 2) Finansiel analyse, 3) Ejerskab og ledelse, 4) Aktiver (ejendomme + biler), 5) Hæftelser og pantebreve, 6) Risikofaktorer, 7) Konklusion.`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_regnskab_noegletal',
      'hent_datterselskaber',
      'hent_ejendomme_for_virksomhed',
      'hent_ejerskab',
      'hent_vurdering',
      'hent_bbr_data',
    ],
    outputFormat:
      'Struktureret DD-rapport med 7 sektioner. Hver sektion med fakta-tabel og vurdering. Afslut med samlet risk assessment.',
  },
  {
    id: 'aml-kyc',
    label: 'AML/KYC Compliance',
    beskrivelse: 'Beneficial ownership, PEP-tjek og risiko-scoring',
    ikon: 'ShieldCheck',
    instruktioner: `Udfør en AML/KYC compliance-analyse. Hent ejerskabsstruktur og identificér alle beneficial owners (>25% ejerskab). For hver person: hent virksomheder, roller, ejendomme.
Vurdér: kompleks ejerskabsstruktur (>3 niveauer), PEP-indikationer (mange bestyrelsesposter, offentlige virksomheder), uforklarlig formue (ejendomsværdi vs. virksomhedsomsætning).
VIGTIGT: Dette er IKKE en endelig AML-vurdering — kun data-sammenstilling til brug for compliance-afdelingen.`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_datterselskaber',
      'hent_ejeroplysninger',
      'hent_person_virksomheder',
      'hent_ejendomme_for_person',
    ],
    outputFormat:
      'Beneficial ownership diagram (tekst), person-profiler, risiko-indikatorer (tabel), samlet risiko-score (lav/middel/høj).',
  },
  {
    id: 'ejendomsinvestor',
    label: 'Ejendomsinvestor-analyse',
    beskrivelse: 'Portefølje-analyse og deal-screening for ejendomsinvestorer',
    ikon: 'TrendingUp',
    instruktioner: `Udfør en ejendomsinvestor-analyse. For virksomheder: hent alle ejede ejendomme med vurderinger, BBR-data og energimærker. Beregn porteføljeværdi, gennemsnitsafkast, diversificering (bolig/erhverv/grund).
For enkelt-ejendomme: sammenlign med naboer, beregn yield (lejeindtægt/vurdering), vurdér værdistigning-potentiale baseret på plandata og nærområde.`,
    anbefaletTools: [
      'hent_ejendomme_for_virksomhed',
      'hent_vurdering',
      'hent_bbr_data',
      'hent_energimaerke',
      'hent_salgshistorik',
      'hent_plandata',
    ],
    outputFormat:
      'Porteføljeoversigt (tabel med ejendomme, vurdering, type, areal), samlet porteføljeværdi, diversificeringsanalyse, top anbefalinger.',
  },
  {
    id: 'revisor-benchmark',
    label: 'Revisor-benchmark',
    beskrivelse: 'Nøgletalsbenchmark og koncern-analyse for revisorer',
    ikon: 'BarChart3',
    instruktioner: `Udfør en revisor-benchmark-analyse. Hent regnskabsdata for 3-5 år og beregn nøgletal: soliditetsgrad, likviditetsgrad, overskudsgrad, ROE, ROIC. Sammenlign med branchegennemsnit.
For koncerner: hent datterselskaber og aggregér koncernregnskab. Identificér interne transaktioner (krydsejerskab).`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_regnskab_noegletal',
      'hent_datterselskaber',
      'hent_ejeroplysninger',
    ],
    outputFormat:
      'Nøgletalstabel (5 år), trend-analyse, branchebenchmark, koncernoversigt med eliminering af intern omsætning.',
  },
  {
    id: 'inkasso-aktivsoegning',
    label: 'Inkasso aktivsøgning',
    beskrivelse: 'Find debitors aktiver for inkassosager',
    ikon: 'Search',
    instruktioner: `Udfør en aktivsøgning for inkassosager. Find ALLE aktiver tilhørende personen/virksomheden: ejendomme (personligt + via selskaber), biler (bilbog), virksomheder (med status).
Vurdér: likviditetsevne baseret på ejendomsværdier, om der er aktiver at udlægge i, om virksomheder har positiv egenkapital.`,
    anbefaletTools: [
      'hent_ejendomme_for_person',
      'hent_person_virksomheder',
      'hent_bilbog',
      'hent_vurdering',
      'hent_regnskab_noegletal',
      'hent_ejerskab',
    ],
    outputFormat:
      'Aktivoversigt (tabel: type, identifikation, estimeret værdi, hæftelser), samlet formue, likviditetsvurdering, anbefaling.',
  },
  {
    id: 'kommune-energi',
    label: 'Kommune energi- og planlægning',
    beskrivelse: 'Bygningsmasse-analyse og energirenoverings-potentiale per kommune/område',
    ikon: 'Building2',
    instruktioner: `Udfør en kommune-/områdeanalyse af bygningsmassen. For det angivne BFE/adresse: hent BBR-data, energimærke og plandata. Analysér: byggeår-fordeling, energimærke-fordeling, varmeinstallationstype, tagmateriale.
Identificér renoverings-potentiale: antal bygninger med energimærke E-G, andel med fjernvarme vs. olie/gas, potentiel CO₂-reduktion.`,
    anbefaletTools: ['hent_bbr_data', 'hent_energimaerke', 'hent_plandata', 'hent_matrikeldata'],
    outputFormat:
      'Bygningsoversigt, energimærke-fordeling (tabel), varmekilder-fordeling, renoverings-prioritetsliste, estimeret CO₂-besparelse.',
  },
];

/**
 * Bygger en fuld analyse-prompt for AI Chat.
 *
 * @param modul - Analyse-modul definition
 * @param target - Target (person/virksomhed/ejendom)
 * @param ekstraKontekst - Valgfri ekstra kontekst (fx uploaded fil-data)
 * @returns Færdig prompt-streng
 */
export function buildAnalysePrompt(
  modul: AnalyseModul,
  target: AnalyseTarget,
  ekstraKontekst?: string
): string {
  const parts = [
    `[ANALYSE-KONTEKST]`,
    `Modul: ${modul.label}`,
    `Target: ${target.type} — ${target.label} (ID: ${target.id})`,
    '',
    `INSTRUKTIONER:`,
    modul.instruktioner,
    '',
    `ANBEFALEDE TOOLS (kald parallelt):`,
    modul.anbefaletTools.map((t) => `- ${t}`).join('\n'),
    '',
    `OUTPUT-FORMAT:`,
    modul.outputFormat,
  ];

  if (ekstraKontekst) {
    parts.push('', 'EKSTRA KONTEKST:', ekstraKontekst);
  }

  parts.push(
    '',
    'DISCLAIMER: Inkludér altid: "Denne analyse er baseret på offentlige registerdata og er indikativ. Endelig vurdering bør foretages af relevant fagperson."'
  );

  return parts.join('\n');
}
