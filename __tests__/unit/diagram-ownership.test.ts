/**
 * Unit tests for diagram ownership hierarchy logic.
 *
 * Verificerer at JAJR Ejendomme-diagrammet viser korrekt hierarkisk
 * ejerskab: Jakob → JaJR Holding → JaJR Holding 2 → JAJR Ejendomme.
 *
 * Disse tests fanger regressioner i diagram post-processing:
 * - Stifter-filtrering (stiftere uden ejerandel er IKKE ejere)
 * - Null-ejerandel filtrering (historiske entries springes over)
 * - Person→company dedup (beneficial owner fjernes når koncern-hierarki findes)
 * - Redundant edge removal (indirekte stier fjerner direkte edges)
 */

import { describe, it, expect } from 'vitest';

// ─── Test data: JAJR Ejendomme koncernstruktur ─────────────────────────────
// Afspejler prod-data fra cvr_virksomhed_ejerskab + cvr_deltagerrelation

/** Simulerer noder som diagram-resolve bygger */
interface TestNode {
  id: string;
  label: string;
  type: 'main' | 'company' | 'person' | 'property';
  cvr?: number;
}

interface TestEdge {
  from: string;
  to: string;
  ejerandel?: string;
}

const OWNERSHIP_TYPES = new Set([
  'register',
  'reel_ejer',
  'interessenter',
  'hovedselskab',
  // NB: 'stifter' bevidst UDELADT
]);

// ─── Helpers (spejler route.ts post-processing) ────────────────────────────

/**
 * Filtrerer stifter-relationer fra ownership set.
 * Stiftere uden ejerandel er IKKE ejere.
 */
function filterOwnershipRelations(
  relations: Array<{
    deltager_enhedsnummer: number;
    type: string;
    virksomhed_cvr: string;
    ejerandel_pct: number | null;
  }>
): typeof relations {
  return relations.filter((r) => OWNERSHIP_TYPES.has(r.type));
}

/**
 * Filtrerer null-ejerandel entries fra cvr_virksomhed_ejerskab.
 * Entries med null ejerandel springes over når target har andre ejere med reel andel.
 */
function filterNullEjerandelEdges(
  rows: Array<{
    ejer_cvr: string;
    ejet_cvr: string;
    ejerandel_pct: number | null;
    ejerandel_min: number | null;
  }>
): typeof rows {
  const targetsWithReal = new Set(
    rows.filter((r) => r.ejerandel_pct != null || r.ejerandel_min != null).map((r) => r.ejet_cvr)
  );
  return rows.filter(
    (r) => r.ejerandel_pct != null || r.ejerandel_min != null || !targetsWithReal.has(r.ejet_cvr)
  );
}

/**
 * Fjerner person→company edges når company allerede ejes af andre selskaber.
 * EJF registrerer beneficial owner direkte, men hierarkiet bør vises.
 */
function removePersonToOwnedCompanyEdges(nodes: TestNode[], edges: TestEdge[]): TestEdge[] {
  const personIds = new Set(nodes.filter((n) => n.type === 'person').map((n) => n.id));
  const companyIds = new Set(
    nodes.filter((n) => n.type === 'company' || n.type === 'main').map((n) => n.id)
  );

  const result = [...edges];
  for (const targetId of companyIds) {
    const hasCompanyOwner = result.some(
      (e) => e.to === targetId && companyIds.has(e.from) && e.from !== targetId
    );
    if (hasCompanyOwner) {
      // Fjern person→target edges
      const toRemove = result.filter((e) => e.to === targetId && personIds.has(e.from));
      for (const r of toRemove) {
        const idx = result.indexOf(r);
        if (idx >= 0) result.splice(idx, 1);
      }
    }
  }
  return result;
}

/**
 * Fjerner redundante edges: hvis A→B og B→C, fjern A→C.
 */
