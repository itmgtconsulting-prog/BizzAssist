/**
 * Knowledge Cache Topic Builders — BIZZ-1413..1418 (Fase 2, Lag 2)
 *
 * Pre-beregnede aggregater for typiske AI-spørgsmål. Hver builder returnerer
 * en eller flere knowledge-rækker klar til UPSERT i dataintel.analytics_knowledge.
 *
 * Builders kører isoleret — fejl i én topic stopper ikke andre.
 *
 * @module app/lib/dataIntelligence/topics
 */

import type { SqlRunner } from './buildCatalog';

/** En knowledge-række klar til UPSERT. */
export interface KnowledgeRow {
  topic: string;
  topic_label_da: string;
  key: Record<string, unknown>;
  value: Record<string, unknown>;
  source_query: string;
  expires_at?: string | null;
}

/** Topic builder signature. */
export type TopicBuilder = (rpc: SqlRunner) => Promise<KnowledgeRow[]>;

// ============================================================
// Virksomheder
// ============================================================

/**
 * Topic: virksomheder per kommune. En række per kommune med total + aktiv count.
 */
export const companyByMunicipality: TopicBuilder = async (rpc) => {
  // cvr_virksomhed har ikke kommune_kode direkte; det ligger i adresse_json.
  const sql = `
    SELECT
      ((adresse_json->'kommune'->>'kommuneKode')::int) AS kommune_kode,
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE ophoert IS NULL)::bigint AS aktive
    FROM public.cvr_virksomhed
    WHERE adresse_json->'kommune'->>'kommuneKode' IS NOT NULL
    GROUP BY kommune_kode
    ORDER BY kommune_kode
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'company_count_by_municipality',
    topic_label_da: 'Virksomheder per kommune',
    key: { kommune_kode: Number(r.kommune_kode) },
    value: { total: Number(r.total), aktive: Number(r.aktive) },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: virksomheder per branchekode (top 200 efter antal).
 */
export const companyByIndustry: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT branche_kode, COUNT(*)::bigint AS total
    FROM public.cvr_virksomhed
    WHERE branche_kode IS NOT NULL
    GROUP BY branche_kode
    ORDER BY total DESC
    LIMIT 200
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'company_count_by_industry',
    topic_label_da: 'Virksomheder per branche',
    key: { branche_kode: String(r.branche_kode) },
    value: { total: Number(r.total) },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: global status-fordeling for virksomheder.
 * Vi tæller på ophoert-flag (NULL=aktiv) for at undgå JSON-status-kolonnen.
 */
export const companyStatusDistribution: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      COUNT(*) FILTER (WHERE ophoert IS NULL)::bigint AS aktive,
      COUNT(*) FILTER (WHERE ophoert IS NOT NULL)::bigint AS ophoerte,
      COUNT(*)::bigint AS total
    FROM public.cvr_virksomhed
  `;
  const rows = await rpc(sql);
  const r = rows[0] ?? { aktive: 0, ophoerte: 0, total: 0 };
  return [
    {
      topic: 'company_status_distribution',
      topic_label_da: 'Virksomhedsstatus-fordeling',
      key: {},
      value: {
        aktive: Number(r.aktive),
        ophoerte: Number(r.ophoerte),
        total: Number(r.total),
      },
      source_query: sql.trim(),
    },
  ];
};

// ============================================================
// Ejendomme
// ============================================================

/**
 * Topic: ejendomme per BBR-anvendelseskode (top 50).
 */
export const propertyByType: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT byg021_anvendelse, COUNT(*)::bigint AS total
    FROM public.bbr_ejendom_status
    WHERE byg021_anvendelse IS NOT NULL AND is_udfaset = false
    GROUP BY byg021_anvendelse
    ORDER BY total DESC
    LIMIT 50
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'property_count_by_type',
    topic_label_da: 'Ejendomme per BBR-anvendelseskode',
    key: { anvendelseskode: String(r.byg021_anvendelse) },
    value: { total: Number(r.total) },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: ejendomme per kommune (via mv_analyse_ejendom for ren count).
 */
export const propertyByMunicipality: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT kommune_kode::int AS kommune_kode, kommunenavn, region, COUNT(*)::bigint AS total
    FROM public.mv_analyse_ejendom
    WHERE kommune_kode IS NOT NULL
    GROUP BY kommune_kode, kommunenavn, region
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'property_count_by_municipality',
    topic_label_da: 'Ejendomme per kommune',
    key: { kommune_kode: Number(r.kommune_kode) },
    value: {
      total: Number(r.total),
      kommunenavn: r.kommunenavn,
      region: r.region,
    },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: gennemsnitsvurdering per BBR-anvendelseskode.
 */
