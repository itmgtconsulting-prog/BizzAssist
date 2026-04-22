/**
 * Shared data types and builder for all diagram variants.
 * Transforms owner-chain + related-companies into a flat nodes + edges graph.
 *
 * @module DiagramData
 */

import type { RelateretVirksomhed } from '@/app/api/cvr-public/related/route';

// ─── Types (re-exported for diagram components) ─────────────────────────────

/** Owner chain node (matches page.tsx OwnerChainNode) */
export interface OwnerChainNode {
  /** Navn */
  navn: string;
  /** Enhedsnummer fra CVR ES */
  enhedsNummer: number | null;
  /** CVR-nummer (8 cifre) */
  cvr: number | null;
  /** Om det er en virksomhed */
  erVirksomhed: boolean;
  /** Ejerandel */
  ejerandel: string | null;
  /**
   * BIZZ-357: True when the company is dissolved/ceased (has a slutdato or sammensatStatus
   * "Ophørt" in CVR). Passed through to DiagramNode.isCeased for visual distinction.
   */
  isCeased?: boolean;
  /** Ejere af denne node (rekursivt) */
  parents: OwnerChainNode[];
}

/** A person listed inside a company node (bestyrelse/direktion) */
export interface DiagramNodePerson {
  /** Display name */
  navn: string;
  /** EnhedsNummer for navigation */
  enhedsNummer: number;
  /** Role category */
  rolle: string;
}

/** Minimal property summary for diagram rendering */
export interface DiagramPropertySummary {
  /** BFE-nummer (Bestemt Fast Ejendom) */
  bfeNummer: number;
  /** CVR-nummer på den ejende virksomhed */
  ownerCvr: string;
  /** Adresse (vejnavn + husnr) */
  adresse: string | null;
  /** Postnummer */
  postnr?: string | null;
  /** By/postdistrikt */
  by?: string | null;
  /** Ejendomstype (f.eks. "Normal ejendom", "Ejerlejlighed") */
  ejendomstype: string | null;
  /** DAWA adgangsadresse UUID — til link til detaljeside */
  dawaId: string | null;
  /** Etage (f.eks. "1", "st") — kun for ejerlejligheder (BIZZ-551) */
  etage?: string | null;
  /** Dør (f.eks. "tv", "th") — kun for ejerlejligheder (BIZZ-551) */
  doer?: string | null;
  /** Ejer-andel (f.eks. "50%", "100%") */
  ejerandel?: string | null;
  /** BIZZ-455/594: false hvis ejendommen er solgt — historisk ejerskab */
  aktiv?: boolean;
}

/** A node in the diagram graph */
export interface DiagramNode {
  /** Unique ID (enhedsNummer or CVR or generated) */
  id: string;
  /** Display label */
  label: string;
  /** Secondary label (company form, ejendomstype, etc.) */
  sublabel?: string;
  /** Node type for styling */
  type: 'person' | 'company' | 'main' | 'property' | 'status';
  /** CVR number (companies only) */
  cvr?: number;
  /** EnhedsNummer (person nodes only) — used for dynamic expansion via CVR ES */
  enhedsNummer?: number;
  /** BFE number (property nodes only) */
  bfeNummer?: number;
  /** Industry / branche description */
  branche?: string;
  /** Link URL for navigation */
  link?: string;
  /** Number of children that can be expanded (fold/unfold) */
  expandableChildren?: number;
  /** Parent node ID this node belongs to for collapse grouping */
  collapseParent?: string;
  /** Whether this node is a co-owner (not on main path — collapsible) */
  isCoOwner?: boolean;
  /**
   * BIZZ-357: True when the company is dissolved/ceased (has a slutdato or sammensatStatus
   * "Ophørt" in CVR). Diagram renders these greyed out with an "Ophørt" badge so historical
   * ownership is still visible but clearly distinguished from active owners.
   */
  isCeased?: boolean;
  /** Role of the viewed person in this company (person diagram only) */
  personRolle?: string;
  /** Other persons with roles in this company (for rendering inside the box) */
  noeglePersoner?: DiagramNodePerson[];
  /** Overflow items when a parent has >MAX children — shown as expandable list */
  overflowItems?: { label: string; cvr?: number; link?: string }[];
}

/** An edge in the diagram graph */
export interface DiagramEdge {
  /** Source node ID */
  from: string;
  /** Target node ID (child / owned company) */
  to: string;
  /** Ownership percentage label */
  ejerandel?: string;
  /**
   * BIZZ-585/619: True når edgen er en person→sole-owned-ejendom-relation.
   * Rendereren tegner stiplet emerald-linje for at adskille visuelt fra
   * person→virksomhed-edges og company→property-edges.
   */
  personallyOwned?: boolean;
}

