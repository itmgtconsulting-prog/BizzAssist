/**
 * Join-graf for Data Intelligence semantic layer (BIZZ-1562).
 *
 * Definerer pre-kuraterede joins mellem fact-tabeller og deres tilknyttede
 * dimension/lookup-tabeller. SQL-compileren (BIZZ-1564) bruger BFS på denne
 * graf til at finde korteste join-sti når en query kombinerer metrics og
 * dimensions fra forskellige tabeller.
 *
 * @module app/lib/dataIntelligence/semantic/joinGraph
 */

import type { JoinSpec } from './types';

/**
 * Alle kanoniske joins mellem tabeller.
 *
 * Joinet er retningsbestemt (fromTable → toTable). SQL-compileren genererer
 * INNER JOIN by default; LATERAL bruges når vi har brug for "nyeste record"-
 * pattern (fx seneste vurderings_aar pr. ejendom).
 */
export const JOINS: JoinSpec[] = [
  // ─── Handler ──────────────────────────────────────────────────────────
  {
    fromTable: 'ejerskifte_historik',
    toTable: 'bbr_ejendom_status',
    on: 'ejerskifte_historik.bfe_nummer = bbr_ejendom_status.bfe_nummer',
  },
  {
    fromTable: 'ejerskifte_historik',
    toTable: 'kommune_ref',
    on: 'ejerskifte_historik.kommune_kode = kommune_ref.kommune_kode',
  },
  {
    fromTable: 'ejerskifte_historik',
    toTable: 'vurdering_cache',
    on: 'ejerskifte_historik.bfe_nummer = vurdering_cache.bfe_nummer',
  },

  // ─── BBR ─────────────────────────────────────────────────────────────
  {
    fromTable: 'bbr_ejendom_status',
    toTable: 'kommune_ref',
    on: 'bbr_ejendom_status.kommune_kode = kommune_ref.kommune_kode',
  },
  {
    fromTable: 'bbr_ejendom_status',
    toTable: 'vurdering_cache',
    on: 'bbr_ejendom_status.bfe_nummer = vurdering_cache.bfe_nummer',
  },
  {
    fromTable: 'bbr_ejendom_status',
    toTable: 'ejf_ejerskab',
    on: "bbr_ejendom_status.bfe_nummer = ejf_ejerskab.bfe_nummer AND ejf_ejerskab.status = 'gældende'",
  },

  // ─── Vurdering ────────────────────────────────────────────────────────
  {
    fromTable: 'vurdering_cache',
    toTable: 'bbr_ejendom_status',
    on: 'vurdering_cache.bfe_nummer = bbr_ejendom_status.bfe_nummer',
  },
  {
    fromTable: 'vurdering_cache',
    toTable: 'kommune_ref',
    // Kommune kommer fra BBR — bro-join via bbr_ejendom_status
    on: 'vurdering_cache.bfe_nummer = bbr_ejendom_status.bfe_nummer AND bbr_ejendom_status.kommune_kode = kommune_ref.kommune_kode',
  },

  // ─── Ejerskab ─────────────────────────────────────────────────────────
  {
    fromTable: 'ejf_ejerskab',
    toTable: 'cvr_virksomhed',
    on: 'ejf_ejerskab.ejer_cvr = cvr_virksomhed.cvr',
  },
  {
    fromTable: 'ejf_ejerskab',
    toTable: 'bbr_ejendom_status',
    on: 'ejf_ejerskab.bfe_nummer = bbr_ejendom_status.bfe_nummer',
  },

  // ─── CVR ─────────────────────────────────────────────────────────────
  {
    fromTable: 'cvr_virksomhed',
    toTable: 'regnskab_cache',
    on: 'cvr_virksomhed.cvr = regnskab_cache.cvr',
  },
  {
    fromTable: 'cvr_virksomhed',
    toTable: 'kommune_ref',
    on: "(cvr_virksomhed.adresse_json->'kommune'->>'kommuneKode')::int = kommune_ref.kommune_kode",
  },
  {
    fromTable: 'cvr_virksomhed',
    toTable: 'cvr_deltagerrelation',
    on: 'cvr_virksomhed.cvr = cvr_deltagerrelation.virksomhed_cvr',
  },

  // ─── Deltager ────────────────────────────────────────────────────────
  {
    fromTable: 'cvr_deltagerrelation',
    toTable: 'cvr_deltager',
    on: 'cvr_deltagerrelation.deltager_enhedsnummer = cvr_deltager.enhedsnummer',
  },
];

/**
 * Find direkte join mellem to tabeller.
 *
 * @param from - Fra-tabel
 * @param to - Til-tabel
 * @returns JoinSpec eller undefined
 */
export function findDirectJoin(from: string, to: string): JoinSpec | undefined {
  return JOINS.find(
    (j) => (j.fromTable === from && j.toTable === to) || (j.fromTable === to && j.toTable === from)
  );
}

/**
 * BFS — find korteste join-sti mellem to tabeller.
 * Returnerer array af JoinSpec der skal anvendes i rækkefølge, eller null
 * hvis ingen sti findes.
 *
 * @param from - Start-tabel
 * @param to - Mål-tabel
 * @param maxDepth - Max antal hops (default 4)
 * @returns Liste af joins eller null
 */
export function findJoinPath(from: string, to: string, maxDepth: number = 4): JoinSpec[] | null {
  if (from === to) return [];

  // BFS
  const queue: Array<{ table: string; path: JoinSpec[] }> = [{ table: from, path: [] }];
  const visited = new Set<string>([from]);

  while (queue.length > 0) {
    const { table, path } = queue.shift()!;
    if (path.length >= maxDepth) continue;

    // Find alle tabeller vi kan nå fra current
    for (const j of JOINS) {
      let next: string | null = null;
      if (j.fromTable === table && !visited.has(j.toTable)) next = j.toTable;
      else if (j.toTable === table && !visited.has(j.fromTable)) next = j.fromTable;
      if (!next) continue;

      const newPath = [...path, j];
      if (next === to) return newPath;
      visited.add(next);
      queue.push({ table: next, path: newPath });
    }
  }

  return null;
}

/**
 * Få alle tabeller der kan nås fra en startpunkt (transitiv lukning).
 *
 * @param from - Start-tabel
 * @returns Set af tilgængelige tabel-navne
 */
export function getReachableTables(from: string): Set<string> {
  const reachable = new Set<string>([from]);
  const queue: string[] = [from];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const j of JOINS) {
      let next: string | null = null;
      if (j.fromTable === current) next = j.toTable;
      else if (j.toTable === current) next = j.fromTable;
      if (next && !reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  return reachable;
}
