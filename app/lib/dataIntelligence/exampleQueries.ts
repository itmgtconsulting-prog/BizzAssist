/**
 * exampleQueries — Persona-baserede few-shot eksempler til Data Intelligence (BIZZ-1559).
 *
 * Minimumskrav per ticket: 10 eksempler per persona × 3 personaer = 30 eksempler.
 * Hver eksempel er en kanonisk SQL-baseline som AI'en kan one-shot'e eller bygge videre på.
 *
 * Personaer:
 * - journalist: byrum/lokalavis/almindelig boligkøber — fokus på antal, fordelinger, top-N
 * - finans: bankrådgiver/realkredit/formueforvalter — fokus på værdier, ejerskab, koncerner
 * - maegler: ejendomsmægler/investor — fokus på handler, m²-priser, sammenligninger
 *
 * @module app/lib/dataIntelligence/exampleQueries
 */

/** Persona-kategorier */
export type QueryPersona = 'journalist' | 'finans' | 'maegler' | 'general';

/** Forventet chart-type til output-rendering */
export type ChartHint = 'line' | 'bar' | 'pie' | 'table' | 'scorecard';

/** Difficulty-niveau — påvirker prompt-vægtning */
export type QueryDifficulty = 'simple' | 'medium' | 'complex';

/** Ét kurateret eksempel-spørgsmål med tilhørende SQL */
export interface ExampleQuery {
  /** Stabil ID til reference/debugging */
  id: string;
  /** Persona-tag */
  persona: QueryPersona;
  /** Brugerens naturlige spørgsmål på dansk */
  question: string;
  /** Kanonisk SQL — KORREKT på vores skema */
  sql: string;
  /** Forventet chart-rendering */
  chartHint: ChartHint;
  /** Kompleksitet */
  difficulty: QueryDifficulty;
  /** Tags til kategorisering/filtrering */
  tags: string[];
}

/**
 * Det fulde eksempel-bibliotek.
 *
 * Inkluderer mindst 30 eksempler fordelt på 3 personaer + general.
 * Kuraterede fra reelle bruger-mønstre + canonicalized SQL.
 */