export const avgValuationByType: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      b.byg021_anvendelse,
      AVG(v.ejendomsvaerdi)::bigint AS avg_value,
      COUNT(*)::bigint AS antal
    FROM public.vurdering_cache v
    JOIN public.bbr_ejendom_status b ON b.bfe_nummer = v.bfe_nummer
    WHERE v.ejendomsvaerdi IS NOT NULL
      AND b.byg021_anvendelse IS NOT NULL
    GROUP BY b.byg021_anvendelse
    HAVING COUNT(*) >= 5
    ORDER BY antal DESC
    LIMIT 50
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'avg_valuation_by_property_type',
    topic_label_da: 'Gennemsnitsvurdering per ejendomstype',
    key: { anvendelseskode: String(r.byg021_anvendelse) },
    value: { avg_value: Number(r.avg_value), antal: Number(r.antal) },
    source_query: sql.trim(),
  }));
};

// ============================================================
// Data coverage
// ============================================================

/**
 * Topic: hvor mange ejendomme har BBR-data (overall + per kommune).
 * BBR-data defineres som "bbr_status_code IS NOT NULL".
 */
export const dataCoverageBbr: TopicBuilder = async (rpc) => {
  const globalSql = `
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE bbr_status_code IS NOT NULL)::bigint AS with_bbr
    FROM public.bbr_ejendom_status
    WHERE is_udfaset = false
  `;
  const globalRows = await rpc(globalSql);
  const g = globalRows[0] ?? { total: 0, with_bbr: 0 };
  const rows: KnowledgeRow[] = [
    {
      topic: 'data_coverage_bbr',
      topic_label_da: 'BBR-data dækning (global)',
      key: {},
      value: { total: Number(g.total), with_bbr: Number(g.with_bbr) },
      source_query: globalSql.trim(),
    },
  ];

  // Per-kommune (kan være tom hvis bbr_ejendom_status er sparse)
  const perKommuneSql = `
    SELECT kommune_kode::int AS kommune_kode,
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE bbr_status_code IS NOT NULL)::bigint AS with_bbr
    FROM public.bbr_ejendom_status
    WHERE is_udfaset = false AND kommune_kode IS NOT NULL
    GROUP BY kommune_kode
  `;
  const perKommune = await rpc(perKommuneSql);
  for (const r of perKommune) {
    rows.push({
      topic: 'data_coverage_bbr',
      topic_label_da: 'BBR-data dækning per kommune',
      key: { kommune_kode: Number(r.kommune_kode) },
      value: { total: Number(r.total), with_bbr: Number(r.with_bbr) },
      source_query: perKommuneSql.trim(),
    });
  }

  return rows;
};

/**
 * Topic: hvor mange ejendomme har vurderingsdata, fordelt på vurderingsår.
 */
export const dataCoverageValuation: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT vurderingsaar, COUNT(*)::bigint AS total
    FROM public.vurdering_cache
    WHERE vurderingsaar IS NOT NULL
    GROUP BY vurderingsaar
    ORDER BY vurderingsaar DESC
    LIMIT 10
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'data_coverage_valuation',
    topic_label_da: 'Vurderingsdækning per vurderingsår',
    key: { vurderingsaar: Number(r.vurderingsaar) },
    value: { total: Number(r.total) },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: energimærke-dækning. Hvor mange ejendomme har energimærke, og hvilke
 * klasser dominerer.
 */
export const dataCoverageEnergy: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT energimaerke, COUNT(*)::bigint AS total
    FROM public.bbr_ejendom_status
    WHERE energimaerke IS NOT NULL AND is_udfaset = false
    GROUP BY energimaerke
    ORDER BY total DESC
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'data_coverage_energy',
    topic_label_da: 'Energimærke-dækning',
    key: { energimaerke: String(r.energimaerke) },
    value: { total: Number(r.total) },
    source_query: sql.trim(),
  }));
};

// ============================================================
// Ejerskifter (salgs-proxy)
// ============================================================

/**
 * Topic: ejerskifter per måned seneste 24 måneder.
 * Tæller nye gældende ejerskaber som "ejerskifte".
 */
