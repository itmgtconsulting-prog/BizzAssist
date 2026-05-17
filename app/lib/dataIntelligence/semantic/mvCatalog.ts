/**
 * Materialized view-katalog for Data Intelligence cache-router (BIZZ-1565).
 *
 * Beskriver pre-aggregeret MV-tabeller og deres "shape" — hvilke metrics +
 * dimensions de dækker. Når en QueryPlan matcher en MV's shape (samme eller
 * subset af metrics/dims), kan compileren omskrive plan til at læse fra
 * MV'en i stedet for de fulde fact-tabeller.
 *
 * Pt. er katalogeren tom — selve MV'erne deployes i et follow-up når:
 *   1. Compiler-omskrivning til MV-shape er testet
 *   2. REFRESH MATERIALIZED VIEW CONCURRENTLY er verificeret på prod-skala
 *   3. Vi har drift-data fra L2.3-pipeline der retfærdiggør hvilke MV'er
 *      har højest cache-værdi
 *
 * Når MV'erne tilføjes: udfyld MV_REGISTRY med entries der matcher de
 * faktiske MV-tabeller i db.
 *
 * @module app/lib/dataIntelligence/semantic/mvCatalog
 */

import type { QueryPlan } from './queryPlan';

/** Definition af én materialized view */
export interface MvDefinition {
  /** Postgres-tabel-navn (uden schema) */
  name: string;
  /** Schema (typisk 'public') */
  schema: string;
  /** Hvilke metric-navne MV'en pre-aggregerer */
  metrics: string[];
  /** Hvilke dimension-navne MV'en grupperer på */
  dimensions: string[];
  /** Map fra metric-katalog-navn til kolonne-navn i MV */
  metricColumns: Record<string, string>;
  /** Map fra dimension-katalog-navn til kolonne-navn i MV */
  dimensionColumns: Record<string, string>;
  /** Beskrivelse til logging */
  description: string;
}

/**
 * Registreret MV'er. TOM PT. — udfyldes når MV'erne deployes via migration.
 *
 * Eksempel-entry (når implementeret):
 *   {
 *     name: 'intel_mv_handler_kommune_maaned',
 *     schema: 'public',
 *     metrics: ['count_handler', 'avg_koebesum', 'sum_koebesum'],
 *     dimensions: ['kommune_kode', 'maaned'],
 *     metricColumns: { count_handler: 'count_handler', ... },
 *     dimensionColumns: { kommune_kode: 'kommune_kode', maaned: 'maaned' },
 *     description: 'Handler aggregeret per kommune × måned',
 *   }
 */
export const MV_REGISTRY: MvDefinition[] = [];

/**
 * Find første MV der dækker planens metrics + dimensions præcist.
 * Returnerer null ved miss.
 *
 * Match-regel: MV's metrics-set er superset af plan.metrics OG MV's
 * dimensions-set matcher plan.dimensions præcist (samme set, rækkefølge
 * irrelevant). Dette sikrer at GROUP BY-aggregeringen er korrekt.
 */
export function findMatchingMv(plan: QueryPlan): MvDefinition | null {
  if (plan.metrics.length === 0) return null;

  for (const mv of MV_REGISTRY) {
    // Alle plan-metrics skal være indeholdt i MV
    const metricsCovered = plan.metrics.every((m) => mv.metrics.includes(m));
    if (!metricsCovered) continue;

    // Dimensions skal matche præcist (samme set)
    if (plan.dimensions.length !== mv.dimensions.length) continue;
    const dimsCovered = plan.dimensions.every((d) => mv.dimensions.includes(d));
    if (!dimsCovered) continue;

    return mv;
  }

  return null;
}

/**
 * Find alle MV'er der har minimum overlap med plan (subset-match) — bruges
 * til diagnostik / "vi kunne pre-aggregere denne hvis vi tilføjede X dim".
 */
export function findCandidateMvs(plan: QueryPlan): MvDefinition[] {
  return MV_REGISTRY.filter((mv) => plan.metrics.some((m) => mv.metrics.includes(m)));
}
