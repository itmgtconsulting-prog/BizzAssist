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
    beskrivelse: 'Identificér dækningsgab og mersalgspotentiale i kundens forsikringsportefølje',
    ikon: 'Shield',
    instruktioner: `Du er forsikringsrådgiver. Lav en komplet gap-analyse af kundens aktiver vs. forsikringsbehov.
Kald følgende tools:
1. hent_ejendomme_for_person — alle ejendomme personen ejer (privat + via selskaber).
2. For hver ejendom: hent_bbr_data (byggeår, materialer, areal) + hent_vurdering (ejendomsværdi).
3. hent_person_virksomheder — alle virksomheder + roller (bestyrelsesposter → D&O-behov).
4. hent_jordforurening — forureningsrisiko per ejendom.
5. hent_energimaerke — energimærke per ejendom (ældre bygninger = højere risiko).

Analysér for hvert aktiv:
EJENDOMME — byggeår < 1960 = forhøjet risiko. Stråtag/træ = brandforsikring. Kælderrum = oversvømmelse. Jordforurening = ansvarsforsikring.
VIRKSOMHEDER — bestyrelsesposter = D&O-forsikring påkrævet. Selskaber med ansatte = erhvervsansvar + arbejdsskadeforsikring.
BILER — ansvarsforsikring obligatorisk, kasko anbefalet for værdi > 100.000 DKK.

Rapport-sektioner:
AKTIVOVERSIGT — tabel med alle ejendomme, virksomheder, biler med estimeret værdi.
DÆKNINGSANALYSE — aktiv | anbefalet dækning | nuværende gap | risiko (høj/middel/lav).
RISIKOFAKTORER — ejendomsspecifikke risici (alder, materialer, forurening, beliggenhed).
MERSALGSPOTENTIALE — samlet oversigt over forsikringsprodukter der mangler.
PRIORITERET HANDLINGSPLAN — vigtigste gaps der bør lukkes først med begrundelse.`,
    anbefaletTools: [
      'hent_ejendomme_for_person',
      'hent_bbr_data',
      'hent_vurdering',
      'hent_energimaerke',
      'hent_jordforurening',
      'hent_person_virksomheder',
    ],
    outputFormat:
      'Gap-rapport: AKTIVOVERSIGT (tabel), DÆKNINGSANALYSE (aktiv/dækning/gap/risiko), RISIKOFAKTORER, MERSALGSPOTENTIALE, PRIORITERET HANDLINGSPLAN.',
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
    beskrivelse: 'Portefølje-analyse, deal-screening og afkastberegning for ejendomsinvestorer',
    ikon: 'TrendingUp',
    instruktioner: `Du er ejendomsinvesterings-rådgiver. Lav en komplet portefølje- eller deal-analyse.

HVIS TARGET ER VIRKSOMHED (CVR) — porteføljeanalyse:
Kald følgende tools:
1. hent_cvr_virksomhed — grunddata, branche, stiftelsesdato.
2. hent_ejendomme_for_virksomhed — alle ejede ejendomme.
3. For hver ejendom: hent_bbr_data (type, areal, byggeår, materialer) + hent_vurdering (ejendomsværdi, grundværdi) + hent_energimaerke.
4. hent_tinglysning per ejendom — hæftelser og belåningsgrad.
5. hent_salgshistorik per ejendom — købspris og dato.
6. hent_regnskab_noegletal — virksomhedens økonomi.

Beregn per ejendom: yield (estimeret lejeindtægt / vurdering), belåningsgrad (hæftelser / vurdering), værdistigning siden køb.
Beregn portefølje: samlet vurderingsværdi, samlet hæftelser, gennemsnitlig belåningsgrad, diversificering (bolig/erhverv/grund/andel).

HVIS TARGET ER EJENDOM (BFE) — deal-screening:
Kald: hent_bbr_data, hent_vurdering, hent_forelobig_vurdering, hent_salgshistorik, hent_tinglysning, hent_energimaerke, hent_plandata, hent_jordforurening, hent_omraadeprofil.
Vurdér: yield-potentiale, renoveringsbehov (energimærke, byggeår), planmæssige muligheder (bebyggelsesprocent, zoning), risici (forurening, hæftelser).

Rapport-sektioner:
PORTEFØLJEOVERSIGT — tabel med alle ejendomme (adresse, type, areal, vurdering, hæftelser, yield).
FINANSIEL ANALYSE — samlet porteføljeværdi, belåningsgrad, friværdi, estimeret afkast.
DIVERSIFICERING — fordeling på ejendomstyper, geografisk spredning, aldersfordeling.
RISIKOFAKTORER — høj belåningsgrad, energimærke E-G, forurening, ejendomme i lavvækst-områder.
ANBEFALINGER — optimeringsmuligheder (refinansiering, frasalg, tilkøb, renovering).`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_ejendomme_for_virksomhed',
      'hent_bbr_data',
      'hent_vurdering',
      'hent_forelobig_vurdering',
      'hent_energimaerke',
      'hent_tinglysning',
      'hent_salgshistorik',
      'hent_plandata',
      'hent_jordforurening',
      'hent_omraadeprofil',
      'hent_regnskab_noegletal',
    ],
    outputFormat:
      'Porteføljeanalyse: PORTEFØLJEOVERSIGT (tabel), FINANSIEL ANALYSE (nøgletal), DIVERSIFICERING, RISIKOFAKTORER, ANBEFALINGER. Deal-screening: EJENDOMSPROFIL, AFKASTBEREGNING, RISICI, ANBEFALING.',
  },
  {
    id: 'revisor-benchmark',
    label: 'Revisor-benchmark',
    beskrivelse: 'Nøgletalsbenchmark, koncern-analyse og going concern-vurdering for revisorer',
    ikon: 'BarChart3',
    instruktioner: `Du er statsautoriseret revisor. Lav en nøgletalsbenchmark og koncern-analyse.
Kald følgende tools:
1. hent_cvr_virksomhed — grunddata, branchekode, ansatte, selskabsform.
2. hent_regnskab_noegletal — 3-5 års regnskabsdata (omsætning, resultat, aktiver, passiver, egenkapital).
3. hent_virksomhed_ejere — ejerskabsstruktur opad.
4. hent_datterselskaber — koncernstruktur nedad.
5. For hvert datterselskab med CVR: hent_regnskab_noegletal (koncern-aggregering).
6. hent_virksomhed_historik — ændringer i selskabsform, fusioner, spaltninger.
7. hent_virksomhed_personer — direktion og bestyrelse (personsammenfald i koncern).

Beregn nøgletal per år (3-5 år):
RENTABILITET — overskudsgrad, ROE, ROIC, bruttomargin.
SOLIDITET — soliditetsgrad, gældsgrad, finansiel gearing.
LIKVIDITET — likviditetsgrad (current ratio), acid test, cash conversion cycle.
AKTIVITET — omsætningshastighed (aktiver, debitorer, kreditorer).

Rapport-sektioner:
VIRKSOMHEDSOVERSIGT — grunddata, branche, ansatte, historik.
NØGLETALSTREND — tabel med 3-5 års nøgletal + grafisk trend-indikation (↑↓→).
BRANCHEBENCHMARK — sammenligning med branchegennemsnit (baseret på branchekode).
KONCERNANALYSE — datterselskaber med individuelle nøgletal, personsammenfald, intern omsætning.
GOING CONCERN — røde flag (negativ egenkapital, faldende omsætning >20%, likviditetsgrad <1, revisionsforbehold).
REVISIONSMÆSSIGE OPMÆRKSOMHEDSPUNKTER — usædvanlige poster, hyppige ændringer, manglende revision.`,
    anbefaletTools: [
      'hent_cvr_virksomhed',
      'hent_regnskab_noegletal',
      'hent_virksomhed_ejere',
      'hent_datterselskaber',
      'hent_virksomhed_historik',
      'hent_virksomhed_personer',
    ],
    outputFormat:
      'Revisorbenchmark: VIRKSOMHEDSOVERSIGT, NØGLETALSTREND (3-5 år tabel), BRANCHEBENCHMARK, KONCERNANALYSE, GOING CONCERN (røde flag), REVISIONSMÆSSIGE OPMÆRKSOMHEDSPUNKTER.',
  },
  {
    id: 'inkasso-aktivsoegning',
    label: 'Inkasso aktivsøgning',
    beskrivelse: 'Komplet aktivsøgning og udlægsvurdering for inkassosager',
    ikon: 'Search',
    instruktioner: `Du er inkassorådgiver. Lav en komplet aktivsøgning for at vurdere debitors betalingsevne og udlægsmuligheder.

HVIS TARGET ER PERSON:
Kald følgende tools:
1. hent_ejendomme_for_person — alle personligt ejede ejendomme.
2. For hver ejendom: hent_vurdering (værdi) + hent_tinglysning (hæftelser → friværdi).
3. hent_person_virksomheder — alle virksomheder personen ejer/har roller i.
4. For hver virksomhed med ejerskab: hent_regnskab_noegletal (egenkapital, omsætning).
5. hent_person_netvaerk — netværk af relaterede personer/selskaber.

HVIS TARGET ER VIRKSOMHED (CVR):
Kald følgende tools:
1. hent_cvr_virksomhed — grunddata, status (aktiv/opløst/konkurs).
2. hent_ejendomme_for_virksomhed — ejede ejendomme.
3. For hver ejendom: hent_vurdering + hent_tinglysning (friværdi).
4. hent_regnskab_noegletal — egenkapital, aktiver, likviditet.
5. hent_virksomhed_ejere — personlige ejere (kan bæres personligt ansvar?).
6. hent_datterselskaber — skjulte aktiver i datterselskaber.

Vurdér per aktiv: estimeret værdi, eksisterende hæftelser, friværdi tilgængelig for udlæg.
Flag: konkurstruede selskaber, negativ egenkapital, skiftede selskabsformer, overdragelser til nærtstående.

Rapport-sektioner:
DEBITORPROFIL — grunddata, status, historik.
AKTIVOVERSIGT — tabel: aktiv-type | identifikation | vurdering | hæftelser | friværdi | udlægsegnet.
EJENDOMME — detaljeret per ejendom med hæftelsesanalyse og prioritetsstilling.
VIRKSOMHEDER — selskaber med egenkapital, status, ejerskabsandel.
SKJULTE AKTIVER — datterselskaber, nærtstående personers ejendomme, nylige overdragelser.
SAMLET FORMUE — estimeret nettoformue (aktiver minus hæftelser).
UDLÆGSANBEFALING — prioriteret liste over aktiver egnet til udlæg med begrundelse.`,
    anbefaletTools: [
      'hent_ejendomme_for_person',
      'hent_ejendomme_for_virksomhed',
      'hent_vurdering',
      'hent_tinglysning',
      'hent_person_virksomheder',
      'hent_cvr_virksomhed',
      'hent_regnskab_noegletal',
      'hent_virksomhed_ejere',
      'hent_datterselskaber',
      'hent_person_netvaerk',
    ],
    outputFormat:
      'Inkassorapport: DEBITORPROFIL, AKTIVOVERSIGT (tabel), EJENDOMME (friværdi), VIRKSOMHEDER (egenkapital), SKJULTE AKTIVER, SAMLET FORMUE, UDLÆGSANBEFALING (prioriteret).',
  },
  {
    id: 'kommune-energi',
    label: 'Kommune energi- og planlægning',
    beskrivelse:
      'Bygningsmasse-analyse, energirenoverings-potentiale og CO₂-reduktionsplan for kommuner og boligforeninger',
    ikon: 'Building2',
    instruktioner: `Du er kommunal energiplanlægger. Lav en analyse af bygningsmassen og energirenoverings-potentialet.

HVIS TARGET ER EJENDOM (BFE/adresse) — enkelt-bygningsanalyse:
Kald følgende tools:
1. hent_bbr_data — byggeår, areal, materialer, varmeinstallation, tagmateriale, antal etager.
2. hent_energimaerke — nuværende energimærke (A-G) + forbedringsforslag.
3. hent_vurdering — ejendomsværdi (renoverings-ROI beregning).
4. hent_plandata — lokalplan, bebyggelsesprocent, zoning (mulighed for tilbygning/ombygning).
5. hent_jordforurening — miljørisici.
6. hent_matrikeldata — grundareal, ejerlavkode.

HVIS TARGET ER VIRKSOMHED (CVR) — porteføljeanalyse (boligforening/ejendomsselskab):
Kald følgende tools:
1. hent_cvr_virksomhed — grunddata.
2. hent_ejendomme_for_virksomhed — alle ejede bygninger.
3. For hver ejendom: hent_bbr_data + hent_energimaerke + hent_vurdering.

Analysér:
VARMEKILDER — fordeling: fjernvarme / varmepumpe / naturgas / oliefyr / elvarme. Flag olie/gas som udskiftningskandidater.
ENERGIMÆRKER — fordeling A-G. Beregn potentiel forbedring per bygning.
BYGNINGSALDER — fordeling per årti. Byggeår < 1960 = typisk dårlig isolering. 1960-1980 = betonelementbyggeri med kuldebroer.
TAGMATERIALER — asbest-flag for eternittage før 1988.

Rapport-sektioner:
BYGNINGSOVERSIGT — tabel med adresse, byggeår, areal, energimærke, varmekilde.
ENERGIMÆRKEFORDELING — fordeling A-G med antal og procent.
VARMEKILDEANALYSE — fordeling med CO₂-estimat per type.
RENOVERINGSPOTENTIALE — bygninger med størst potentiale (energimærke E-G, olie/gas-opvarmning).
PRIORITERET HANDLINGSPLAN — top 10 bygninger sorteret efter CO₂-reduktion/investering ratio.
ESTIMERET CO₂-BESPARELSE — samlet årlig CO₂-reduktion ved fuld renovering.`,
    anbefaletTools: [
      'hent_bbr_data',
      'hent_energimaerke',
      'hent_vurdering',
      'hent_plandata',
      'hent_jordforurening',
      'hent_matrikeldata',
      'hent_cvr_virksomhed',
      'hent_ejendomme_for_virksomhed',
    ],
    outputFormat:
      'Energirapport: BYGNINGSOVERSIGT (tabel), ENERGIMÆRKEFORDELING, VARMEKILDEANALYSE, RENOVERINGSPOTENTIALE, PRIORITERET HANDLINGSPLAN, ESTIMERET CO₂-BESPARELSE.',
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