/** Complete graph structure for diagram rendering */
export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** ID of the main (currently viewed) company */
  mainId: string;
  /** Number of companies hidden due to overflow grouping (shown as warning) */
  hiddenCount?: number;
}

// ─── Props shared by all diagram variants ──────────────────────────────────

export interface DiagramVariantProps {
  /** The graph data to render */
  graph: DiagramGraph;
  /** Language for labels */
  lang: 'da' | 'en';
  /**
   * Optional callback fired when a diagram node is clicked.
   * When provided, the default navigation (window.location.href) is suppressed
   * and the parent component controls what happens. Useful on person pages where
   * clicking a company node should switch tabs rather than navigate away.
   *
   * @param node - The clicked diagram node
   */
  onNodeClick?: (node: DiagramNode) => void;
  /**
   * BIZZ-571: Default-state for the "Ejendomme"-toggle. Virksomheds-diagrammet
   * vil typisk starte med ejendomme vist (true — uændret default), men
   * person-diagrammet skal starte med ejendomme skjult for at undgå et
   * overfyldt initial view på aktive personer med mange besiddelser.
   * Brugeren kan altid toggle manuelt via toolbar-knappen.
   */
  defaultShowProperties?: boolean;
}

/** Max children shown per parent node — overflow becomes an expandable list */
const MAX_CHILDREN_PER_PARENT = 15;

// ─── Graph Builder ─────────────────────────────────────────────────────────

/** Max properties shown per company node before overflow — matches MAX_PER_ROW in DiagramForce */
const MAX_PROPS_PER_COMPANY = 5;

/**
 * Builds a flat graph (nodes + edges) from owner chain and related companies.
 * Marks co-owners (nodes not on the main ownership path) as collapsible.
 * Optionally adds owned property nodes as leaves below each company node.
 *
 * @param mainName - Name of the currently viewed company
 * @param mainCvr - CVR of the currently viewed company
 * @param mainForm - Company form description
 * @param ownerChain - Resolved owner chain (upward hierarchy)
 * @param relatedCompanies - Subsidiaries / related companies (downward)
 * @param mainBranche - Main company industry description
 * @param propertiesByCvr - Map of CVR → owned properties to add as leaf nodes
 * @returns DiagramGraph with nodes and edges
 */
