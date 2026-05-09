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
    beskrivelse: 'Virksomheds-kreditpakke med nøgletal, ejerskab, sikkerhed og risiko-scoring',
    ikon: 'CreditCard',
    instruktioner: `Du er kreditanalytiker. Lav en komplet kreditvurdering af virksomheden.
Kald følgende tools i rækkefølge:
1. hent_cvr_virksomhed — grunddata, branche, ansatte, selskabsform.
2. hent_regnskab_noegletal — 3 års regnskabstrend (omsætning, resultat, egenkapital, soliditet, afkastningsgrad).
3. hent_virksomhed_ejere — ejerskabsstruktur opad.
4. hent_datterselskaber — koncernstruktur nedad.
5. hent_ejendomme_for_virksomhed — alle ejendomme.
6. For hver ejendom: hent_vurdering + hent_tinglysning (hæftelser).

Beregn: soliditetsgrad, likviditetsgrad, gældsfaktor, cash flow trend, friværdi per ejendom (vurdering minus hæftelser).

Generér rapport med sektionerne:
RESUMÉ — 1 afsnit kreditvurdering med anbefaling.
NØGLETAL — tabel med 3 års trend + branche-benchmark.
SIKKERHEDSOVERSIGT — ejendomme med vurdering vs. hæftelser = friværdi.
EJERSKAB — koncern-/ejerskabsstruktur + beneficial owner identifikation.
RISIKOFAKTORER — røde flag (faldende omsætning, negativ egenkapital, høj belåningsgrad, kompleks ejerskab).
KONKLUSION — kreditværdig ja/nej med begrundelse og anbefalet max kreditramme.`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_regnskab_noegletal',
      'hent_virksomhed_ejere',
      'hent_datterselskaber',
      'hent_ejendomme_for_virksomhed',
      'hent_vurdering',
      'hent_tinglysning',
    ],
    outputFormat:
      'Struktureret kreditrapport: RESUMÉ, NØGLETAL (tabel), SIKKERHEDSOVERSIGT (ejendomme + friværdi), EJERSKAB (koncernoverblik), RISIKOFAKTORER (traffic light), KONKLUSION (anbefaling + max kreditramme).',
  },
  {
    id: 'due-diligence',
    label: 'Due Diligence',
    beskrivelse:
      'Automatisk DD-rapport for virksomhed (transaktionsadvokat) eller ejendom (ejendomsadvokat)',
    ikon: 'FileSearch',
    instruktioner: `Afgør hvilken type DD der skal laves ud fra target-typen:

HVIS TARGET ER VIRKSOMHED (CVR):
Du er transaktionsadvokat. Generér en virksomheds-due-diligence rapport.
Kald: hent_cvr_virksomhed (grunddata + historik), hent_virksomhed_historik (navne/adresse/form/status/fusioner), hent_virksomhed_ejere + hent_virksomhed_personer (ejerskab + ledelse), hent_regnskab_noegletal (økonomi), hent_ejendomme_for_virksomhed + hent_tinglysning per ejendom (aktiver + hæftelser), hent_datterselskaber (koncern).
Rapport-sektioner:
SELSKABSRETLIGT — form, stiftelse, vedtægter, tegningsregel.
EJERSKAB OG LEDELSE — ejere, bestyrelse, direktion, historik.
ØKONOMISK STATUS — 3 års nøgletal, gæld, soliditet.
AKTIVER — ejendomme med vurdering og hæftelser.
RETTIGHEDER OG FORPLIGTELSER — tinglysning servitutter, pantebreve.
RISICI OG ANBEFALINGER — røde flag og juridiske opmærksomhedspunkter.

HVIS TARGET ER EJENDOM (BFE/adresse):
Du er ejendomsadvokat. Generér en ejendoms-due-diligence rapport.
Kald: dawa_adresse_detaljer, hent_bbr_data, hent_matrikeldata, hent_vurdering + hent_forelobig_vurdering, hent_tinglysning (ejere + hæftelser + servitutter), hent_energimaerke, hent_jordforurening, hent_plandata.
Rapport-sektioner:
IDENTIFIKATION — adresse, BFE, matrikel, ejerlavkode.
FYSISK BESKRIVELSE — BBR data, areal, byggeår, materialer.
RETLIGE FORHOLD — tinglysning ejere, hæftelser med prioritet og hovedstol, servitutter med juridisk vurdering.
VÆRDI — vurdering + foreløbig + belåningsgrad.
MILJØ — jordforurening, energimærke.
PLANMÆSSIGE FORHOLD — lokalplan, bebyggelsesprocent, zoning.
RISICI — juridiske og fysiske risikofaktorer.`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_virksomhed_historik',
      'hent_virksomhed_ejere',
      'hent_virksomhed_personer',
      'hent_regnskab_noegletal',
      'hent_datterselskaber',
      'hent_ejendomme_for_virksomhed',
      'hent_tinglysning',
      'hent_vurdering',
      'hent_forelobig_vurdering',
      'hent_bbr_data',
      'hent_matrikeldata',
      'dawa_adresse_detaljer',
      'hent_energimaerke',
      'hent_jordforurening',
      'hent_plandata',
    ],
    outputFormat:
      'Virksomheds-DD: 6 sektioner (selskabsretligt → risici). Ejendoms-DD: 7 sektioner (identifikation → risici). Hver sektion med fakta-tabel og juridisk vurdering. Afslut med samlet risk assessment.',
  },
  {
    id: 'aml-kyc',
    label: 'AML/KYC Compliance',
    beskrivelse:
      'Know Your Customer rapport med beneficial ownership, struktur-kompleksitet og risikoscoring',
    ikon: 'ShieldCheck',
    instruktioner: `Du er compliance-analytiker specialiseret i AML/KYC. Generér en Know Your Customer rapport.
Kald følgende tools:
1. hent_cvr_virksomhed — grunddata, status, branche (flag højrisiko-brancher: pengeoverførsel, krypto, gambling, kunst).
2. hent_virksomhed_ejere — fuld ejerskabskæde opad til ultimative personer.
3. hent_virksomhed_personer — alle roller inkl. historiske.
4. hent_virksomhed_historik — navne/adresse/form ændringer (hyppige ændringer = risiko).
5. hent_datterselskaber — kompleksitet nedad.
6. hent_regnskab_noegletal — finansiel sundhed.
7. hent_person_netvaerk per ultimativ ejer — connected parties.

Rapport-sektioner:
KUNDEIDENTIFIKATION — navn, CVR, form, branche, stiftelsesdato.
BENEFICIAL OWNERS — alle personer med 25%+ ejerskab eller bestemmende indflydelse, med fuld kæde.
LEDELSES-PROFIL — direktion + bestyrelse med andre roller.
STRUKTUR-KOMPLEKSITET — antal lag, udenlandske selskaber, krydsejerskab (score 1-5).
RISIKOINDIKATORER — højrisiko-branche, hyppige ændringer, revisionsfravalgt, ung virksomhed med høj omsætning.
FINANSIEL PROFIL — nøgletal + afvigelser fra branche.
SAMLET RISIKOSCORE — lav/medium/høj/kritisk med begrundelse.
ANBEFALINGER — enhanced due diligence ja/nej, opfølgningsfrekvens.

VIGTIGT: Dette er IKKE en endelig AML-vurdering — kun data-sammenstilling til brug for compliance-afdelingen.`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_virksomhed_ejere',
      'hent_virksomhed_personer',
      'hent_virksomhed_historik',
      'hent_datterselskaber',
      'hent_regnskab_noegletal',
      'hent_person_netvaerk',
    ],
    outputFormat:
      'KYC-rapport: KUNDEIDENTIFIKATION, BENEFICIAL OWNERS (ejerskabskæde), LEDELSES-PROFIL, STRUKTUR-KOMPLEKSITET (score 1-5), RISIKOINDIKATORER (tabel), FINANSIEL PROFIL, SAMLET RISIKOSCORE (lav/medium/høj/kritisk), ANBEFALINGER.',
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