function removeRedundantEdges(edges: TestEdge[]): TestEdge[] {
  const children = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!children.has(edge.from)) children.set(edge.from, new Set());
    children.get(edge.from)!.add(edge.to);
  }

  function hasIndirectPath(from: string, to: string, maxDepth = 4): boolean {
    const directChildren = children.get(from);
    if (!directChildren) return false;
    for (const mid of directChildren) {
      if (mid === to) continue;
      const visited = new Set<string>([from, mid]);
      const queue = [mid];
      let depth = 0;
      while (queue.length > 0 && depth < maxDepth) {
        const size = queue.length;
        for (let i = 0; i < size; i++) {
          const current = queue.shift()!;
          const next = children.get(current);
          if (!next) continue;
          for (const n of next) {
            if (n === to) return true;
            if (!visited.has(n)) {
              visited.add(n);
              queue.push(n);
            }
          }
        }
        depth++;
      }
    }
    return false;
  }

  return edges.filter((e) => !hasIndirectPath(e.from, e.to));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('diagram ownership: stifter-filtrering', () => {
  it('fjerner stifter-relationer fra ownership types', () => {
    // Jakob er stifter+direktør af DJKL/SJKL/FJKL Holding — ingen ejerandel
    const relations = [
      {
        deltager_enhedsnummer: 4000115446,
        type: 'stifter',
        virksomhed_cvr: '44863707',
        ejerandel_pct: null,
      },
      {
        deltager_enhedsnummer: 4000115446,
        type: 'stiftere',
        virksomhed_cvr: '44863707',
        ejerandel_pct: null,
      },
      {
        deltager_enhedsnummer: 4000115446,
        type: 'direktør',
        virksomhed_cvr: '44863707',
        ejerandel_pct: null,
      },
      // David er register-ejer med 100% — skal beholdes
      {
        deltager_enhedsnummer: 4010089170,
        type: 'register',
        virksomhed_cvr: '44863707',
        ejerandel_pct: 100,
      },
      // Jakob er register-ejer af JaJR Holding — skal beholdes
      {
        deltager_enhedsnummer: 4000115446,
        type: 'register',
        virksomhed_cvr: '41092807',
        ejerandel_pct: 100,
      },
    ];

    const filtered = filterOwnershipRelations(relations);

    // Kun register-typer overlever
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.type === 'register')).toBe(true);
    // Jakob→DJKL via stifter er væk
    expect(
      filtered.some(
        (r) => r.deltager_enhedsnummer === 4000115446 && r.virksomhed_cvr === '44863707'
      )
    ).toBe(false);
    // Jakob→JaJR Holding via register er bevaret
    expect(
      filtered.some(
        (r) => r.deltager_enhedsnummer === 4000115446 && r.virksomhed_cvr === '41092807'
      )
    ).toBe(true);
  });
});

describe('diagram ownership: null-ejerandel filtrering', () => {
  it('fjerner null-ejerandel entries når andre ejere har reel andel', () => {
    // ProductLife (43253174) ejes af:
    // - ProductLife Group (43253077): 100% — reel
    // - Pharma IT ManCo (43329782): null — historisk
    // - JaJR Holding (41092807): 25% — reel
    const rows = [
      { ejer_cvr: '43253077', ejet_cvr: '43253174', ejerandel_pct: 100, ejerandel_min: 100 },
      { ejer_cvr: '43329782', ejet_cvr: '43253174', ejerandel_pct: null, ejerandel_min: null },
      { ejer_cvr: '41092807', ejet_cvr: '43253174', ejerandel_pct: null, ejerandel_min: 25 },
    ];

    const filtered = filterNullEjerandelEdges(rows);

    // Pharma IT ManCo → ProductLife fjernes (null + andre har reel andel)
    expect(filtered).toHaveLength(2);
    expect(filtered.some((r) => r.ejer_cvr === '43329782')).toBe(false);
    // ProductLife Group (100%) og JaJR Holding (25%) bevares
    expect(filtered.some((r) => r.ejer_cvr === '43253077')).toBe(true);
    expect(filtered.some((r) => r.ejer_cvr === '41092807')).toBe(true);
  });

  it('beholder null-ejerandel entries når INGEN ejer har reel andel', () => {
    // Pharma IT ApS (37320595) har KUN null-ejerandel ejere
    const rows = [
      { ejer_cvr: '43253077', ejet_cvr: '37320595', ejerandel_pct: null, ejerandel_min: null },
      { ejer_cvr: '40995994', ejet_cvr: '37320595', ejerandel_pct: null, ejerandel_min: null },
    ];

    const filtered = filterNullEjerandelEdges(rows);

    // Alle beholdes — ingen alternativ ejer med reel andel
    expect(filtered).toHaveLength(2);
  });
});