export function buildDiagramGraph(
  mainName: string,
  mainCvr: number,
  mainForm: string | null,
  ownerChain: OwnerChainNode[],
  relatedCompanies: RelateretVirksomhed[],
  mainBranche?: string | null,
  propertiesByCvr?: Map<number, DiagramPropertySummary[]>
): DiagramGraph {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const seenIds = new Set<string>();

  const mainId = `cvr-${mainCvr}`;

  // ── Track which node IDs are on the "main path" (direct ownership chain) ──
  const mainPathIds = new Set<string>([mainId]);

  // Add main node
  nodes.push({
    id: mainId,
    label: mainName,
    sublabel: mainForm ? `CVR ${mainCvr} · ${mainForm}` : `CVR ${mainCvr}`,
    type: 'main',
    cvr: mainCvr,
    branche: mainBranche ?? undefined,
  });
  seenIds.add(mainId);

  // ── Owner chain (upward) — first pass: find main path ──
  function findMainPath(chainNodes: OwnerChainNode[]): void {
    for (const node of chainNodes) {
      const id = node.cvr
        ? `cvr-${node.cvr}`
        : node.enhedsNummer
          ? `en-${node.enhedsNummer}`
          : `name-${node.navn}`;
      mainPathIds.add(id);
      if (node.parents.length > 0) findMainPath(node.parents);
    }
  }
  findMainPath(ownerChain);

  // Also mark direct subsidiaries as main path
  for (const v of relatedCompanies.filter((r) => r.aktiv)) {
    mainPathIds.add(`cvr-${v.cvr}`);
  }

  // ── Owner chain (upward) — second pass: add nodes + edges ──
  function addChainNode(node: OwnerChainNode): string {
    const id = node.cvr
      ? `cvr-${node.cvr}`
      : node.enhedsNummer
        ? `en-${node.enhedsNummer}`
        : `name-${node.navn}`;

    if (!seenIds.has(id)) {
      seenIds.add(id);
      const link = node.erVirksomhed
        ? `/dashboard/companies/${node.cvr ?? node.enhedsNummer}`
        : node.enhedsNummer
          ? `/dashboard/owners/${node.enhedsNummer}`
          : undefined;
      nodes.push({
        id,
        label: node.navn,
        type: node.erVirksomhed ? 'company' : 'person',
        cvr: node.cvr ?? undefined,
        // Persons need enhedsNummer so DiagramForce can offer the "Udvid"-knap
        // to fetch their other owned companies.
        enhedsNummer: !node.erVirksomhed ? (node.enhedsNummer ?? undefined) : undefined,
        // BIZZ-357: Propagate ceased status from owner chain so diagram can render it visually
        isCeased: node.isCeased ?? undefined,
        link,
      });
    }
    return id;
  }

  /**
   * Recursively add owner chain nodes and edges.
   *
   * @param chainNodes - Owner nodes at current level
   * @param childId - The node these owners own
   */
  function addOwnerEdges(chainNodes: OwnerChainNode[], childId: string) {
    for (const node of chainNodes) {
      const nodeId = addChainNode(node);
      edges.push({ from: nodeId, to: childId, ejerandel: node.ejerandel ?? undefined });

      if (node.parents.length > 0) {
        addOwnerEdges(node.parents, nodeId);
      }
    }
  }

  addOwnerEdges(ownerChain, mainId);

  // ── Related companies (downward) — BFS, max per parent, overflow for rest ──
  // Process level by level so children are only added if their parent is a visible node.
  const aktive = relatedCompanies.filter((v) => v.aktiv);

  // Group by parent CVR
  const childrenByParentCvr = new Map<number, RelateretVirksomhed[]>();
  for (const v of aktive) {
    const parentCvr = v.ejetAfCvr ?? mainCvr;
    if (!childrenByParentCvr.has(parentCvr)) childrenByParentCvr.set(parentCvr, []);
    childrenByParentCvr.get(parentCvr)!.push(v);
  }

  // Sort children by ejerandel (highest first) so the most important are shown individually
  for (const children of childrenByParentCvr.values()) {
    children.sort((a, b) => (b.ejerandelNum ?? 0) - (a.ejerandelNum ?? 0));
  }

  // BFS: start from mainCvr + owner-chain nodes
  let hiddenCount = 0;
  const queue: number[] = [mainCvr];
  for (const node of nodes) {
    if (node.cvr && node.cvr !== mainCvr) queue.push(node.cvr);
  }
  const processedParents = new Set<number>();

  while (queue.length > 0) {
    const parentCvr = queue.shift()!;
    if (processedParents.has(parentCvr)) continue;
    processedParents.add(parentCvr);

    const children = childrenByParentCvr.get(parentCvr);
    if (!children || children.length === 0) continue;

    const parentId = `cvr-${parentCvr}`;
    // Only add children if parent is a visible node
    if (!seenIds.has(parentId)) {
      hiddenCount += children.length;
      continue;
    }

    // Show first MAX individually, rest in overflow
    const shown = children.slice(0, MAX_CHILDREN_PER_PARENT);
    const overflow = children.slice(MAX_CHILDREN_PER_PARENT);

    for (const v of shown) {
      const id = `cvr-${v.cvr}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      nodes.push({
        id,
        label: v.navn,
        sublabel: v.form ?? undefined,
        type: 'company',
        cvr: v.cvr,
        branche: v.branche ?? undefined,
        link: `/dashboard/companies/${v.cvr}`,
      });
      edges.push({ from: parentId, to: id, ejerandel: v.ejerandel ?? undefined });
      queue.push(v.cvr);
    }

    if (overflow.length > 0) {
      const overflowId = `overflow-${parentId}`;
      nodes.push({
        id: overflowId,
        label: `+${overflow.length} flere virksomheder`,
        type: 'company',
        overflowItems: overflow.map((v) => ({
          label: v.navn,
          cvr: v.cvr,
          link: `/dashboard/companies/${v.cvr}`,
        })),
      });
      seenIds.add(overflowId);
      edges.push({ from: parentId, to: overflowId });
      // Children of overflow companies are hidden
      for (const v of overflow) {
        const gc = childrenByParentCvr.get(v.cvr);
        if (gc) hiddenCount += gc.length;
      }
    }
  }

  // ── Mark co-owners: nodes that own a subsidiary but are NOT on the main path ──
  // Only for shown companies (not overflow) to keep the graph manageable
  const seenNames = new Set(nodes.map((n) => n.label.toLowerCase()));
  const _shownCompanies = aktive.filter(
    (v) => !nodes.find((n) => n.id === `cvr-${v.cvr}`)?.overflowItems
  );
  const shownCvrs = new Set(nodes.filter((n) => n.cvr && !n.overflowItems).map((n) => n.cvr));

  for (const v of aktive.filter((v) => shownCvrs.has(v.cvr))) {
    const childId = `cvr-${v.cvr}`;
    for (const ejer of v.ejere ?? []) {
      const ejerId = ejer.erVirksomhed ? `cvr-${ejer.enhedsNummer}` : `en-${ejer.enhedsNummer}`;

      // Skip if this ID is already in the graph
      if (seenIds.has(ejerId)) continue;
      // Skip if a node with the same name already exists (handles CVR vs enhedsNummer mismatch)
      if (seenNames.has(ejer.navn.toLowerCase())) continue;
      // Skip if it's the parent (already has an edge)
      if (ejerId === `cvr-${v.ejetAfCvr ?? mainCvr}`) continue;

      // This is a co-owner — add as collapsible node
      seenIds.add(ejerId);
      seenNames.add(ejer.navn.toLowerCase());
      const link = ejer.erVirksomhed
        ? `/dashboard/companies/${ejer.enhedsNummer}`
        : `/dashboard/owners/${ejer.enhedsNummer}`;
      nodes.push({
        id: ejerId,
        label: ejer.navn,
        type: ejer.erVirksomhed ? 'company' : 'person',
        cvr: ejer.erVirksomhed ? ejer.enhedsNummer : undefined,
        enhedsNummer: !ejer.erVirksomhed ? ejer.enhedsNummer : undefined,
        branche: ejer.branche ?? undefined,
        link,
        isCoOwner: true,
        collapseParent: childId,
      });
      edges.push({ from: ejerId, to: childId, ejerandel: ejer.ejerandel ?? undefined });
    }
  }

  // ── Property nodes — owned by company nodes already in the graph ──
  // Snapshot company node IDs before adding properties to avoid iterating new entries
  if (propertiesByCvr) {
    const companyNodes = nodes.filter((n) => n.cvr != null && !n.overflowItems);
    for (const companyNode of companyNodes) {
      const cvr = companyNode.cvr!;
      const props = propertiesByCvr.get(cvr);
      if (!props || props.length === 0) continue;

      const shown = props.slice(0, MAX_PROPS_PER_COMPANY);
      for (const p of shown) {
        const propId = `bfe-${p.bfeNummer}`;
        // BIZZ-452: Always create edge even if node already exists (co-ownership)
        edges.push({
          from: companyNode.id,
          to: propId,
          ejerandel: p.ejerandel ?? undefined,
        });
        if (seenIds.has(propId)) continue;
        seenIds.add(propId);
        // Link to property detail page via DAWA adgangsadresse UUID
        const link = p.dawaId ? `/dashboard/ejendomme/${p.dawaId}` : undefined;
        // Merge address + postnr+by into main label (e.g. "Arnold Nielsens Boulevard 64A, 2650 Hvidovre")
        // BIZZ-551: Append etage + dør for ejerlejligheder
        // BIZZ-627: Når adresse mangler, vis "Ejendom" som placeholder i stedet
        // for "BFE X" — BFE-nummeret vises separat i 3. linje i DiagramForce.
        // Undgår duplikeret BFE-visning og signalerer tydeligt at adresse mangler.
        const postBy = [p.postnr, p.by].filter(Boolean).join(' ');
        const hasAddress = !!p.adresse;
        const rawAddr = p.adresse ?? 'Ejendom';
        const baseAddr =
          hasAddress && p.etage ? `${rawAddr}, ${p.etage}.${p.doer ? ` ${p.doer}` : ''}` : rawAddr;
        const mainLabel = hasAddress && postBy ? `${baseAddr}, ${postBy}` : baseAddr;
        nodes.push({
          id: propId,
          label: mainLabel,
          sublabel: p.ejendomstype ?? undefined,
          type: 'property',
          bfeNummer: p.bfeNummer,
          link,
        });
      }

      // BIZZ-268: Overflow node when more properties exist than shown.
      // overflowItems tillader at boksen foldes ud til en klikbar liste med
      // adresser der linker til den enkelte ejendom.
      if (props.length > MAX_PROPS_PER_COMPANY) {
        const overflowId = `props-overflow-${cvr}`;
        const remaining = props.length - MAX_PROPS_PER_COMPANY;
        const overflowProps = props.slice(MAX_PROPS_PER_COMPANY);
        nodes.push({
          id: overflowId,
          label: `+${remaining} ejendomme`,
          type: 'property',
          overflowItems: overflowProps.map((p) => {
            const postBy = [p.postnr, p.by].filter(Boolean).join(' ');
            const rawAddr = p.adresse ?? `BFE ${p.bfeNummer}`;
            const baseAddr = p.etage
              ? `${rawAddr}, ${p.etage}.${p.doer ? ` ${p.doer}` : ''}`
              : rawAddr;
            return {
              label: postBy ? `${baseAddr}, ${postBy}` : baseAddr,
              link: p.dawaId ? `/dashboard/ejendomme/${p.dawaId}` : undefined,
            };
          }),
        });
        edges.push({ from: companyNode.id, to: overflowId });
      }
    }
  }

  // ── Count expandable children per node (co-owners grouped by their target) ──
  const coOwnerCountByTarget = new Map<string, number>();
  for (const n of nodes) {
    if (n.isCoOwner && n.collapseParent) {
      coOwnerCountByTarget.set(
        n.collapseParent,
        (coOwnerCountByTarget.get(n.collapseParent) ?? 0) + 1
      );
    }
  }
  // Set expandableChildren on the target nodes
  for (const n of nodes) {
    const count = coOwnerCountByTarget.get(n.id);
    if (count && count > 0) n.expandableChildren = count;
  }

  return { nodes, edges, mainId, hiddenCount: hiddenCount > 0 ? hiddenCount : undefined };
}

// ─── Person Graph Builder ─────────────────────────────────────────────────

/** Rolle data for person's company */
interface PersonRolle {
  rolle: string;
  ejerandel: string | null;
  til: string | null;
}

/** Person's owned company (simplified) */
interface PersonCompany {
  cvr: number;
  navn: string;
  form: string | null;
  branche: string | null;
  aktiv: boolean;
  roller: PersonRolle[];
}

/**
 * Builds a diagram graph centered on a person.
 * Person at top → owned companies → their subsidiaries → owned properties.
 *
 * @param personName - Person's display name
 * @param personEnhedsNummer - Person's enhedsNummer
 * @param ejerVirksomheder - Companies the person owns
 * @param relatedCompaniesMap - Map of CVR → subsidiaries for each owned company
 * @param noeglePersonerMap - Map of CVR → bestyrelse/direktion persons (optional)
 * @param andreVirksomheder - Companies where person has non-owner roles (optional)
 * @param propertiesByCvr - Map of CVR → owned properties to add as leaf nodes (optional)
 * @returns DiagramGraph
 */
export function buildPersonDiagramGraph(
  personName: string,
  personEnhedsNummer: number,
  ejerVirksomheder: PersonCompany[],
  relatedCompaniesMap: Map<number, RelateretVirksomhed[]>,
  noeglePersonerMap?: Map<
    number,
    {
      bestyrelse: { navn: string; enhedsNummer: number }[];
      direktion: { navn: string; enhedsNummer: number }[];
    }
  >,
  andreVirksomheder?: PersonCompany[],
  propertiesByCvr?: Map<number, DiagramPropertySummary[]>,
  /**
   * BIZZ-594: Personligt ejede ejendomme (ikke via virksomhed). Tilføjes som
   * property-noder hængt direkte af person-noden. Data kommer typisk fra
   * /api/ejerskab/person-properties (bulk-data-lookup mod ejf_ejerskab).
   */
  personalProperties?: DiagramPropertySummary[]
): DiagramGraph {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const seenIds = new Set<string>();

  const mainId = `en-${personEnhedsNummer}`;

  // Person node (styled as 'main' type but we'll use 'person' — DiagramForce handles purple)
  nodes.push({
    id: mainId,
    label: personName,
    type: 'person',
    link: `/dashboard/owners/${personEnhedsNummer}`,
  });
  seenIds.add(mainId);

  // Main path IDs (person + owned companies + their direct subsidiaries)
  const mainPathIds = new Set<string>([mainId]);

  // ── Owned companies (downward from person) ──
  for (const v of ejerVirksomheder) {
    const id = `cvr-${v.cvr}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    mainPathIds.add(id);

    // Find the person's role in this company
    const aktiveRoller = v.roller.filter((r) => !r.til).map((r) => r.rolle);
    const personRolle = aktiveRoller.length > 0 ? aktiveRoller.join(', ') : undefined;

    // Collect key persons (bestyrelse + direktion) for this company — exclude the viewed person
    const companyPersoner: DiagramNodePerson[] = [];
    const pData = noeglePersonerMap?.get(v.cvr);
    if (pData) {
      for (const p of pData.bestyrelse) {
        if (p.enhedsNummer !== personEnhedsNummer) {
          companyPersoner.push({ navn: p.navn, enhedsNummer: p.enhedsNummer, rolle: 'Bestyrelse' });
        }
      }
      for (const p of pData.direktion) {
        if (
          p.enhedsNummer !== personEnhedsNummer &&
          !companyPersoner.some((cp) => cp.enhedsNummer === p.enhedsNummer)
        ) {
          companyPersoner.push({ navn: p.navn, enhedsNummer: p.enhedsNummer, rolle: 'Direktion' });
        }
      }
    }

    nodes.push({
      id,
      label: v.navn,
      sublabel: v.form ? `CVR ${v.cvr} · ${v.form}` : `CVR ${v.cvr}`,
      type: 'company',
      cvr: v.cvr,
      branche: v.branche ?? undefined,
      link: `/dashboard/companies/${v.cvr}`,
      personRolle,
      noeglePersoner: companyPersoner.length > 0 ? companyPersoner : undefined,
    });

    // Edge from person to owned company
    const ejerRolle = v.roller.find(
      (r) =>
        !r.til &&
        r.ejerandel &&
        (r.rolle.toLowerCase().includes('ejer') || r.rolle.toLowerCase().includes('stifter'))
    );
    edges.push({ from: mainId, to: id, ejerandel: ejerRolle?.ejerandel ?? undefined });
  }

  // ── Subsidiaries per owned company — max 20 per parent ──
  for (const v of ejerVirksomheder) {
    const _parentId = `cvr-${v.cvr}`;
    const related = (relatedCompaniesMap.get(v.cvr) ?? []).filter((r) => r.aktiv);

    // Group by sub-parent within this company's subsidiaries
    const subByParent = new Map<string, typeof related>();
    for (const sub of related) {
      const subParentId = `cvr-${sub.ejetAfCvr ?? v.cvr}`;
      if (!subByParent.has(subParentId)) subByParent.set(subParentId, []);
      subByParent.get(subParentId)!.push(sub);
    }

    for (const [subParentId, subs] of subByParent) {
      if (subs.length <= MAX_CHILDREN_PER_PARENT) {
        for (const sub of subs) {
          const subId = `cvr-${sub.cvr}`;
          if (seenIds.has(subId)) continue;
          seenIds.add(subId);
          mainPathIds.add(subId);

          const subPersoner: DiagramNodePerson[] = [];
          for (const p of sub.bestyrelse ?? []) {
            subPersoner.push({ navn: p.navn, enhedsNummer: p.enhedsNummer, rolle: 'Bestyrelse' });
          }
          for (const p of sub.direktion ?? []) {
            if (!subPersoner.some((sp) => sp.enhedsNummer === p.enhedsNummer)) {
              subPersoner.push({ navn: p.navn, enhedsNummer: p.enhedsNummer, rolle: 'Direktion' });
            }
          }

          nodes.push({
            id: subId,
            label: sub.navn,
            sublabel: sub.form ?? undefined,
            type: 'company',
            cvr: sub.cvr,
            branche: sub.branche ?? undefined,
            link: `/dashboard/companies/${sub.cvr}`,
            noeglePersoner: subPersoner.length > 0 ? subPersoner : undefined,
          });
          edges.push({ from: subParentId, to: subId, ejerandel: sub.ejerandel ?? undefined });
        }
      } else {
        // Alle børn i én overflow-boks
        const overflowId = `overflow-${subParentId}-${v.cvr}`;
        nodes.push({
          id: overflowId,
          label: `${subs.length} virksomheder`,
          type: 'company',
          overflowItems: subs.map((s) => ({
            label: s.navn,
            cvr: s.cvr,
            link: `/dashboard/companies/${s.cvr}`,
          })),
        });
        seenIds.add(overflowId);
        edges.push({ from: subParentId, to: overflowId });
      }
    }

    // Co-owners of individually shown subsidiaries only (skip overflow groups)
    const shownSubCvrs = new Set(nodes.filter((n) => n.cvr && !n.overflowItems).map((n) => n.cvr));
    for (const sub of related.filter((s) => shownSubCvrs.has(s.cvr))) {
      const childId = `cvr-${sub.cvr}`;
      for (const ejer of sub.ejere ?? []) {
        const ejerId = ejer.erVirksomhed ? `cvr-${ejer.enhedsNummer}` : `en-${ejer.enhedsNummer}`;

        if (seenIds.has(ejerId)) continue;
        if (ejerId === mainId) continue;
        if (ejerId === `cvr-${sub.ejetAfCvr ?? v.cvr}`) continue;

        seenIds.add(ejerId);
        const link = ejer.erVirksomhed
          ? `/dashboard/companies/${ejer.enhedsNummer}`
          : `/dashboard/owners/${ejer.enhedsNummer}`;
        nodes.push({
          id: ejerId,
          label: ejer.navn,
          type: ejer.erVirksomhed ? 'company' : 'person',
          cvr: ejer.erVirksomhed ? ejer.enhedsNummer : undefined,
          enhedsNummer: !ejer.erVirksomhed ? ejer.enhedsNummer : undefined,
          branche: ejer.branche ?? undefined,
          link,
          isCoOwner: true,
          collapseParent: childId,
        });
        edges.push({ from: ejerId, to: childId, ejerandel: ejer.ejerandel ?? undefined });
      }
    }
  }

  // ── Andre roller: companies where person has non-owner roles ──
  if (andreVirksomheder && andreVirksomheder.length > 0) {
    for (const v of andreVirksomheder) {
      const id = `cvr-${v.cvr}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      // Person's role in this company
      const aktiveRoller = v.roller.filter((r) => !r.til).map((r) => r.rolle);
      const personRolle = aktiveRoller.length > 0 ? aktiveRoller.join(', ') : undefined;

      // Key persons for this company
      const companyPersoner: DiagramNodePerson[] = [];
      const pData = noeglePersonerMap?.get(v.cvr);
      if (pData) {
        for (const p of pData.bestyrelse) {
          if (p.enhedsNummer !== personEnhedsNummer) {
            companyPersoner.push({
              navn: p.navn,
              enhedsNummer: p.enhedsNummer,
              rolle: 'Bestyrelse',
            });
          }
        }
        for (const p of pData.direktion) {
          if (
            p.enhedsNummer !== personEnhedsNummer &&
            !companyPersoner.some((cp) => cp.enhedsNummer === p.enhedsNummer)
          ) {
            companyPersoner.push({
              navn: p.navn,
              enhedsNummer: p.enhedsNummer,
              rolle: 'Direktion',
            });
          }
        }
      }

      nodes.push({
        id,
        label: v.navn,
        sublabel: v.form ? `CVR ${v.cvr} · ${v.form}` : `CVR ${v.cvr}`,
        type: 'company',
        cvr: v.cvr,
        branche: v.branche ?? undefined,
        link: `/dashboard/companies/${v.cvr}`,
        personRolle,
        noeglePersoner: companyPersoner.length > 0 ? companyPersoner : undefined,
      });

      // Edge from person to this company (dashed — non-owner role)
      edges.push({ from: mainId, to: id });
    }
  }

  // ── Property nodes — owned by company nodes already in the graph ──
  if (propertiesByCvr) {
    const companyNodes = nodes.filter((n) => n.cvr != null && !n.overflowItems);
    for (const companyNode of companyNodes) {
      const cvr = companyNode.cvr!;
      const props = propertiesByCvr.get(cvr);
      if (!props || props.length === 0) continue;

      const shown = props.slice(0, MAX_PROPS_PER_COMPANY);
      for (const p of shown) {
        const propId = `bfe-${p.bfeNummer}`;
        // BIZZ-452: Always create edge even if node already exists (co-ownership)
        edges.push({
          from: companyNode.id,
          to: propId,
          ejerandel: p.ejerandel ?? undefined,
        });
        if (seenIds.has(propId)) continue;
        seenIds.add(propId);
        // Link to property detail page via DAWA adgangsadresse UUID
        const link = p.dawaId ? `/dashboard/ejendomme/${p.dawaId}` : undefined;
        // Merge address + postnr+by into main label (e.g. "Arnold Nielsens Boulevard 64A, 2650 Hvidovre")
        // BIZZ-551: Append etage + dør for ejerlejligheder
        // BIZZ-627: Når adresse mangler, vis "Ejendom" som placeholder i stedet
        // for "BFE X" — BFE-nummeret vises separat i 3. linje i DiagramForce.
        // Undgår duplikeret BFE-visning og signalerer tydeligt at adresse mangler.
        const postBy = [p.postnr, p.by].filter(Boolean).join(' ');
        const hasAddress = !!p.adresse;
        const rawAddr = p.adresse ?? 'Ejendom';
        const baseAddr =
          hasAddress && p.etage ? `${rawAddr}, ${p.etage}.${p.doer ? ` ${p.doer}` : ''}` : rawAddr;
        const mainLabel = hasAddress && postBy ? `${baseAddr}, ${postBy}` : baseAddr;
        nodes.push({
          id: propId,
          label: mainLabel,
          sublabel: p.ejendomstype ?? undefined,
          type: 'property',
          bfeNummer: p.bfeNummer,
          link,
        });
      }

      // BIZZ-268: Overflow node when more properties exist than shown
      if (props.length > MAX_PROPS_PER_COMPANY) {
        const overflowId = `props-overflow-${cvr}`;
        const remaining = props.length - MAX_PROPS_PER_COMPANY;
        nodes.push({
          id: overflowId,
          label: `+${remaining} ejendomme`,
          type: 'property',
        });
        edges.push({ from: companyNode.id, to: overflowId });
      }
    }
  }

  // ── BIZZ-594: Personligt ejede ejendomme (bulk-data-lookup) ──────────────
  // Tilføjer direkte property-noder hængt af person-noden. Supplerer
  // propertiesByCvr-sporet med ejendomme som personen ejer UDEN via-
  // virksomhed-strukturen (typisk privatbolig, fritidshus og ejendomme
  // købt som privatperson). Data stammer normalt fra ejf_ejerskab-bulk-
  // tabellen (se BIZZ-534).
  //
  // BIZZ-730: Tidligere hang ejendommene direkte under person-noden på samme
  // lag som virksomhederne — visuelt blandet. Ved at indskyde en virtuel
  // container-node "Personligt ejede ejendomme" (type='status') mellem person
  // og ejendomme tvinges ejendommene ét lag længere ned i layouten, så de
  // vises klart adskilt fra virksomhederne uden at ændre ejerskabs-semantikken
  // (ejendommene ejes stadig af personen, ikke af containeren).
  if (personalProperties && personalProperties.length > 0) {
    const aktive = personalProperties.filter((p) => p.aktiv !== false);
    // Tilføj container-noden kun hvis der rent faktisk er personligt ejede
    // ejendomme — ellers forurenes diagrammet med en tom gruppe.
    const propGroupId = 'personal-props-group';
    if (aktive.length > 0) {
      nodes.push({
        id: propGroupId,
        label: 'Personligt ejede ejendomme',
        sublabel: `${aktive.length} ejendom${aktive.length === 1 ? '' : 'me'}`,
        type: 'status',
      });
      edges.push({
        from: mainId,
        to: propGroupId,
        personallyOwned: true,
      });
    }
    // BIZZ-619: Person-noden har typisk få (< 20) personligt ejede ejendomme
    // — uden cap. Den gamle MAX_PROPS_PER_COMPANY=5-cap gav "5 af 9"
    // på Jakob's persondiagram. Limit'en giver kun mening for virksomheder
    // der kan eje hundredvis af BFE'er; personens liste er altid kort.
    for (const p of aktive) {
      const propId = `bfe-${p.bfeNummer}`;
      // Edge går nu fra container-noden, ikke direkte fra person. Det bevarer
      // layout-adskillelsen (property-noder kommer ét lag længere ned end
      // virksomhederne). personallyOwned-flaget bibeholdes så stiplet linje
      // stadig signalerer privat ejerskab.
      edges.push({
        from: propGroupId,
        to: propId,
        ejerandel: p.ejerandel ?? undefined,
        personallyOwned: true,
      });
      if (seenIds.has(propId)) continue;
      seenIds.add(propId);
      const link = p.dawaId ? `/dashboard/ejendomme/${p.dawaId}` : undefined;
      // BIZZ-627: Placeholder "Ejendom" i stedet for "BFE X" når adresse mangler.
      const postBy = [p.postnr, p.by].filter(Boolean).join(' ');
      const hasAddress = !!p.adresse;
      const rawAddr = p.adresse ?? 'Ejendom';
      const baseAddr =
        hasAddress && p.etage ? `${rawAddr}, ${p.etage}.${p.doer ? ` ${p.doer}` : ''}` : rawAddr;
      const mainLabel = hasAddress && postBy ? `${baseAddr}, ${postBy}` : baseAddr;
      nodes.push({
        id: propId,
        label: mainLabel,
        sublabel: p.ejendomstype ?? undefined,
        type: 'property',
        bfeNummer: p.bfeNummer,
        link,
      });
    }
  }

  // ── Count expandable children per node ──
  const coOwnerCountByTarget = new Map<string, number>();
  for (const n of nodes) {
    if (n.isCoOwner && n.collapseParent) {
      coOwnerCountByTarget.set(
        n.collapseParent,
        (coOwnerCountByTarget.get(n.collapseParent) ?? 0) + 1
      );
    }
  }
  for (const n of nodes) {
    const count = coOwnerCountByTarget.get(n.id);
    if (count && count > 0) n.expandableChildren = count;
  }

  return { nodes, edges, mainId };
}