export const ownershipChangesByMonth: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      to_char(date_trunc('month', virkning_fra), 'YYYY-MM') AS maaned,
      COUNT(*)::bigint AS antal_ejerskifter,
      COUNT(DISTINCT bfe_nummer)::bigint AS unikke_ejendomme
    FROM public.ejf_ejerskab
    WHERE status = 'gældende'
      AND virkning_fra >= (CURRENT_DATE - INTERVAL '24 months')
      AND virkning_fra IS NOT NULL
    GROUP BY maaned
    ORDER BY maaned DESC
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'ownership_changes_by_month',
    topic_label_da: 'Ejerskifter per måned',
    key: { maaned: String(r.maaned) },
    value: {
      antal_ejerskifter: Number(r.antal_ejerskifter),
      unikke_ejendomme: Number(r.unikke_ejendomme),
    },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: ejerskifter per ejer-type (person vs virksomhed).
 */
export const ownershipChangesByType: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      ejer_type,
      COUNT(*)::bigint AS gaeldende,
      COUNT(*) FILTER (WHERE virkning_til IS NOT NULL)::bigint AS historiske
    FROM public.ejf_ejerskab
    WHERE ejer_type IS NOT NULL
    GROUP BY ejer_type
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'ownership_by_type',
    topic_label_da: 'Ejerskaber per ejer-type',
    key: { ejer_type: String(r.ejer_type) },
    value: {
      gaeldende: Number(r.gaeldende),
      historiske: Number(r.historiske),
    },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: top 50 virksomheder med flest ejendomme (gældende ejerskaber).
 */
export const topPropertyOwnerCompanies: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      ejer_cvr,
      ejer_navn,
      COUNT(DISTINCT bfe_nummer)::bigint AS antal_ejendomme
    FROM public.ejf_ejerskab
    WHERE ejer_cvr IS NOT NULL
      AND status = 'gældende'
    GROUP BY ejer_cvr, ejer_navn
    ORDER BY antal_ejendomme DESC
    LIMIT 50
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'top_property_owner_companies',
    topic_label_da: 'Top virksomheder efter antal ejendomme',
    key: { ejer_cvr: String(r.ejer_cvr) },
    value: {
      ejer_navn: String(r.ejer_navn ?? ''),
      antal_ejendomme: Number(r.antal_ejendomme),
    },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: ejendomme per kommune (direkte fra bbr_ejendom_status, fallback for tom MV).
 */
export const propertyByMunicipalityBbr: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      b.kommune_kode::int AS kommune_kode,
      k.kommunenavn,
      COUNT(*)::bigint AS total
    FROM public.bbr_ejendom_status b
    JOIN public.kommune_ref k ON k.kommune_kode = b.kommune_kode
    WHERE b.is_udfaset = false AND b.kommune_kode IS NOT NULL
    GROUP BY b.kommune_kode, k.kommunenavn
    ORDER BY total DESC
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'property_count_by_municipality_bbr',
    topic_label_da: 'Ejendomme per kommune (BBR)',
    key: { kommune_kode: Number(r.kommune_kode) },
    value: {
      total: Number(r.total),
      kommunenavn: String(r.kommunenavn ?? ''),
    },
    source_query: sql.trim(),
  }));
};

// ============================================================
// Misc
// ============================================================

/**
 * Topic: hvor stor en andel af virksomheder har ejerskabsdata.
 */
