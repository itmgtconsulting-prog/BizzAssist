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
];