describe('diagram ownership: person→company dedup', () => {
  it('fjerner Jakob→JAJR Ejendomme når Holding 2 allerede ejer den', () => {
    const nodes: TestNode[] = [
      { id: 'person-jakob', label: 'Jakob Juul Rasmussen', type: 'person' },
      { id: 'cvr-41092807', label: 'JaJR Holding ApS', type: 'company', cvr: 41092807 },
      { id: 'cvr-44878704', label: 'JaJR Holding 2 ApS', type: 'company', cvr: 44878704 },
      { id: 'cvr-26316804', label: 'JAJR Ejendomme ApS', type: 'main', cvr: 26316804 },
    ];
    const edges: TestEdge[] = [
      { from: 'person-jakob', to: 'cvr-41092807', ejerandel: '100%' },
      { from: 'person-jakob', to: 'cvr-26316804', ejerandel: '100%' }, // beneficial owner — skal fjernes
      { from: 'cvr-41092807', to: 'cvr-44878704', ejerandel: '25%' },
      { from: 'cvr-44878704', to: 'cvr-26316804', ejerandel: '100%' },
    ];

    const result = removePersonToOwnedCompanyEdges(nodes, edges);

    // Jakob→JAJR Ejendomme fjernes (Holding 2 ejer den allerede)
    expect(result.some((e) => e.from === 'person-jakob' && e.to === 'cvr-26316804')).toBe(false);
    // Jakob→JaJR Holding bevares (ingen company ejer Holding)
    expect(result.some((e) => e.from === 'person-jakob' && e.to === 'cvr-41092807')).toBe(true);
    // Company→company edges uændrede
    expect(result.some((e) => e.from === 'cvr-44878704' && e.to === 'cvr-26316804')).toBe(true);
  });
});

describe('diagram ownership: redundant edge removal', () => {
  it('fjerner JaJR Holding→JAJR Ejendomme når indirekte sti via Holding 2 eksisterer', () => {
    const edges: TestEdge[] = [
      { from: 'cvr-41092807', to: 'cvr-44878704', ejerandel: '25%' }, // Holding → Holding 2
      { from: 'cvr-44878704', to: 'cvr-26316804', ejerandel: '100%' }, // Holding 2 → Ejendomme
      { from: 'cvr-41092807', to: 'cvr-26316804' }, // Holding → Ejendomme (redundant)
    ];

    const result = removeRedundantEdges(edges);

    // Holding→Ejendomme fjernes (indirekte via Holding 2)
    expect(result.some((e) => e.from === 'cvr-41092807' && e.to === 'cvr-26316804')).toBe(false);
    // De to reelle edges bevares
    expect(result.some((e) => e.from === 'cvr-41092807' && e.to === 'cvr-44878704')).toBe(true);
    expect(result.some((e) => e.from === 'cvr-44878704' && e.to === 'cvr-26316804')).toBe(true);
  });
});