export const ownershipDistribution: TopicBuilder = async (rpc) => {
  // cvr_virksomhed_ejerskab.ejet_cvr peger på den ejede virksomheds CVR.
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM public.cvr_virksomhed WHERE ophoert IS NULL)::bigint AS aktive_virksomheder,
      (SELECT COUNT(DISTINCT ejet_cvr) FROM public.cvr_virksomhed_ejerskab)::bigint AS med_ejerskab
  `;
  const rows = await rpc(sql);
  const r = rows[0] ?? { aktive_virksomheder: 0, med_ejerskab: 0 };
  return [
    {
      topic: 'ownership_distribution',
      topic_label_da: 'Virksomheder med ejerskabsdata',
      key: {},
      value: {
        aktive_virksomheder: Number(r.aktive_virksomheder),
        med_ejerskab: Number(r.med_ejerskab),
      },
      source_query: sql.trim(),
    },
  ];
};

/**
 * Topic: nye virksomheder per måned seneste 12 måneder.
 */
export const recentRegistrations: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      to_char(date_trunc('month', stiftet), 'YYYY-MM') AS maaned,
      COUNT(*)::bigint AS total
    FROM public.cvr_virksomhed
    WHERE stiftet >= (CURRENT_DATE - INTERVAL '12 months')
    GROUP BY maaned
    ORDER BY maaned DESC
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'recent_company_registrations',
    topic_label_da: 'Nye virksomheder per måned',
    key: { maaned: String(r.maaned) },
    value: { total: Number(r.total) },
    source_query: sql.trim(),
  }));
};

/**
 * Topic: ældste og nyeste data per tabel.
 */
export const temporalCoverage: TopicBuilder = async (rpc) => {
  const queries = [
    { table: 'cvr_virksomhed', col: 'stiftet' },
    { table: 'cvr_virksomhed', col: 'sidst_opdateret' },
    { table: 'ejf_ejerskab', col: 'virkning_fra' },
    { table: 'ejf_ejerskab', col: 'sidst_opdateret' },
    { table: 'vurdering_cache', col: 'vurderingsaar' },
  ];
  const rows: KnowledgeRow[] = [];
  for (const q of queries) {
    const sql = `SELECT MIN(${q.col})::text AS min_v, MAX(${q.col})::text AS max_v FROM public.${q.table} WHERE ${q.col} IS NOT NULL`;
    try {
      const res = await rpc(sql);
      const r = res[0] ?? { min_v: null, max_v: null };
      rows.push({
        topic: 'temporal_coverage',
        topic_label_da: 'Datadækning over tid',
        key: { table: q.table, column: q.col },
        value: { min: r.min_v, max: r.max_v },
        source_query: sql,
      });
    } catch {
      /* Skip kolonner der ikke findes */
    }
  }
  return rows;
};

// ============================================================
// Pris-trends (ejerskifte_historik)
// ============================================================

/**
 * Topic: gennemsnitlig købesum per kvartal (seneste 3 år).
 */
export const priceTrendsByQuarter: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      to_char(date_trunc('quarter', overtagelsesdato), 'YYYY-"Q"Q') AS kvartal,
      AVG(kontant_koebesum)::bigint AS gns_pris,
      COUNT(*)::bigint AS antal_handler
    FROM public.ejerskifte_historik
    WHERE kontant_koebesum IS NOT NULL
      AND overtagelsesdato >= CURRENT_DATE - INTERVAL '3 years'
    GROUP BY kvartal
    ORDER BY kvartal DESC
  `;
  try {
    const rows = await rpc(sql);
    return rows.map((r) => ({
      topic: 'price_trends_by_quarter',
      topic_label_da: 'Pristrend per kvartal',
      key: { kvartal: String(r.kvartal) },
      value: { gns_pris: Number(r.gns_pris), antal_handler: Number(r.antal_handler) },
      source_query: sql.trim(),
    }));
  } catch {
    return [];
  }
};

/**
 * Topic: gennemsnitlig m²-pris per kommune (top 50).
 */
export const m2PriceByMunicipality: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      e.kommune_kode::int AS kommune_kode,
      k.kommunenavn,
      AVG(e.m2_pris)::int AS gns_m2_pris,
      COUNT(*)::bigint AS antal
    FROM public.ejerskifte_historik e
    JOIN public.kommune_ref k ON k.kommune_kode = e.kommune_kode
    WHERE e.m2_pris IS NOT NULL AND e.kommune_kode IS NOT NULL
    GROUP BY e.kommune_kode, k.kommunenavn
    HAVING COUNT(*) >= 5
    ORDER BY gns_m2_pris DESC
    LIMIT 50
  `;
  try {
    const rows = await rpc(sql);
    return rows.map((r) => ({
      topic: 'm2_price_by_municipality',
      topic_label_da: 'M²-pris per kommune',
      key: { kommune_kode: Number(r.kommune_kode) },
      value: {
        kommunenavn: String(r.kommunenavn ?? ''),
        gns_m2_pris: Number(r.gns_m2_pris),
        antal: Number(r.antal),
      },
      source_query: sql.trim(),
    }));
  } catch {
    return [];
  }
};

// ============================================================
// Master view topics (BIZZ-1479)
// ============================================================

/**
 * Topic: Top kommuner efter gennemsnitlig ejendomsvurdering.
 */
export const topVurderingByMunicipality: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      m.kommune_kode::int AS kommune_kode,
      m.kommunenavn,
      AVG(m.ejendomsvaerdi)::bigint AS gns_vurdering,
      COUNT(*)::bigint AS antal
    FROM public.mv_ejendom_master m
    WHERE m.ejendomsvaerdi IS NOT NULL AND m.kommune_kode IS NOT NULL
    GROUP BY m.kommune_kode, m.kommunenavn
    HAVING COUNT(*) >= 10
    ORDER BY gns_vurdering DESC
    LIMIT 50
  `;
  try {
    const rows = await rpc(sql);
    return rows.map((r) => ({
      topic: 'top_vurdering_by_municipality',
      topic_label_da: 'Gennemsnitsvurdering per kommune',
      key: { kommune_kode: Number(r.kommune_kode) },
      value: {
        kommunenavn: String(r.kommunenavn ?? ''),
        gns_vurdering: Number(r.gns_vurdering),
        antal: Number(r.antal),
      },
      source_query: sql.trim(),
    }));
  } catch {
    return [];
  }
};