export const EXAMPLE_QUERIES: ExampleQuery[] = [
  // ───── JOURNALIST (10 eksempler) ─────
  {
    id: 'j-total-virksomheder',
    persona: 'journalist',
    question: 'Hvor mange virksomheder er der i alt?',
    sql: 'SELECT COUNT(*) AS antal FROM public.cvr_virksomhed LIMIT 1',
    chartHint: 'scorecard',
    difficulty: 'simple',
    tags: ['count', 'cvr'],
  },
  {
    id: 'j-virksomheder-stiftet-30d',
    persona: 'journalist',
    question: 'Virksomheder stiftet de seneste 30 dage',
    sql: "SELECT cvr, navn, stiftet FROM public.cvr_virksomhed WHERE stiftet >= CURRENT_DATE - INTERVAL '30 days' ORDER BY stiftet DESC LIMIT 1000",
    chartHint: 'table',
    difficulty: 'simple',
    tags: ['cvr', 'tid'],
  },
  {
    id: 'j-top10-brancher',
    persona: 'journalist',
    question: 'Top 10 brancher efter antal aktive virksomheder',
    sql: 'SELECT branche_tekst, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE ophoert IS NULL AND branche_tekst IS NOT NULL GROUP BY branche_tekst ORDER BY antal DESC LIMIT 10',
    chartHint: 'bar',
    difficulty: 'simple',
    tags: ['branche', 'top-n'],
  },
  {
    id: 'j-kommune-flest-virksomheder',
    persona: 'journalist',
    question: 'Hvilken kommune har flest virksomheder?',
    sql: "WITH x AS (SELECT (adresse_json->'kommune'->>'kommuneKode')::int AS kk, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE adresse_json->'kommune'->>'kommuneKode' IS NOT NULL GROUP BY kk) SELECT k.kommunenavn, x.antal FROM x JOIN public.kommune_ref k ON k.kommune_kode = x.kk ORDER BY x.antal DESC LIMIT 10",
    chartHint: 'bar',
    difficulty: 'medium',
    tags: ['kommune', 'top-n'],
  },
  {
    id: 'j-ejendomme-uden-energimaerke',
    persona: 'journalist',
    question: 'Hvor mange ejendomme mangler energimærke?',
    sql: 'SELECT COUNT(*) FILTER (WHERE energimaerke IS NULL) AS mangler, COUNT(*) AS total FROM public.bbr_ejendom_status WHERE is_udfaset = false LIMIT 1',
    chartHint: 'scorecard',
    difficulty: 'simple',
    tags: ['energi', 'bbr'],
  },
  {
    id: 'j-fordeling-energimaerker',
    persona: 'journalist',
    question: 'Fordeling af energimærker',
    sql: 'SELECT energimaerke, COUNT(*) AS antal FROM public.bbr_ejendom_status WHERE energimaerke IS NOT NULL AND is_udfaset = false GROUP BY energimaerke ORDER BY antal DESC LIMIT 20',
    chartHint: 'bar',
    difficulty: 'simple',
    tags: ['energi', 'fordeling'],
  },
  {
    id: 'j-fordeling-opvarmning',
    persona: 'journalist',
    question: 'Fordeling af opvarmningsformer',
    sql: 'SELECT opvarmningsform, COUNT(*) AS antal FROM public.bbr_ejendom_status WHERE opvarmningsform IS NOT NULL AND is_udfaset = false GROUP BY opvarmningsform ORDER BY antal DESC LIMIT 20',
    chartHint: 'pie',
    difficulty: 'simple',
    tags: ['opvarmning', 'fordeling'],
  },
  {
    id: 'j-ejerskifter-12m',
    persona: 'journalist',
    question: 'Ejerskifter per måned de seneste 12 måneder',
    sql: "SELECT to_char(date_trunc('month', virkning_fra), 'YYYY-MM') AS maaned, COUNT(*) AS antal_ejerskifter FROM public.ejf_ejerskab WHERE status = 'gældende' AND virkning_fra >= CURRENT_DATE - INTERVAL '12 months' AND virkning_fra IS NOT NULL GROUP BY maaned ORDER BY maaned DESC",
    chartHint: 'line',
    difficulty: 'medium',
    tags: ['ejerskifte', 'tid'],
  },
  {
    id: 'j-top-virksomhedsformer',
    persona: 'journalist',
    question: 'Top 20 virksomhedsformer',
    sql: 'SELECT virksomhedsform, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE virksomhedsform IS NOT NULL GROUP BY virksomhedsform ORDER BY antal DESC LIMIT 20',
    chartHint: 'bar',
    difficulty: 'simple',
    tags: ['virksomhedsform'],
  },
  {
    id: 'j-nyeste-ejendomsdata',
    persona: 'journalist',
    question: 'Hvad er den nyeste ejendomsdata?',
    sql: 'SELECT MAX(sidst_opdateret) AS nyeste FROM public.ejf_ejerskab LIMIT 1',
    chartHint: 'scorecard',
    difficulty: 'simple',
    tags: ['fresh'],
  },

  // ───── FINANS (10 eksempler) ─────
  {
    id: 'f-top-omsaetning',
    persona: 'finans',
    question: 'Top 10 virksomheder efter omsætning',
    sql: 'SELECT v.cvr, v.navn, r.omsaetning, r.seneste_aar FROM public.regnskab_cache r JOIN public.cvr_virksomhed v ON v.cvr = r.cvr WHERE r.omsaetning IS NOT NULL ORDER BY r.omsaetning DESC LIMIT 10',
    chartHint: 'table',
    difficulty: 'simple',
    tags: ['regnskab', 'top-n'],
  },
  {
    id: 'f-top-egenkapital',
    persona: 'finans',
    question: 'Top 10 virksomheder efter egenkapital',
    sql: 'SELECT v.cvr, v.navn, r.egenkapital, r.seneste_aar FROM public.regnskab_cache r JOIN public.cvr_virksomhed v ON v.cvr = r.cvr WHERE r.egenkapital IS NOT NULL ORDER BY r.egenkapital DESC LIMIT 10',
    chartHint: 'table',
    difficulty: 'simple',
    tags: ['regnskab', 'top-n'],
  },
  {
    id: 'f-virksomheder-flere-end-5-ejendomme',
    persona: 'finans',
    question: 'Find virksomheder der ejer mere end 5 ejendomme',
    sql: "SELECT ejer_cvr, COUNT(*) AS antal_ejendomme FROM public.ejf_ejerskab WHERE ejer_cvr IS NOT NULL AND status = 'gældende' GROUP BY ejer_cvr HAVING COUNT(*) > 5 ORDER BY antal_ejendomme DESC LIMIT 100",
    chartHint: 'table',
    difficulty: 'medium',
    tags: ['ejerskab', 'koncern'],
  },
  {
    id: 'f-gns-vurdering-kommune',
    persona: 'finans',
    question: 'Top 10 kommuner efter gennemsnitlig ejendomsvurdering',
    sql: 'SELECT b.kommune_kode, k.kommunenavn, AVG(v.ejendomsvaerdi)::bigint AS gennemsnit, COUNT(*) AS antal FROM public.vurdering_cache v JOIN public.bbr_ejendom_status b ON b.bfe_nummer = v.bfe_nummer JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE v.ejendomsvaerdi IS NOT NULL GROUP BY b.kommune_kode, k.kommunenavn ORDER BY gennemsnit DESC LIMIT 10',
    chartHint: 'bar',
    difficulty: 'medium',
    tags: ['vurdering', 'kommune'],
  },
  {
    id: 'f-gns-vurdering-parcelhus',
    persona: 'finans',
    question: 'Gennemsnitsvurdering af parcelhuse i 2024',
    sql: 'SELECT AVG(v.ejendomsvaerdi)::bigint AS gennemsnit, COUNT(*) AS antal FROM public.vurdering_cache v JOIN public.bbr_ejendom_status b ON b.bfe_nummer = v.bfe_nummer WHERE v.vurderingsaar = 2024 AND b.byg021_anvendelse = 120 LIMIT 1',
    chartHint: 'scorecard',
    difficulty: 'medium',
    tags: ['vurdering', 'parcelhus'],
  },
  {
    id: 'f-aktive-vs-ophorte',
    persona: 'finans',
    question: 'Hvor mange virksomheder er aktive vs ophørte?',
    sql: "SELECT CASE WHEN ophoert IS NULL THEN 'aktiv' ELSE 'ophørt' END AS status, COUNT(*) AS antal FROM public.cvr_virksomhed GROUP BY status",
    chartHint: 'pie',
    difficulty: 'simple',
    tags: ['cvr', 'fordeling'],
  },
  {
    id: 'f-negativ-aarsresultat',
    persona: 'finans',
    question: 'Virksomheder med negativ årets resultat i seneste regnskab',
    sql: 'SELECT v.cvr, v.navn, r.aarsresultat, r.seneste_aar FROM public.regnskab_cache r JOIN public.cvr_virksomhed v ON v.cvr = r.cvr WHERE r.aarsresultat < 0 ORDER BY r.aarsresultat ASC LIMIT 50',
    chartHint: 'table',
    difficulty: 'simple',
    tags: ['regnskab', 'risiko'],
  },
  {
    id: 'f-stoerste-ejendomsejere',
    persona: 'finans',
    question: 'Top 20 største ejendomsejere efter samlet ejendomsværdi',
    sql: "SELECT e.ejer_cvr, v.navn, COUNT(*) AS antal_ejendomme, SUM(vc.ejendomsvaerdi)::bigint AS samlet_vaerdi FROM public.ejf_ejerskab e JOIN public.vurdering_cache vc ON vc.bfe_nummer = e.bfe_nummer LEFT JOIN public.cvr_virksomhed v ON v.cvr = e.ejer_cvr WHERE e.ejer_cvr IS NOT NULL AND e.status = 'gældende' AND vc.ejendomsvaerdi IS NOT NULL GROUP BY e.ejer_cvr, v.navn ORDER BY samlet_vaerdi DESC LIMIT 20",
    chartHint: 'table',
    difficulty: 'complex',
    tags: ['ejerskab', 'vurdering', 'top-n'],
  },
  {
    id: 'f-nye-virksomheder-branche',
    persona: 'finans',
    question: 'Nye virksomheder per branche i 2025',
    sql: "SELECT branche_tekst, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE stiftet >= '2025-01-01' AND branche_tekst IS NOT NULL GROUP BY branche_tekst ORDER BY antal DESC LIMIT 20",
    chartHint: 'bar',
    difficulty: 'simple',
    tags: ['cvr', 'branche', 'tid'],
  },
  {
    id: 'f-holdings-uden-aktivitet',
    persona: 'finans',
    question: 'Aktive holdingvirksomheder uden ansatte',
    sql: "SELECT cvr, navn, branche_tekst FROM public.cvr_virksomhed WHERE ophoert IS NULL AND branche_kode LIKE '642%' AND COALESCE(ansatte_aar, 0) = 0 LIMIT 100",
    chartHint: 'table',
    difficulty: 'medium',
    tags: ['cvr', 'holding'],
  },

  // ───── MÆGLER (10 eksempler) ─────
  {
    id: 'm-gns-m2pris-2025',
    persona: 'maegler',
    question: 'Gennemsnitlig m²-pris for solgte huse i 2025',
    sql: "SELECT AVG(m2_pris)::int AS gns_m2_pris, COUNT(*) AS antal FROM public.ejerskifte_historik WHERE m2_pris IS NOT NULL AND overtagelsesdato >= '2025-01-01' AND overtagelsesdato < '2026-01-01' AND byg021_anvendelse BETWEEN 110 AND 190 LIMIT 1",
    chartHint: 'scorecard',
    difficulty: 'medium',
    tags: ['m2-pris', 'hus'],
  },
  {
    id: 'm-top-kommuner-pris',
    persona: 'maegler',
    question: 'Top 10 kommuner med højest gennemsnitspris for ejendomme',
    sql: 'SELECT e.kommune_kode, k.kommunenavn, AVG(e.kontant_koebesum)::bigint AS gns_pris, COUNT(*) AS antal FROM public.ejerskifte_historik e JOIN public.kommune_ref k ON k.kommune_kode = e.kommune_kode WHERE e.kontant_koebesum IS NOT NULL AND e.kommune_kode IS NOT NULL GROUP BY e.kommune_kode, k.kommunenavn HAVING COUNT(*) >= 5 ORDER BY gns_pris DESC LIMIT 10',
    chartHint: 'bar',
    difficulty: 'medium',
    tags: ['pris', 'kommune'],
  },
  {
    id: 'm-dyreste-handler',
    persona: 'maegler',
    question: 'Dyreste ejendomshandler de seneste 12 måneder',
    sql: "SELECT bfe_nummer, ejer_navn, kontant_koebesum, overtagelsesdato, kommune_kode FROM public.ejerskifte_historik WHERE kontant_koebesum IS NOT NULL AND overtagelsesdato >= CURRENT_DATE - INTERVAL '12 months' ORDER BY kontant_koebesum DESC LIMIT 20",
    chartHint: 'table',
    difficulty: 'simple',
    tags: ['pris', 'top-n'],
  },
  {
    id: 'm-boliger-solgt-2025',
    persona: 'maegler',
    question: 'Hvor mange boliger er solgt i 2025?',
    sql: "SELECT COUNT(*) AS antal_ejerskifter, COUNT(kontant_koebesum) AS med_pris FROM public.ejerskifte_historik WHERE overtagelsesdato >= '2025-01-01' AND overtagelsesdato < '2026-01-01' LIMIT 1",
    chartHint: 'scorecard',
    difficulty: 'simple',
    tags: ['salg', 'tid'],
  },
  {
    id: 'm-gns-boligareal-kommune',
    persona: 'maegler',
    question: 'Gennemsnitligt boligareal per kommune',
    sql: 'SELECT b.kommune_kode, k.kommunenavn, AVG(b.samlet_boligareal)::int AS gennemsnitligt_boligareal, COUNT(*) AS antal FROM public.bbr_ejendom_status b JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE b.samlet_boligareal IS NOT NULL AND b.samlet_boligareal > 0 AND b.is_udfaset = false GROUP BY b.kommune_kode, k.kommunenavn ORDER BY antal DESC LIMIT 50',
    chartHint: 'table',
    difficulty: 'medium',
    tags: ['areal', 'kommune'],
  },
  {
    id: 'm-store-ejendomme-aarhus',
    persona: 'maegler',
    question: 'Ejendomme i Aarhus med samlet boligareal over 200 m²',
    sql: 'SELECT bfe_nummer, samlet_boligareal, opfoerelsesaar FROM public.bbr_ejendom_status WHERE kommune_kode = 751 AND samlet_boligareal > 200 AND is_udfaset = false ORDER BY samlet_boligareal DESC LIMIT 1000',
    chartHint: 'table',
    difficulty: 'simple',
    tags: ['areal', 'kommune', 'filter'],
  },
  {
    id: 'm-fordeling-ejendomstyper',
    persona: 'maegler',
    question: 'Fordeling af ejendomstyper (parcelhus, etagebolig, erhverv)',
    sql: 'SELECT byg021_anvendelse, COUNT(*) AS antal FROM public.bbr_ejendom_status WHERE byg021_anvendelse IS NOT NULL AND is_udfaset = false GROUP BY byg021_anvendelse ORDER BY antal DESC LIMIT 50',
    chartHint: 'pie',
    difficulty: 'simple',
    tags: ['type', 'fordeling'],
  },
  {
    id: 'm-pris-pr-md-kommune',
    persona: 'maegler',
    question: 'Salgspriser per måned i Hvidovre 2025',
    sql: "SELECT to_char(date_trunc('month', overtagelsesdato), 'YYYY-MM') AS maaned, AVG(kontant_koebesum)::bigint AS gns_pris, COUNT(*) AS antal FROM public.ejerskifte_historik WHERE kommune_kode = 167 AND kontant_koebesum IS NOT NULL AND overtagelsesdato >= '2025-01-01' AND overtagelsesdato < '2026-01-01' GROUP BY maaned ORDER BY maaned",
    chartHint: 'line',
    difficulty: 'complex',
    tags: ['pris', 'tid', 'kommune'],
  },
  {
    id: 'm-boliger-fordelt-type-md',
    persona: 'maegler',
    question:
      'Antal boliger fordelt på huse og lejligheder solgt i Hvidovre over de sidste 12 måneder pr. måned',
    sql: "SELECT to_char(date_trunc('month', overtagelsesdato), 'YYYY-MM') AS maaned, COUNT(*) FILTER (WHERE byg021_anvendelse BETWEEN 110 AND 130) AS huse, COUNT(*) FILTER (WHERE byg021_anvendelse = 140) AS lejligheder, COUNT(*) AS total FROM public.ejerskifte_historik WHERE kommune_kode = 167 AND overtagelsesdato >= CURRENT_DATE - INTERVAL '12 months' GROUP BY maaned ORDER BY maaned DESC",
    chartHint: 'line',
    difficulty: 'complex',
    tags: ['salg', 'type', 'kommune', 'multi-series'],
  },
  {
    id: 'm-nye-ejendomme-aar',
    persona: 'maegler',
    question: 'Nybyggede ejendomme i 2024 per kommune',
    sql: 'SELECT b.kommune_kode, k.kommunenavn, COUNT(*) AS antal FROM public.bbr_ejendom_status b JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode WHERE b.opfoerelsesaar = 2024 GROUP BY b.kommune_kode, k.kommunenavn ORDER BY antal DESC LIMIT 20',
    chartHint: 'bar',
    difficulty: 'simple',
    tags: ['nybyggeri', 'kommune'],
  },
];

/**
 * Filtrér eksempler efter persona.
 *
 * @param persona - Persona-tag
 * @returns Eksempler for den persona
 */
export function getExamplesByPersona(persona: QueryPersona): ExampleQuery[] {
  return EXAMPLE_QUERIES.filter((e) => e.persona === persona);
}

/**
 * Formatér eksempler til AI-prompt sektion.
 * Inkluderer kun spørgsmål + SQL — ikke metadata.
 *
 * @param maxExamples - Max antal eksempler at inkludere (default: alle)
 * @returns Markdown-formatteret eksempel-sektion
 */
export function formatExamplesForPrompt(maxExamples?: number): string {
  const list = maxExamples ? EXAMPLE_QUERIES.slice(0, maxExamples) : EXAMPLE_QUERIES;
  return list.map((e) => `Spørgsmål: ${e.question}\nSQL: ${e.sql}`).join('\n\n');
}