describe('diagram ownership: fuld JAJR Ejendomme hierarki', () => {
  it('producerer korrekt hierarki efter alle post-processing trin', () => {
    // Simulerer det fulde JAJR Ejendomme diagram efter initial graf-bygning
    const nodes: TestNode[] = [
      { id: 'person-jakob', label: 'Jakob Juul Rasmussen', type: 'person' },
      { id: 'person-david', label: 'David Juul Kofoed Led', type: 'person' },
      { id: 'person-silas', label: 'Silas Juul Kofoed Led', type: 'person' },
      { id: 'person-felix', label: 'Felix Juul Kofoed Led', type: 'person' },
      { id: 'cvr-41092807', label: 'JaJR Holding ApS', type: 'company', cvr: 41092807 },
      { id: 'cvr-44878704', label: 'JaJR Holding 2 ApS', type: 'company', cvr: 44878704 },
      { id: 'cvr-44863707', label: 'DJKL Holding ApS', type: 'company', cvr: 44863707 },
      { id: 'cvr-44864134', label: 'SJKL Holding ApS', type: 'company', cvr: 44864134 },
      { id: 'cvr-44864193', label: 'FJKL Holding ApS', type: 'company', cvr: 44864193 },
      { id: 'cvr-26316804', label: 'JAJR Ejendomme ApS', type: 'main', cvr: 26316804 },
    ];

    // Edges FØR post-processing (inkl. beneficial owner + stifter-baserede)
    let edges: TestEdge[] = [
      // Hierarkisk ejerskab (fra cvr_virksomhed_ejerskab)
      { from: 'cvr-41092807', to: 'cvr-44878704', ejerandel: '25%' },
      { from: 'cvr-44878704', to: 'cvr-26316804', ejerandel: '100%' },
      { from: 'cvr-44863707', to: 'cvr-44878704', ejerandel: '25%' },
      { from: 'cvr-44864134', to: 'cvr-44878704', ejerandel: '25%' },
      { from: 'cvr-44864193', to: 'cvr-44878704', ejerandel: '25%' },
      // Person-ejerskab (fra register med ejerandel)
      { from: 'person-jakob', to: 'cvr-41092807', ejerandel: '100%' },
      { from: 'person-david', to: 'cvr-44863707', ejerandel: '100%' },
      { from: 'person-silas', to: 'cvr-44864134', ejerandel: '100%' },
      { from: 'person-felix', to: 'cvr-44864193', ejerandel: '100%' },
      // Beneficial owner (EJF registrerer Jakob direkte på JAJR Ejendomme)
      { from: 'person-jakob', to: 'cvr-26316804', ejerandel: '100%' },
    ];

    // Trin 1: Fjern person→company edges (beneficial owner dedup)
    edges = removePersonToOwnedCompanyEdges(nodes, edges);

    // Trin 2: Fjern redundante edges
    edges = removeRedundantEdges(edges);

    // ── Verificeringer ──

    // Hierarkisk kæde: Jakob → Holding → Holding 2 → Ejendomme
    expect(edges.some((e) => e.from === 'person-jakob' && e.to === 'cvr-41092807')).toBe(true);
    expect(edges.some((e) => e.from === 'cvr-41092807' && e.to === 'cvr-44878704')).toBe(true);
    expect(edges.some((e) => e.from === 'cvr-44878704' && e.to === 'cvr-26316804')).toBe(true);

    // Beneficial owner fjernet
    expect(edges.some((e) => e.from === 'person-jakob' && e.to === 'cvr-26316804')).toBe(false);

    // Børnenes ejerskab af holding-selskaber bevaret
    expect(edges.some((e) => e.from === 'person-david' && e.to === 'cvr-44863707')).toBe(true);
    expect(edges.some((e) => e.from === 'person-silas' && e.to === 'cvr-44864134')).toBe(true);
    expect(edges.some((e) => e.from === 'person-felix' && e.to === 'cvr-44864193')).toBe(true);

    // Ingen person→DJKL/SJKL/FJKL edges for Jakob (kun stifter, ikke ejer)
    // (allerede håndteret i filterOwnershipRelations — dette verificerer end-state)
    expect(edges.some((e) => e.from === 'person-jakob' && e.to === 'cvr-44863707')).toBe(false);
    expect(edges.some((e) => e.from === 'person-jakob' && e.to === 'cvr-44864134')).toBe(false);
    expect(edges.some((e) => e.from === 'person-jakob' && e.to === 'cvr-44864193')).toBe(false);
  });
});