/**
 * Topic: regnskabsstatistik — omsætning + egenkapital aggregater.
 */
export const regnskabSummary: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      COUNT(*)::bigint AS total_regnskaber,
      COUNT(*) FILTER (WHERE omsaetning IS NOT NULL)::bigint AS med_omsaetning,
      AVG(omsaetning) FILTER (WHERE omsaetning IS NOT NULL AND omsaetning > 0)::bigint AS gns_omsaetning,
      COUNT(*) FILTER (WHERE egenkapital IS NOT NULL)::bigint AS med_egenkapital
    FROM public.regnskab_cache
  `;
  try {
    const rows = await rpc(sql);
    const r = rows[0] ?? {};
    return [
      {
        topic: 'regnskab_summary',
        topic_label_da: 'Regnskabs-dækning og gennemsnit',
        key: {},
        value: {
          total_regnskaber: Number(r.total_regnskaber ?? 0),
          med_omsaetning: Number(r.med_omsaetning ?? 0),
          gns_omsaetning: Number(r.gns_omsaetning ?? 0),
          med_egenkapital: Number(r.med_egenkapital ?? 0),
        },
        source_query: sql.trim(),
      },
    ];
  } catch {
    return [];
  }
};

// ============================================================
// Virksomhedshandel M&A-radar (BIZZ-1930)
// ============================================================

/**
 * Topic: virksomhedshandel-kandidater per kommune.
 * Aggregerer signal_type counts per kommune for hurtige M&A-radar opslag.
 */
export const virksomhedshandelByMunicipality: TopicBuilder = async (rpc) => {
  const sql = `
    SELECT
      (v.adresse_json->'kommune'->>'kommuneKode')::int AS kommune_kode,
      k.signal_type,
      COUNT(*)::bigint AS antal
    FROM public.mv_virksomhedshandel_kandidater k
    JOIN public.cvr_virksomhed v ON v.cvr = k.virksomhed_cvr
    WHERE k.signal_type != 'unchanged'
      AND k.gyldig_fra >= CURRENT_DATE - INTERVAL '365 days'
      AND v.adresse_json->'kommune'->>'kommuneKode' IS NOT NULL
    GROUP BY kommune_kode, k.signal_type
    ORDER BY antal DESC
    LIMIT 500
  `;
  const rows = await rpc(sql);
  return rows.map((r) => ({
    topic: 'virksomhedshandel_by_municipality',
    topic_label_da: 'Virksomhedshandler per kommune',
    key: { kommune_kode: Number(r.kommune_kode), signal_type: r.signal_type },
    value: { antal: Number(r.antal) },
    source_query: sql.trim(),
  }));
};

// ============================================================
// Topic registry
// ============================================================

export const ALL_TOPICS: Array<{ name: string; build: TopicBuilder }> = [
  { name: 'company_count_by_municipality', build: companyByMunicipality },
  { name: 'company_count_by_industry', build: companyByIndustry },
  { name: 'company_status_distribution', build: companyStatusDistribution },
  { name: 'property_count_by_type', build: propertyByType },
  { name: 'property_count_by_municipality', build: propertyByMunicipality },
  { name: 'avg_valuation_by_property_type', build: avgValuationByType },
  { name: 'data_coverage_bbr', build: dataCoverageBbr },
  { name: 'data_coverage_valuation', build: dataCoverageValuation },
  { name: 'data_coverage_energy', build: dataCoverageEnergy },
  { name: 'ownership_distribution', build: ownershipDistribution },
  { name: 'recent_company_registrations', build: recentRegistrations },
  { name: 'temporal_coverage', build: temporalCoverage },
  { name: 'ownership_changes_by_month', build: ownershipChangesByMonth },
  { name: 'ownership_by_type', build: ownershipChangesByType },
  { name: 'top_property_owner_companies', build: topPropertyOwnerCompanies },
  { name: 'property_count_by_municipality_bbr', build: propertyByMunicipalityBbr },
  { name: 'price_trends_by_quarter', build: priceTrendsByQuarter },
  { name: 'm2_price_by_municipality', build: m2PriceByMunicipality },
  { name: 'top_vurdering_by_municipality', build: topVurderingByMunicipality },
  { name: 'regnskab_summary', build: regnskabSummary },
  { name: 'virksomhedshandel_by_municipality', build: virksomhedshandelByMunicipality },
];
