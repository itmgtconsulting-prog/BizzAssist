'use client';

/**
 * D3 Force-directed diagram — physics simulation for organic layout.
 * Supports fold/expand of co-owners. Persons shown in purple.
 *
 * @param props - DiagramVariantProps
 */

import { memo, useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  forceSimulation,
  forceLink,
  forceCenter,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import {
  Briefcase,
  Building2,
  Maximize2,
  Minimize2,
  ChevronsUpDown,
  ChevronsDownUp,
  RotateCcw,
  Clock,
  X,
  Download,
  Home,
} from 'lucide-react';
import type { DiagramVariantProps, DiagramNode, DiagramEdge } from './DiagramData';
import type { PersonPublicData } from '@/app/api/cvr-public/person/route';

// ─── Constants ──────────────────────────────────────────────────────────────

const NODE_W = 320;
// BIZZ-558 + BIZZ-563: NODE_W_OVERFLOW (400) blev fjernet da overflow-bokse
// nu er kompakte (count-only) og bruger NODE_W_PROPERTY (260) i stedet.
// Ingen adresse-preview inline → fuld liste i modal (BIZZ-479).
/** Narrower width for property nodes — tighter box around address text */
const NODE_W_PROPERTY = 260;
const NODE_H = 64;
const NODE_H_EXPAND = 78;
const NODE_H_PERSON = 34;
/** Property node height — taller to fit address + postnr/by + BFE lines */
const NODE_H_PROPERTY = 58;

/** Extra height per noeglePerson row inside a company box */
const PERSON_ROW_H = 14;

/** Compute dynamic node height based on node properties */
/** Max overflow items shown before "vis alle" */
const OVERFLOW_INITIAL_SHOW = 5;

/** Compute node height — expandedOverflowIds makes overflow nodes taller when expanded */
function getNodeH(node: DiagramNode, expandedOverflowIds?: Set<string>): number {
  if (node.type === 'person') return NODE_H_PERSON;
  if (node.type === 'property') return NODE_H_PROPERTY;
  // Overflow list node
  // BIZZ-563: Kollapseret overflow-boks viser KUN count + "Vis alle"-knap nu
  // (ingen address-preview). Det reducerer højde fra ~130px → ~46px og
  // eliminerer overlap-risici med sibling-noder. Fuld liste vises i modal
  // (BIZZ-479-mønster). isExpanded bevares for evt. fremtidige inline-cases
  // men er aldrig sand i normal brug pga. modal-tilgangen.
  if (node.overflowItems) {
    const isExpanded = expandedOverflowIds?.has(node.id) ?? false;
    if (!isExpanded) {
      // Compact: header (24px) + Vis alle-knap (22px)
      return 46;
    }
    // Expanded (legacy code path — pt. ikke aktivt brugt)
    const showCount = node.overflowItems.length;
    return 30 + showCount * 16 + 20;
  }
  const personCount = Math.min(node.noeglePersoner?.length ?? 0, 5);
  if (personCount > 0) {
    const contentH = 12 + 10 + 13 + 12 + 8 + personCount * PERSON_ROW_H + 8;
    const expandExtra = (node.expandableChildren ?? 0) > 0 ? 18 : 0;
    return Math.max(NODE_H, contentH + expandExtra);
  }
  return (node.expandableChildren ?? 0) > 0 ? NODE_H_EXPAND : NODE_H;
}

/** Purple palette for person nodes */
const PERSON_FILL = 'rgba(139,92,246,0.12)';
const PERSON_STROKE = 'rgba(139,92,246,0.45)';
const PERSON_TEXT = 'rgba(196,167,255,0.95)';
const PERSON_ICON = 'rgba(167,139,250,0.7)';

/** Blue palette for main node */
const MAIN_FILL = 'rgba(37,99,235,0.18)';
const MAIN_STROKE = 'rgba(59,130,246,0.55)';

/** BIZZ-353: Blue palette for company nodes (matches BizzAssist brand) */
const COMPANY_FILL = 'rgba(30,58,138,0.6)';
const COMPANY_STROKE = 'rgba(59,130,246,0.5)';

/** Green palette for property nodes */
const PROPERTY_FILL = 'rgba(16,185,129,0.15)';
const PROPERTY_STROKE = 'rgba(52,211,153,0.5)';

/** Co-owner (collapsed) dashed style */
const COOWNER_FILL = 'rgba(30,41,59,0.5)';
const COOWNER_STROKE = 'rgba(71,85,105,0.4)';

/** BIZZ-357: Ceased company — grey wash so historical owners remain visible but clearly distinct */
const CEASED_FILL = 'rgba(30,30,35,0.55)';
const CEASED_STROKE = 'rgba(100,110,130,0.35)';

// ─── Force Types ────────────────────────────────────────────────────────────

/** Force node with position */
interface ForceNode extends SimulationNodeDatum {
  /** Unique ID matching DiagramNode.id */
  id: string;
  /** Reference to the diagram node data */
  data: DiagramNode;
}

/** Force link between nodes */
interface ForceLink extends SimulationLinkDatum<ForceNode> {
  /** Ownership percentage label */
  ejerandel?: string;
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * DiagramForce — Force-directed graph with fold/expand for co-owners.
 * Persons rendered in purple, companies in slate, main in blue.
 * Click the expand badge on a subsidiary to show/hide its co-owners.
 *
 * BIZZ-600: Wrapped i React.memo i bunden af filen — D3-simuleringen er
 * tung og skal ikke genstarte når forældre-komponenten rerender af
 * urelaterede årsager (fx tab-skift, notifikationer). Props-stabilitet
 * sikres af parents via useMemo/useCallback.
 *
 * @param props - graph + lang + optional onNodeClick override
 */
function DiagramForce({
  graph,
  lang,
  onNodeClick,
  defaultShowProperties = true,
  onDiagramReady,
  onExpand,
  onCollapse,
}: DiagramVariantProps) {
  const _router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  /**
   * BIZZ-865: "Simulation ready" flag for at skjule layout-hop. Under
   * force-sim'ens 120 async ticks render'er noder i foreløbige positioner
   * der ændrer sig pr. tick-batch. Ved at holde SVG usynlig (opacity 0)
   * indtil simulation er konvergeret og fitView er kørt, undgår brugeren
   * at se node'er "hoppe" på plads. Fade-in sker via CSS-transition.
   *
   * BIZZ-932: Brug hasEverSimulated ref i stedet for oscillerende state.
   * Async data-deps (noeglePersonerMap, personalBfes) genstartede simulation
   * gentagne gange → cancelled-flag forhindrede setSimulationReady(true) →
   * 2s fallback satte true → ny restart satte false → uendelig oscillation
   * med opacity=0 permanent. Nu: første completion sætter ref=true og SVG
   * forbliver synlig — efterfølgende sim-restarts opdaterer positions
   * in-place uden at skjule diagrammet.
   */
  const hasEverSimulated = useRef(false);
  /** User-dragged node positions — preserved across simulation re-runs.
   * Cleared when user clicks Reset. */
  const userPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  /** Set of node IDs whose co-owners are currently expanded */
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // ── Dynamic extension — person nodes can fetch + append their other companies/properties ──
  /** Nodes added dynamically via person "Udvid" button (not from original graph prop) */
  const [extensionNodes, setExtensionNodes] = useState<DiagramNode[]>([]);
  /** Edges added dynamically via person "Udvid" button */
  const [extensionEdges, setExtensionEdges] = useState<DiagramEdge[]>([]);
  /** Person node IDs whose dynamic data has already been fetched+added */
  const [expandedDynamic, setExpandedDynamic] = useState<Set<string>>(new Set());
  /** Person node IDs currently loading dynamic data (shows spinner/disabled state) */
  const [loadingExpansion, setLoadingExpansion] = useState<Set<string>>(new Set());

  /**
   * BIZZ-1127: Leveled expand/collapse — hvert expand-klik tildeler et niveau.
   * Skjul fjerner det højeste niveau først.
   *
   * nodeLevelMap: node-ID → expand-niveau (0 = initial graf, 1 = første expand, osv.)
   * currentMaxLevel: det højeste niveau i grafen (brugt til at tildele næste + collapse)
   */
  const [nodeLevelMap, setNodeLevelMap] = useState<Map<string, number>>(new Map());
  const currentMaxLevel = useMemo(() => {
    if (nodeLevelMap.size === 0) return 0;
    let max = 0;
    for (const level of nodeLevelMap.values()) {
      if (level > max) max = level;
    }
    return max;
  }, [nodeLevelMap]);

  /**
   * BIZZ-1131: Source→result mapping — tracker hvilken source-node der
   * producerede hvilke result-noder. Bruges af collapseOneLevel til at
   * gendanne Udvid-knapper (fjerne source fra expandedDynamic).
   * Key = result-node-ID, value = source-node-ID.
   */
  const [_expansionSourceMap, setExpansionSourceMap] = useState<Map<string, string>>(new Map());

  /**
   * BIZZ-1133: Tracker hvilke co-owner expandedNodes-entries der blev
   * tilføjet ved hvert level, så collapseOneLevel kan re-hide dem.
   * Key = parent-node-ID (i expandedNodes), value = level det blev tilføjet ved.
   */
  const [coOwnerLevelMap, setCoOwnerLevelMap] = useState<Map<string, number>>(new Map());

  /**
   * Tracker hvilke expandedDynamic-entries der blev sat ved hvert level.
   * Bruges af collapseOneLevel til at fjerne dem — uanset om de producerede
   * nye noder (expansionSourceMap) eller ej.
   */
  const [dynamicExpandLevelMap, setDynamicExpandLevelMap] = useState<Map<string, number>>(
    new Map()
  );

  /**
   * Marker en node som dynamisk expanded OG registrer ved hvilket level.
   * Bruges i stedet for direkte setExpandedDynamic-kald.
   */
  const markExpanded = useCallback(
    (nodeId: string) => {
      setExpandedDynamic((prev) => new Set([...prev, nodeId]));
      setDynamicExpandLevelMap((prev) => {
        const next = new Map(prev);
        if (!next.has(nodeId)) next.set(nodeId, currentMaxLevel + 1);
        return next;
      });
    },
    [currentMaxLevel]
  );

  /**
   * BIZZ-1128: Tilføj extension-noder OG registrer dem på næste expand-niveau.
   * BIZZ-1131: Tracker source→result mapping for clean collapse.
   *
   * @param nodes - Nye noder at tilføje
   * @param sourceNodeId - ID på noden der triggerede expansionen (optional)
   */
  const addExtensionNodesWithLevel = useCallback(
    (nodes: DiagramNode[], sourceNodeId?: string) => {
      if (nodes.length === 0) return;
      setExtensionNodes((prev) => [...prev, ...nodes]);
      setNodeLevelMap((prev) => {
        const nextLevel = currentMaxLevel + 1;
        const next = new Map(prev);
        for (const n of nodes) {
          if (!next.has(n.id)) next.set(n.id, nextLevel);
        }
        return next;
      });
      if (sourceNodeId) {
        setExpansionSourceMap((prev) => {
          const next = new Map(prev);
          for (const n of nodes) next.set(n.id, sourceNodeId);
          return next;
        });
      }
    },
    [currentMaxLevel]
  );

  // BIZZ-1127: Initialiser niveau 0 for alle noder i initial-grafen
  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return;
    setNodeLevelMap((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const n of graph.nodes) {
        if (!next.has(n.id)) {
          next.set(n.id, 0);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [graph]);

  /**
   * Effective graph = source graph + dynamic extensions (person expansion).
   * All downstream useMemos reference this instead of the raw `graph` prop so
   * newly-added nodes flow through layout + rendering automatically.
   */
  const effectiveGraph = useMemo(() => {
    if (extensionNodes.length === 0 && extensionEdges.length === 0) return graph;
    // BIZZ-1036: Dedup noder — extension-noder med samme id som eksisterende skipppes
    const existingIds = new Set(graph.nodes.map((n) => n.id));
    const dedupedNodes = extensionNodes.filter((n) => !existingIds.has(n.id));
    // Dedup edges — samme from+to kombination
    const existingEdgeKeys = new Set(graph.edges.map((e) => `${e.from}→${e.to}`));
    const dedupedEdges = extensionEdges.filter((e) => !existingEdgeKeys.has(`${e.from}→${e.to}`));
    return {
      nodes: [...graph.nodes, ...dedupedNodes],
      edges: [...graph.edges, ...dedupedEdges],
      mainId: graph.mainId,
      hiddenCount: graph.hiddenCount,
    };
  }, [graph, extensionNodes, extensionEdges]);

  /**
   * Fetch and add a person's personally-owned companies AND properties to the
   * diagram. Fires on Udvid-click on a person node when enhedsNummer is set.
   *
   * "Personligt ejet" betyder direkte ejerskab — enten en aktiv EJER-rolle
   * (med ejerandel) i virksomheden, ELLER en ejendom hvor personen står som
   * direkte ejer i EJF. Stifter-rolle alene udelukkes bevidst da en stifter
   * ikke nødvendigvis stadig ejer selskabet.
   */
  const expandPersonDynamic = useCallback(
    async (personId: string, enhedsNummer: number) => {
      if (expandedDynamic.has(personId) || loadingExpansion.has(personId)) return;
      setLoadingExpansion((prev) => new Set(prev).add(personId));
      try {
        // Henter personens virksomheder fra CVR, direkte personejede ejendomme
        // via enhedsNummer (BIZZ-264), OG bulk-indekserede ejendomme via
        // person-bridge + person-properties (BIZZ-534). De to ejendoms-kilder
        // komplementerer hinanden: enhedsNummer-sporet dækker EJF-matchede
        // deltagere, mens bulk-sporet dækker ALLE personligt ejede ejendomme
        // via deterministisk (navn, fødselsdato)-lookup.
        const [personRes, ejendommeRes, bridgeRes] = await Promise.all([
          fetch(`/api/cvr-public/person?enhedsNummer=${enhedsNummer}`, {
            signal: AbortSignal.timeout(15000),
          }).catch(() => null),
          fetch(`/api/ejendomme-by-owner?enhedsNummer=${enhedsNummer}&limit=50&offset=0`, {
            signal: AbortSignal.timeout(15000),
          }).catch(() => null),
          // BIZZ-534: Person-bridge resolver enhedsNummer → (navn, fødselsdato)
          // via hjemadresse-anker. Bruges til bulk-data person-properties lookup.
          fetch(`/api/ejerskab/person-bridge?enhedsNummer=${enhedsNummer}`, {
            signal: AbortSignal.timeout(15000),
          }).catch(() => null),
        ]);
        const existingIds = new Set<string>([
          ...graph.nodes.map((n) => n.id),
          ...extensionNodes.map((n) => n.id),
        ]);
        const newNodes: DiagramNode[] = [];
        const newEdges: DiagramEdge[] = [];

        // ── Personligt ejede virksomheder (CVR) ──
        if (personRes?.ok) {
          const data: PersonPublicData = await personRes.json();
          for (const v of data.virksomheder ?? []) {
            if (v.sammensatStatus === 'Ophørt') continue;
            // Personligt ejet virksomhed = ÉN af:
            //   (a) personen har rolle med registreret ejerandel (ekskl. stifter), ELLER
            //   (b) virksomhedsformen er en type hvor deltageren pr. definition
            //       ER ejer uden separat ejerandel-registrering — fx enkeltmands-
            //       virksomhed, I/S, K/S, P/S. Disse har ofte tom ejer-rolle-
            //       liste i CVR fordi registreringen ikke kræver det.
            // Find højeste ejerandel personen har i virksomheden (ekskl. stifter).
            const ejerandelRolle = v.roller.find((r) => {
              if (r.ejerandel == null) return false;
              const rolle = r.rolle.toLowerCase();
              if (rolle.includes('stifter')) return false;
              return true;
            });
            const formLc = (v.form ?? '').toLowerCase();
            const erEnkeltmand = formLc.includes('enkeltmand');
            const deltagerErEjerVedForm =
              erEnkeltmand ||
              formLc.includes('interessent') || // I/S
              formLc.includes('kommandit') || // K/S
              formLc.includes('partnersels'); // P/S
            if (!ejerandelRolle && !deltagerErEjerVedForm) continue;
            const cvrId = `cvr-${v.cvr}`;
            if (existingIds.has(cvrId)) continue;
            existingIds.add(cvrId);
            newNodes.push({
              id: cvrId,
              label: v.navn,
              sublabel: v.form ?? undefined,
              type: 'company',
              cvr: v.cvr,
              branche: v.branche ?? undefined,
              link: `/dashboard/companies/${v.cvr}`,
            });
            // Sæt ejerandel på kanten:
            //   • Enkeltmandsvirksomhed: personen er pr. definition 100% ejer,
            //   • Virksomhed med registreret ejer-rolle: brug rollens ejerandel,
            //   • I/S, K/S, P/S uden rolle-ejerandel: ukendt (ingen label).
            const edgeEjerandel = ejerandelRolle?.ejerandel
              ? ejerandelRolle.ejerandel
              : erEnkeltmand
                ? '100%'
                : undefined;
            newEdges.push({
              from: personId,
              to: cvrId,
              ejerandel: edgeEjerandel,
            });
          }
        }

        // ── Personligt ejede ejendomme (direkte via EJF enhedsNummer) ──
        if (ejendommeRes?.ok) {
          const ejData = await ejendommeRes.json();
          const ejendomme = Array.isArray(ejData.ejendomme) ? ejData.ejendomme : [];
          for (const p of ejendomme) {
            if (p.aktiv === false) continue; // skip solgte
            const bfeId = `bfe-${p.bfeNummer}`;
            if (existingIds.has(bfeId)) continue;
            existingIds.add(bfeId);
            // BIZZ-627: Placeholder "Ejendom" i stedet for "BFE X" når
            // adresse mangler — BFE vises i 3. linje af node-rendereren.
            const postBy = [p.postnr, p.by].filter(Boolean).join(' ');
            const hasAddress = !!p.adresse;
            const baseAddr = hasAddress ? (p.adresse as string) : 'Ejendom';
            const mainLabel = hasAddress && postBy ? `${baseAddr}, ${postBy}` : baseAddr;
            newNodes.push({
              id: bfeId,
              label: mainLabel,
              sublabel: p.ejendomstype ?? undefined,
              type: 'property',
              bfeNummer: p.bfeNummer,
              link: p.dawaId ? `/dashboard/ejendomme/${p.dawaId}` : undefined,
            });
            newEdges.push({
              from: personId,
              to: bfeId,
              ejerandel: p.ejerandel ?? undefined,
            });
          }
        }

        // ── BIZZ-534: Bulk-indekserede ejendomme via person-bridge ──
        // Person-bridge giver (navn, fødselsdato), som bruges til at slå op i
        // den dagligt-opdaterede ejf_ejerskab-tabel. Dette fanger ejendomme
        // som enhedsNummer-sporet ovenfor misser (typisk bopæl-ejendomme og
        // ejendomme købt som privatperson uden CVR-tilknytning).
        if (bridgeRes?.ok) {
          const bridge = await bridgeRes.json();
          const navn = bridge?.navn as string | undefined;
          const fdato = bridge?.foedselsdato as string | undefined;
          if (navn && fdato) {
            const ppRes = await fetch(
              `/api/ejerskab/person-properties?navn=${encodeURIComponent(navn)}&fdato=${fdato}`,
              { signal: AbortSignal.timeout(10000) }
            ).catch(() => null);
            if (ppRes?.ok) {
              const ppData = await ppRes.json();
              const bulkBfes: number[] = Array.isArray(ppData.bfes) ? ppData.bfes : [];
              // BIZZ-581: Berig BFE'er med adresse + dawaId så de vises som
              // korrekte ejendomsbokse (klikbare, med adresse) i stedet for
              // "BFE XXXXX"-ID-bokse.
              const newBfes = bulkBfes.filter((bfe) => !existingIds.has(`bfe-${bfe}`));
              let addressMap: Record<
                string,
                {
                  adresse: string | null;
                  postnr: string | null;
                  by: string | null;
                  dawaId: string | null;
                  ejendomstype: string | null;
                  etage: string | null;
                  doer: string | null;
                }
              > = {};
              if (newBfes.length > 0) {
                try {
                  const addrRes = await fetch(`/api/bfe-addresses?bfes=${newBfes.join(',')}`, {
                    signal: AbortSignal.timeout(10000),
                  });
                  if (addrRes.ok) {
                    addressMap = await addrRes.json();
                  }
                } catch {
                  // Fallback til BFE-only labels
                }
              }
              for (const bfe of bulkBfes) {
                const bfeId = `bfe-${bfe}`;
                if (existingIds.has(bfeId)) continue;
                existingIds.add(bfeId);
                const enriched = addressMap[String(bfe)];
                const postBy = enriched
                  ? [enriched.postnr, enriched.by].filter(Boolean).join(' ')
                  : '';
                // BIZZ-627: Placeholder "Ejendom" når adresse mangler.
                const hasAddress = !!enriched?.adresse;
                const baseAddr = hasAddress
                  ? enriched!.etage
                    ? `${enriched!.adresse}, ${enriched!.etage}.${enriched!.doer ? ` ${enriched!.doer}` : ''}`
                    : (enriched!.adresse as string)
                  : 'Ejendom';
                const mainLabel = hasAddress && postBy ? `${baseAddr}, ${postBy}` : baseAddr;
                newNodes.push({
                  id: bfeId,
                  label: mainLabel,
                  sublabel: enriched?.ejendomstype ?? 'Personligt ejet',
                  type: 'property',
                  bfeNummer: bfe,
                  link: enriched?.dawaId ? `/dashboard/ejendomme/${enriched.dawaId}` : undefined,
                });
                newEdges.push({
                  from: personId,
                  to: bfeId,
                  // BIZZ-585: Personligt ejede ejendomme er typisk 100% ejet
                  // af personen — vis det som default på edgen så ejerandel
                  // ikke bare mangler på bulk-data-sporet.
                  ejerandel: '100%',
                });
              }
            }
          }
        }

        // BIZZ-688: Indskyd virtuel container-node "Personligt ejede ejendomme"
        // mellem personen og dens direkte-ejede ejendomme så de renderes på
        // en selvstændig linje/layer i diagrammet, adskilt fra virksomhedsnoder.
        // Uden denne container får ejendomme samme dybde som virksomheder (begge
        // er direkte children af personId) og blandes sammen på samme y-række.
        // Same pattern som buildPersonGraph i DiagramData.ts (BIZZ-594/730).
        const propertyEdgesFromPerson = newEdges.filter(
          (e) => e.from === personId && e.to.startsWith('bfe-')
        );
        if (propertyEdgesFromPerson.length > 0) {
          const propGroupId = `personal-props-group-${personId}`;
          newNodes.push({
            id: propGroupId,
            label: lang === 'da' ? 'Personligt ejede ejendomme' : 'Personally owned properties',
            sublabel:
              lang === 'da'
                ? `${propertyEdgesFromPerson.length} ejendomme`
                : `${propertyEdgesFromPerson.length} properties`,
            type: 'status',
          });
          // Edge person → container (personallyOwned flag for visuel adskillelse)
          newEdges.push({ from: personId, to: propGroupId, personallyOwned: true });
          // Re-route property-edges: person→property bliver container→property
          for (const edge of newEdges) {
            if (edge.from === personId && edge.to.startsWith('bfe-')) {
              edge.from = propGroupId;
              edge.personallyOwned = true;
            }
          }
        }

        if (newNodes.length > 0) {
          addExtensionNodesWithLevel(newNodes);
          setExtensionEdges((prev) => [...prev, ...newEdges]);
        }
        markExpanded(personId);
      } catch {
        /* Fetch fejl er ikke-fatal — knap bliver bare ikke marked as expanded */
      } finally {
        setLoadingExpansion((prev) => {
          const next = new Set(prev);
          next.delete(personId);
          return next;
        });
      }
    },
    [expandedDynamic, loadingExpansion, graph.nodes, extensionNodes, lang]
  );

  /**
   * BIZZ-1081: Dynamisk udvidelse af virksomheds-noder.
   * Henter datterselskaber + ejere via /api/cvr-public/related.
   * Tilføjer nye noder/edges til extensionNodes/extensionEdges.
   */
  const expandCompanyDynamic = useCallback(
    async (companyNodeId: string, cvr: number) => {
      if (expandedDynamic.has(companyNodeId) || loadingExpansion.has(companyNodeId)) return;
      setLoadingExpansion((prev) => new Set(prev).add(companyNodeId));
      try {
        /* Hent BÅDE datterselskaber (nedad) OG ejere (opad) parallelt */
        const [relatedRes, cvrRes] = await Promise.all([
          fetch(`/api/cvr-public/related?cvr=${cvr}`, { signal: AbortSignal.timeout(15000) }).catch(
            () => null
          ),
          fetch(`/api/cvr-public?vat=${cvr}`, { signal: AbortSignal.timeout(15000) }).catch(
            () => null
          ),
        ]);

        const existingIds = new Set<string>([
          ...graph.nodes.map((n) => n.id),
          ...extensionNodes.map((n) => n.id),
        ]);
        const newNodes: DiagramNode[] = [];
        const newEdges: DiagramEdge[] = [];

        /* ── Datterselskaber (nedad) ── */
        if (relatedRes?.ok) {
          const data = (await relatedRes.json()) as {
            virksomheder?: Array<{
              cvr: number;
              navn: string;
              aktiv?: boolean;
              ejerandel?: string | null;
              form?: string | null;
              branche?: string | null;
              ejetAfCvr?: number | null;
            }>;
          };
          for (const v of data.virksomheder ?? []) {
            if (v.aktiv === false) continue;
            if (v.ejetAfCvr != null && v.ejetAfCvr !== cvr) continue;
            const childId = `cvr-${v.cvr}`;
            if (existingIds.has(childId)) continue;
            existingIds.add(childId);
            newNodes.push({
              id: childId,
              label: v.navn,
              sublabel: v.branche ?? v.form ?? `CVR ${v.cvr}`,
              type: 'company',
              cvr: v.cvr,
              link: `/dashboard/companies/${v.cvr}`,
              expandableChildren: 0,
            });
            newEdges.push({
              from: companyNodeId,
              to: childId,
              ejerandel: v.ejerandel ?? undefined,
            });
          }
        }

        /* ── Ejere (opad) — person + virksomheds-ejere fra deltagere ── */
        if (cvrRes?.ok) {
          const cvrData = await cvrRes.json();
          const deltagere = cvrData.deltagere as
            | Array<{
                navn: string;
                enhedsNummer: number;
                erVirksomhed: boolean;
                roller: Array<{ ejerandel?: string | null; rolle: string }>;
              }>
            | undefined;
          for (const d of deltagere ?? []) {
            const ejerRolle = d.roller?.find(
              (r) => r.ejerandel != null && !r.rolle?.toLowerCase().includes('stifter')
            );
            if (!ejerRolle) continue;
            const ownerId = d.erVirksomhed ? `cvr-${d.enhedsNummer}` : `en-${d.enhedsNummer}`;
            if (existingIds.has(ownerId)) {
              /* Ejer findes allerede i grafen — tilføj orange crossOwnership-edge */
              const edgeExists = [...extensionEdges, ...newEdges].some(
                (e) => e.from === ownerId && e.to === companyNodeId
              );
              if (!edgeExists) {
                newEdges.push({
                  from: ownerId,
                  to: companyNodeId,
                  ejerandel: ejerRolle.ejerandel ?? undefined,
                  crossOwnership: true,
                });
              }
              continue;
            }
            existingIds.add(ownerId);
            newNodes.push({
              id: ownerId,
              label: d.navn,
              sublabel: d.erVirksomhed ? `CVR ${d.enhedsNummer}` : undefined,
              type: d.erVirksomhed ? 'company' : 'person',
              cvr: d.erVirksomhed ? d.enhedsNummer : undefined,
              enhedsNummer: !d.erVirksomhed ? d.enhedsNummer : undefined,
              link: d.erVirksomhed
                ? `/dashboard/companies/${d.enhedsNummer}`
                : `/dashboard/owners/${d.enhedsNummer}`,
            });
            newEdges.push({
              from: ownerId,
              to: companyNodeId,
              ejerandel: ejerRolle.ejerandel ?? undefined,
            });
          }
        }

        if (newNodes.length > 0) {
          addExtensionNodesWithLevel(newNodes);
          setExtensionEdges((prev) => [...prev, ...newEdges]);
        } else {
          /* Ingen datterselskaber — tilføj en "tom" status-node som feedback */
          const emptyId = `empty-${companyNodeId}`;
          addExtensionNodesWithLevel([
            {
              id: emptyId,
              label: lang === 'da' ? 'Ingen datterselskaber' : 'No subsidiaries',
              type: 'status',
            },
          ]);
          setExtensionEdges((prev) => [...prev, { from: companyNodeId, to: emptyId }]);
        }

        /* Marker som udvidet — uanset om der var resultater */
        markExpanded(companyNodeId);
      } catch {
        /* Fejl ignoreres — noden forbliver uudvidet */
      } finally {
        setLoadingExpansion((prev) => {
          const next = new Set(prev);
          next.delete(companyNodeId);
          return next;
        });
      }
    },
    [expandedDynamic, loadingExpansion, graph.nodes, extensionNodes]
  );

  /**
   * BIZZ-479: Overflow-nodes starter COLLAPSED (viser kun de første
   * OVERFLOW_INITIAL_SHOW = 5). Hvis listen har flere, åbner "Vis alle"
   * knappen en modal i stedet for at folde ud inline — det forhindrer
   * SVG-layoutet i at kollidere med andre noder når en enkelt box pludselig
   * vokser fra 60px til 1000+ px (fx NOVO NORDISK med 74 ejendomme).
   *
   * Bevares som tom Set for bagudkompatibilitet med getNodeH logik —
   * hvis nogen fremtidig branche vil udfolde inline, kan de bare tilføje
   * node.id til dette set.
   */
  const [expandedOverflow] = useState<Set<string>>(() => new Set());

  /** BIZZ-479: Modal-state — hvilken overflow-node der i øjeblikket vises i modal */
  const [overflowModalNode, setOverflowModalNode] = useState<DiagramNode | null>(null);

  /** BIZZ-427: Toggle visibility of ceased/historical owners */
  const [showCeased, setShowCeased] = useState(false);

  /** BIZZ-451: Toggle visibility of property nodes — default ON for virksomhed.
   *  BIZZ-571: Default OFF for person-diagram (via defaultShowProperties-prop)
   *  for at undgå overfyldt view på aktive personer. */
  const propertyCount = useMemo(
    () => effectiveGraph.nodes.filter((n) => n.type === 'property').length,
    [effectiveGraph.nodes]
  );
  const [showProperties, setShowProperties] = useState(defaultShowProperties);

  /** BIZZ-1004: Toggle for personligt ejede ejendomme — default skjult */
  // BIZZ-1122: Personlige ejendomme default synlige på virksomhedsdiagram
  const [showPersonalProps, setShowPersonalProps] = useState(defaultShowProperties);

  /** Fullscreen overlay mode */
  const [isFullscreen, setIsFullscreen] = useState(false);

  /** Trigger to re-fit diagram when container size changes (e.g. fullscreen toggle) */
  const [fitTrigger, setFitTrigger] = useState(0);

  // ── Pan state (drag background to move entire canvas) ──
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const panRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
  });

  // ── Node drag state (drag individual nodes) ──
  const dragRef = useRef<{
    active: boolean;
    nodeId: string | null;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    didMove: boolean;
  }>({
    active: false,
    nodeId: null,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
    didMove: false,
  });

  /**
   * Toggle expand/collapse of co-owners for a given node.
   *
   * @param nodeId - ID of the subsidiary node to toggle co-owners for
   */
  function toggleExpand(nodeId: string) {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  // ── Filter graph based on expand state ──
  // BIZZ-1004: Byg set af node-IDs der er personligt ejede (under personal-props-group)
  const personalPropNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of effectiveGraph.edges) {
      if (e.personallyOwned) {
        ids.add(e.to);
        // Tilføj også gruppen selv
        /* BIZZ-1059: ID er 'personal-props-group' (uden trailing dash) */
        if (e.to.startsWith('personal-props-group')) ids.add(e.to);
      }
    }
    // Tilføj property-noder under grupper
    for (const e of effectiveGraph.edges) {
      if (ids.has(e.from) && e.from.startsWith('personal-props-group')) {
        ids.add(e.to);
      }
    }
    return ids;
  }, [effectiveGraph.edges]);

  const filteredGraph = useMemo(() => {
    const visibleNodes = effectiveGraph.nodes.filter((n) => {
      // BIZZ-427: Hide ceased/historical owners unless toggle is on
      if (!showCeased && n.isCeased) return false;
      // BIZZ-451: Hide property nodes unless toggle is on
      if (!showProperties && n.type === 'property') return false;
      // BIZZ-1004/1020: Hide personally owned properties.
      // Person-diagram: "Ejendomme" toggle styrer ALLE ejendomme (inkl. personlige).
      // Virksomheds-diagram: separat "Personlige" toggle.
      if (personalPropNodeIds.has(n.id)) {
        if (!defaultShowProperties && !showProperties) return false;
        if (defaultShowProperties && !showPersonalProps) return false;
      }
      // Always show non-co-owner nodes
      if (!n.isCoOwner) return true;
      // Show co-owner only if its parent is expanded
      return n.collapseParent ? expandedNodes.has(n.collapseParent) : true;
    });
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = effectiveGraph.edges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to)
    );
    // Hide orphan person nodes (no edges) — they can't visually connect and
    // just appear disconnected. Never hide the main node.
    const connectedIds = new Set<string>([effectiveGraph.mainId]);
    for (const e of visibleEdges) {
      connectedIds.add(e.from);
      connectedIds.add(e.to);
    }
    const connectedNodes = visibleNodes.filter(
      (n) => n.type !== 'person' || connectedIds.has(n.id)
    );
    return { nodes: connectedNodes, edges: visibleEdges };
  }, [
    effectiveGraph,
    expandedNodes,
    showCeased,
    showProperties,
    showPersonalProps,
    personalPropNodeIds,
    defaultShowProperties,
  ]);

  // ── Compute topological depth (owners above, subsidiaries below) ──
  // Co-owners are placed between the subsidiary's parent and the subsidiary
  // itself (depth - 0.5), so they visually sit in between.
  const depthMap = useMemo(() => {
    const depths = new Map<string, number>();
    depths.set(effectiveGraph.mainId, 0);

    // Build co-owner lookup for special depth handling
    const coOwnerIds = new Set<string>();
    const coOwnerTarget = new Map<string, string>();
    for (const n of filteredGraph.nodes) {
      if (n.isCoOwner && n.collapseParent) {
        coOwnerIds.add(n.id);
        coOwnerTarget.set(n.id, n.collapseParent);
      }
    }

    const parentEdges = new Map<string, string[]>();
    const childEdges = new Map<string, string[]>();
    for (const edge of filteredGraph.edges) {
      // crossOwnership-edges er sekundære visuelle links — de må IKKE påvirke
      // depth-beregningen, ellers trækkes noder til forkert lag (fx ejendomme
      // op til person-rækken når person→ejendom crossOwnership-edge tilføjes).
      if (edge.crossOwnership) continue;
      if (!parentEdges.has(edge.to)) parentEdges.set(edge.to, []);
      parentEdges.get(edge.to)!.push(edge.from);
      if (!childEdges.has(edge.from)) childEdges.set(edge.from, []);
      childEdges.get(edge.from)!.push(edge.to);
    }

    // BFS upward (skip co-owners — they get special depth later)
    // BIZZ-426: Use shallowest (closest to root) depth when a node is reachable via multiple paths
    const upQueue = [effectiveGraph.mainId];
    while (upQueue.length > 0) {
      const current = upQueue.shift()!;
      const d = depths.get(current) ?? 0;
      for (const p of parentEdges.get(current) ?? []) {
        if (coOwnerIds.has(p)) continue;
        const newDepth = d - 1;
        const existing = depths.get(p);
        if (existing === undefined || newDepth > existing) {
          // Use the shallowest depth (closest to 0 = main node)
          depths.set(p, newDepth);
          upQueue.push(p);
        }
      }
    }
    // BFS downward from ALL assigned nodes (skip co-owners).
    // Starter fra alle noder med depth (inkl. person-noder fra upward BFS)
    // så children af person-noder (fx IT Management under Jakob) får korrekt
    // integer depth i stedet for fractional depth.
    const nodeById = new Map(filteredGraph.nodes.map((n) => [n.id, n]));
    const downQueue = Array.from(depths.keys());
    while (downQueue.length > 0) {
      const current = downQueue.shift()!;
      const d = depths.get(current) ?? 0;
      for (const c of childEdges.get(current) ?? []) {
        if (coOwnerIds.has(c)) continue;
        const childNode = nodeById.get(c);
        const isPropertyLike = childNode?.type === 'property' || c.startsWith('props-overflow-');
        const newDepth = isPropertyLike ? d + 0.5 : d + 1;
        const existing = depths.get(c);
        if (existing === undefined || (isPropertyLike && newDepth < existing)) {
          // Properties: brug shallowest depth (tættest på toppen) — personligt
          // ejede ejendomme prioriteres over selskabs-ejede ved dual ownership.
          depths.set(c, newDepth);
          if (!isPropertyLike) {
            downQueue.push(c);
          }
        }
      }
    }

    // BIZZ-1125: Fractional depth for expand-noder.
    // Noder tilføjet via expand kan mangle depth fordi BFS kun startede fra
    // mainId. I stedet for en second-pass BFS der kan flytte eksisterende noder,
    // bruger vi fractional depth: expand-parents placeres 0.5 over deres child,
    // expand-children 0.5 under deres parent. Giver stabile positioner uden
    // at flytte eksisterende layout.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of filteredGraph.nodes) {
        if (depths.has(node.id) || coOwnerIds.has(node.id)) continue;
        // Check parents (edges where this node is "from")
        const childIds = childEdges.get(node.id) ?? [];
        const assignedChildren = childIds
          .filter((c) => depths.has(c) && !coOwnerIds.has(c))
          .map((c) => depths.get(c)!);
        if (assignedChildren.length > 0) {
          // Parent af eksisterende noder → placér 0.5 over DEEPEST child
          // (ikke shallowest — undgår at ejere fra dybe expand-noder
          // placeres for højt oppe i diagrammet)
          depths.set(node.id, Math.max(...assignedChildren) - 0.5);
          changed = true;
          continue;
        }
        // Check children (edges where this node is "to")
        const parentIds = parentEdges.get(node.id) ?? [];
        const assignedParents = parentIds
          .filter((p) => depths.has(p) && !coOwnerIds.has(p))
          .map((p) => depths.get(p)!);
        if (assignedParents.length > 0) {
          // Child af eksisterende noder → placér 0.5 under deepest parent
          // Alle orphaned children (inkl. properties) placeres 0.5 under parent
          depths.set(node.id, Math.max(...assignedParents) + 0.5);
          changed = true;
        }
      }
    }

    // BIZZ-1125: Renumber — normaliser alle depths til sekventielle heltal.
    // Fractional depths (0.5, 1.5 etc.) fra expand-noder konverteres til
    // rene heltal. Sikrer konsistent layout uanset antal expand-niveauer.
    const uniqueDepths = Array.from(new Set(depths.values()))
      .filter((d) => !isNaN(d))
      .sort((a, b) => a - b);
    if (uniqueDepths.length > 0) {
      const minD = uniqueDepths[0];
      const depthRemap = new Map<number, number>();
      for (let i = 0; i < uniqueDepths.length; i++) {
        depthRemap.set(uniqueDepths[i], i + minD);
      }
      // Kun renumber hvis der faktisk er fractional depths
      if (uniqueDepths.some((d) => d % 1 !== 0)) {
        for (const [id, d] of depths) {
          const remapped = depthRemap.get(d);
          if (remapped !== undefined && remapped !== d) {
            depths.set(id, remapped);
          }
        }
      }
    }

    // Compute the minimum depth among non-PERSON, non-co-owner nodes.
    // Used as anchor for a dedicated "person row" placed one level above.
    let minDepthNonPerson = 0;
    for (const [id, d] of depths) {
      if (coOwnerIds.has(id)) continue;
      if (nodeById.get(id)?.type === 'person') continue;
      if (d < minDepthNonPerson) minDepthNonPerson = d;
    }

    // Pin ALL person nodes (owner-chain AND co-owners) to the very top of the
    // diagram. Tidligere kunne ownerchain-persons lande midt i diagrammet hvis
    // deres BFS-depth ramte et indrykket holding-niveau; brugeren vil have alle
    // personer samlet øverst uanset hvor de logisk hører til i kæden.
    const personDepth = minDepthNonPerson - 1;
    for (const node of filteredGraph.nodes) {
      if (node.type !== 'person') continue;
      if (node.id === effectiveGraph.mainId) continue; // main stays where it is
      depths.set(node.id, personDepth);
    }

    // BIZZ-1125: Re-pin ALLE property-noder til parentDepth + 0.5.
    // Ejendomme tilføjet via expand (person ELLER virksomhed) kan have fået
    // forkert depth i fallback-passet fordi parent-noden endnu ikke var
    // korrekt placeret. Nu re-beregnes depth baseret på actual parent depth.
    for (const node of filteredGraph.nodes) {
      if (node.type !== 'property' && !node.id.startsWith('props-overflow-')) continue;
      const parents = parentEdges.get(node.id) ?? [];
      if (parents.length === 0) continue;
      // Brug den shallowest parent (tættest på toppen) for korrekt placering
      const parentDepths = parents.filter((pid) => depths.has(pid)).map((pid) => depths.get(pid)!);
      if (parentDepths.length > 0) {
        depths.set(node.id, Math.min(...parentDepths) + 0.5);
      }
    }

    // Rolle-virksomheder (layoutSection='role') placeres ØVERST i diagrammet,
    // lige under personen (depth 1), mens ejerskabs-hierarkiet skubbes ned.
    const roleNodes = filteredGraph.nodes.filter((n) => n.layoutSection === 'role');
    if (roleNodes.length > 0) {
      // Sæt rolle-noder til depth 1 (direkte under person)
      for (const node of roleNodes) {
        depths.set(node.id, 1);
      }
      // Skub ALLE ikke-rolle noder (undtagen main/person) 2 niveauer ned
      // så der er gap mellem roller og ejerskab
      for (const [id, d] of depths) {
        const node = nodeById.get(id);
        if (node?.layoutSection === 'role') continue;
        if (node?.type === 'main' || node?.type === 'person') continue;
        if (d <= 0) continue;
        depths.set(id, d + 2);
      }
    }

    // Company co-owners stay close to their subsidiary (targetDepth - 0.5) so
    // the parentage is still readable.
    for (const [coId, targetId] of coOwnerTarget) {
      const coNode = nodeById.get(coId);
      if (coNode?.type === 'person') continue; // already pinned to top above
      const targetDepth = depths.get(targetId) ?? 1;
      depths.set(coId, targetDepth - 0.5);
    }

    return depths;
  }, [filteredGraph, effectiveGraph.mainId]);

  // ── Layout constants ──
  const BASE_LEVEL_GAP = 160;
  /** Max nodes per row before wrapping to sub-rows */
  const MAX_PER_ROW = 5;
  /** Base vertical offset between sub-rows within the same depth level */
  const BASE_SUB_ROW_GAP = 100;
  /** Horizontal spacing between nodes in a grid row */
  const NODE_GAP_X = NODE_W + 32;

  /** Extra vertical space inserted before a sub-row to fit co-owner nodes */
  const CO_ROW_GAP = 120;

  /** Compute max node height at each depth level to prevent overlapping */
  const maxHeightByDepth = useMemo(() => {
    const map = new Map<number, number>();
    for (const node of filteredGraph.nodes) {
      const d = depthMap.get(node.id) ?? 0;
      const h = getNodeH(node);
      map.set(d, Math.max(map.get(d) ?? 0, h));
    }
    return map;
  }, [filteredGraph, depthMap]);

  /** Dynamic LEVEL_GAP and SUB_ROW_GAP that account for tallest node at each depth */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getLevelGap = (depth: number) => {
    const maxH = maxHeightByDepth.get(depth) ?? NODE_H;
    return Math.max(BASE_LEVEL_GAP, maxH + 40);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getSubRowGap = (depth: number) => {
    const maxH = maxHeightByDepth.get(depth) ?? NODE_H;
    return Math.max(BASE_SUB_ROW_GAP, maxH + 20);
  };

  // ── Compute final Y positions per node, accounting for sub-row wrapping ──
  // When a subsidiary on sub-row N has expanded co-owners, extra space is
  // inserted before that sub-row so the co-owners sit between row N-1 and N
  // without overlapping existing nodes.
  const nodeYMap = useMemo(() => {
    const yMap = new Map<string, number>();

    // Build co-owner lookup: id → collapseParent (target)
    const coOwnerTarget = new Map<string, string>();
    const coOwnerIds = new Set<string>();
    for (const node of filteredGraph.nodes) {
      if (node.isCoOwner && node.collapseParent) {
        coOwnerIds.add(node.id);
        coOwnerTarget.set(node.id, node.collapseParent);
      }
    }

    // Group co-owners by their target
    const coByTarget = new Map<string, string[]>();
    for (const [coId, targetId] of coOwnerTarget) {
      if (!coByTarget.has(targetId)) coByTarget.set(targetId, []);
      coByTarget.get(targetId)!.push(coId);
    }

    // Set of target IDs that have expanded co-owners
    const targetsWithCoOwners = new Set(coByTarget.keys());

    // Set of target IDs that have expanded COMPANY co-owners specifically —
    // each one needs its own stacked sub-row so we count them separately for
    // vertical space reservation.
    const targetsWithCompanyCoOwners = new Set<string>();
    for (const [targetId, coIds] of coByTarget) {
      const hasCompany = coIds.some((id) => {
        const n = filteredGraph.nodes.find((nn) => nn.id === id);
        return n?.type === 'company';
      });
      if (hasCompany) targetsWithCompanyCoOwners.add(targetId);
    }

    // Group only NON-co-owner, NON-property nodes by depth for standard sub-row layout.
    // Properties are placed in Pass 3 directly below their specific owner.
    const nodeById = new Map(filteredGraph.nodes.map((n) => [n.id, n]));
    const isPropertyId = (id: string) => {
      const n = nodeById.get(id);
      return n?.type === 'property' || id.startsWith('props-overflow-');
    };
    const byDepth = new Map<number, string[]>();
    for (const node of filteredGraph.nodes) {
      // Include PERSON co-owners in byDepth — they share the top person row
      // with ownerchain persons (uniform placement). Company co-owners still
      // get their own dedicated Pass 2 placement above their target.
      if (coOwnerIds.has(node.id) && node.type !== 'person') continue;
      const d = depthMap.get(node.id) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(node.id);
    }
    // Build parent lookup for company subsidiaries so we can group them
    // together on the same row. Each subsidiary's "parent" is the edge.from
    // of its first inbound edge (prioritising non-co-owner parents).
    const parentByChild = new Map<string, string>();
    for (const edge of filteredGraph.edges) {
      if (isPropertyId(edge.to)) continue;
      if (coOwnerIds.has(edge.from)) continue; // ignore co-owner edges — they don't represent direct parentage
      if (!parentByChild.has(edge.to)) parentByChild.set(edge.to, edge.from);
    }

    /**
     * Pakker subsidier i rækker efter forælder:
     *   • søskende fra samme forælder holdes sammen,
     *   • hvis en forældergruppe ikke kan rummes på den igangværende linje
     *     (sammenlagt > MAX_PER_ROW), padder vi resten af linjen og starter
     *     gruppen på en ny.
     * Returnerer en række ids med '__pad__' indsat hvor linjer afsluttes.
     */
    const packCompaniesByParent = (companies: string[]): string[] => {
      if (companies.length <= MAX_PER_ROW) return companies;
      // Group by parent (stable: preserve first-seen order)
      const groups = new Map<string, string[]>();
      for (const id of companies) {
        const parent = parentByChild.get(id) ?? '__noparent__';
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent)!.push(id);
      }
      const packed: string[] = [];
      let countOnLine = 0;
      for (const [, children] of groups) {
        // If the whole group would overflow the current line, pad to end of
        // the line and start the group on the next line — but only if the
        // group itself fits a single line (≤ MAX_PER_ROW). For larger groups
        // we just let the natural wrap split them.
        const groupFitsLine = children.length <= MAX_PER_ROW;
        if (countOnLine > 0 && groupFitsLine && countOnLine + children.length > MAX_PER_ROW) {
          while (countOnLine % MAX_PER_ROW !== 0) {
            packed.push('__pad__');
            countOnLine++;
          }
          countOnLine = 0;
        }
        for (const c of children) {
          packed.push(c);
          countOnLine = (countOnLine + 1) % MAX_PER_ROW;
        }
      }
      return packed;
    };

    // Re-order each depth group: persons first, then companies (grouped by parent).
    // (Properties are handled in Pass 3 — not in byDepth anymore.)
    for (const [depth, ids] of byDepth) {
      const persons = ids.filter((id) => nodeById.get(id)?.type === 'person');
      const companiesRaw = ids.filter((id) => nodeById.get(id)?.type !== 'person');
      const companies = packCompaniesByParent(companiesRaw);

      const hasMixedTypes = persons.length > 0 && companies.length > 0;

      if (hasMixedTypes) {
        // Pad persons so companies start on a fresh row
        const paddedPersons = [...persons];
        while (
          persons.length > 0 &&
          companies.length > 0 &&
          paddedPersons.length % MAX_PER_ROW !== 0
        ) {
          paddedPersons.push('__pad__');
        }
        byDepth.set(depth, [...paddedPersons, ...companies]);
      } else if (companies.length !== companiesRaw.length) {
        // Companies-only depth — still apply packing padding
        byDepth.set(depth, companies);
      }
    }

    // Sort depths and compute cumulative Y, adding extra space for co-owner rows
    const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);
    let cumulativeY = 0;
    const depthBaseY = new Map<number, number>();
    for (const depth of sortedDepths) {
      depthBaseY.set(depth, cumulativeY);
      const nodeIds = byDepth.get(depth)!;
      const subRowCount = Math.ceil(nodeIds.length / MAX_PER_ROW);
      const subRowGap = getSubRowGap(depth);
      const levelGap = getLevelGap(depth);

      // Calculate height of this depth level, including extra gaps for co-owner rows
      let levelHeight = 0;
      for (let sr = 0; sr < subRowCount; sr++) {
        // Check if any node on this sub-row has co-owners → needs extra space before it
        const startIdx = sr * MAX_PER_ROW;
        const endIdx = Math.min(startIdx + MAX_PER_ROW, nodeIds.length);
        let subRowHasCoOwners = false;
        let companyCoOwnerTargetCount = 0;
        for (let i = startIdx; i < endIdx; i++) {
          if (nodeIds[i] !== '__pad__' && targetsWithCoOwners.has(nodeIds[i])) {
            subRowHasCoOwners = true;
          }
          if (nodeIds[i] !== '__pad__' && targetsWithCompanyCoOwners.has(nodeIds[i])) {
            companyCoOwnerTargetCount++;
          }
        }
        if (sr > 0 || depth !== sortedDepths[0]) {
          levelHeight += subRowGap;
        }
        if (subRowHasCoOwners) {
          const stacks = Math.max(1, companyCoOwnerTargetCount);
          levelHeight += CO_ROW_GAP * stacks;
        }
      }
      cumulativeY += Math.max(levelHeight, levelGap);
    }

    // Pass 1: Assign Y to non-co-owner nodes, inserting extra gaps before sub-rows
    // with co-owners, AND after sub-rows whose owners have properties.
    for (const [depth, nodeIds] of byDepth) {
      const baseY = depthBaseY.get(depth) ?? 0;
      const subRowGap = getSubRowGap(depth);
      let runningY = 0;
      let prevSubRow = -1;
      for (let i = 0; i < nodeIds.length; i++) {
        if (nodeIds[i] === '__pad__') continue;
        const subRow = Math.floor(i / MAX_PER_ROW);
        if (subRow !== prevSubRow) {
          if (subRow > 0) {
            runningY += subRowGap;
          }
          // Check if this sub-row needs extra space for co-owners above it
          const startIdx = subRow * MAX_PER_ROW;
          const endIdx = Math.min(startIdx + MAX_PER_ROW, nodeIds.length);
          let subRowHasCoOwners = false;
          let companyCoOwnerTargetCount = 0;
          for (let j = startIdx; j < endIdx; j++) {
            if (nodeIds[j] !== '__pad__' && targetsWithCoOwners.has(nodeIds[j])) {
              subRowHasCoOwners = true;
            }
            if (nodeIds[j] !== '__pad__' && targetsWithCompanyCoOwners.has(nodeIds[j])) {
              companyCoOwnerTargetCount++;
            }
          }
          if (subRowHasCoOwners) {
            const stacks = Math.max(1, companyCoOwnerTargetCount);
            runningY += CO_ROW_GAP * stacks;
          }
          prevSubRow = subRow;
        }
        yMap.set(nodeIds[i], baseY + runningY);
      }
    }

    // Pass 2: Place co-owners.
    //   - COMPANY co-owners sit just above their target (targetY - CO_ROW_GAP)
    //   - PERSON co-owners ALL pinned to the very top of the diagram (user request:
    //     "flyt alle personer op i toppen" to avoid mid-diagram overlap)
    // Find the minimum Y among non-co-owner nodes (topmost row)
    let globalMinY = 0;
    for (const [id, yVal] of yMap) {
      if (!coOwnerIds.has(id) && yVal < globalMinY) globalMinY = yVal;
    }
    void globalMinY; // reserved for future use

    // Pass 2: Place COMPANY co-owners stacked above their target subsidiary.
    // Hvis flere subsidiaries på samme Y har expanded company co-owners, får
    // hver subsidiary sin egen sub-row (stack) så co-ownergrupper fra
    // forskellige forældre ikke lapper ind over hinanden horisontalt.
    const targetsByY = new Map<number, string[]>();
    for (const targetId of coByTarget.keys()) {
      const coIds = coByTarget.get(targetId) ?? [];
      const hasCompanyCo = coIds.some((id) => nodeById.get(id)?.type === 'company');
      if (!hasCompanyCo) continue;
      const ty = yMap.get(targetId);
      if (ty == null) continue;
      if (!targetsByY.has(ty)) targetsByY.set(ty, []);
      targetsByY.get(ty)!.push(targetId);
    }
    // For determinisme: sorter targets på samme Y efter deres rækkefølge i byDepth
    const indexInByDepth = new Map<string, number>();
    for (const [, ids] of byDepth) {
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== '__pad__') indexInByDepth.set(ids[i], i);
      }
    }
    for (const [, targetIds] of targetsByY) {
      targetIds.sort((a, b) => (indexInByDepth.get(a) ?? 0) - (indexInByDepth.get(b) ?? 0));
    }
    for (const [targetY, targetIds] of targetsByY) {
      for (let ti = 0; ti < targetIds.length; ti++) {
        const targetId = targetIds[ti];
        const coIds = coByTarget.get(targetId) ?? [];
        const targetDepth = depthMap.get(targetId) ?? 0;
        const coRowGap = getSubRowGap(targetDepth);
        const companies = coIds.filter((id) => nodeById.get(id)?.type === 'company');
        // ti=0 → umiddelbart over target, ti=1 → én række højere, osv.
        const companyBaseY = targetY - CO_ROW_GAP * (ti + 1);
        for (let i = 0; i < companies.length; i++) {
          const subRow = Math.floor(i / MAX_PER_ROW);
          yMap.set(companies[i], companyBaseY + subRow * coRowGap);
        }
      }
    }

    // Properties er nu i byDepth med depth + 0.5 (egen linje under ejer).
    // Overflow-noder placeres på absolut bottom-row efter ALLE andre noder.
    const OVERFLOW_BOTTOM_GAP = 80;
    const OVERFLOW_SUBROW_GAP = 70;
    const allOverflowNodes: string[] = [];
    for (const node of filteredGraph.nodes) {
      if (node.id.startsWith('props-overflow-')) allOverflowNodes.push(node.id);
    }
    if (allOverflowNodes.length > 0) {
      const overflowSet = new Set(allOverflowNodes);
      let maxY = 0;
      for (const [id, yVal] of yMap) {
        if (overflowSet.has(id)) continue;
        if (yVal > maxY) maxY = yVal;
      }
      const overflowBaseY = maxY + OVERFLOW_BOTTOM_GAP;
      for (let i = 0; i < allOverflowNodes.length; i++) {
        yMap.set(allOverflowNodes[i], overflowBaseY + i * OVERFLOW_SUBROW_GAP);
      }
    }

    return yMap;
  }, [filteredGraph, depthMap, getSubRowGap, getLevelGap]);

  // ── Run force simulation (hybrid: strict Y from nodeYMap, organic X from physics) ──
  // Stable node-set key — skip simulation re-run if nodes haven't changed
  const prevNodeSetKeyRef = useRef<string>('');

  useEffect(() => {
    if (filteredGraph.nodes.length === 0) return;

    // Skip simulation if node-set is identical (prevents "hopping")
    const nodeSetKey = filteredGraph.nodes
      .map((n) => n.id)
      .sort()
      .join('|');
    if (nodeSetKey === prevNodeSetKeyRef.current && positions.size > 0) {
      return;
    }
    prevNodeSetKeyRef.current = nodeSetKey;

    // Group by Y position (from nodeYMap) for initial X spread — ensures
    // persons and companies on separate sub-rows get independent X layouts
    const byY = new Map<number, DiagramNode[]>();
    for (const n of filteredGraph.nodes) {
      const y = nodeYMap.get(n.id) ?? 0;
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y)!.push(n);
    }

    // Assign initial X positions: process Y rows top-to-bottom so property rows
    // can reuse their owner's X position (computed in earlier iteration).
    // Co-owners are handled in a SECOND pass so they can be placed around
    // their target's X instead of drifting toward X=0 (which caused overlap
    // with row-siblings when a mid-row node's co-owners were expanded).
    const initialX = new Map<string, number>();
    const sortedYs = [...byY.keys()].sort((a, b) => a - b);

    // ── Pass A: non-co-owner nodes spread evenly per Y row ──
    for (const y of sortedYs) {
      const nodes = byY.get(y)!;
      const propNodes = nodes.filter(
        (n) => n.type === 'property' || n.id.startsWith('props-overflow-')
      );
      const otherNodes = nodes.filter(
        (n) => !n.isCoOwner && n.type !== 'property' && !n.id.startsWith('props-overflow-')
      );
      const otherCount = otherNodes.length;
      for (let i = 0; i < otherNodes.length; i++) {
        initialX.set(otherNodes[i].id, (i - (otherCount - 1) / 2) * NODE_GAP_X);
      }
      // Place properties globally spread across the row (not clustered per owner)
      // so multiple owners' properties don't overlap horizontally when 5+ share a Y.
      // Force simulation will still pull each property toward its owner via edges.
      const propCount = propNodes.length;
      const propSpacing = NODE_W + 40;
      for (let i = 0; i < propCount; i++) {
        initialX.set(propNodes[i].id, (i - (propCount - 1) / 2) * propSpacing);
      }
    }

    // ── Pass B: co-owners placed around their target's X ──
    // Group co-owners by their collapseParent and centre the group at target X.
    const coByTargetLocal = new Map<string, DiagramNode[]>();
    for (const n of filteredGraph.nodes) {
      if (n.isCoOwner && n.collapseParent) {
        if (!coByTargetLocal.has(n.collapseParent)) coByTargetLocal.set(n.collapseParent, []);
        coByTargetLocal.get(n.collapseParent)!.push(n);
      }
    }
    for (const [targetId, coNodes] of coByTargetLocal) {
      const targetX = initialX.get(targetId) ?? 0;
      const count = coNodes.length;
      for (let i = 0; i < count; i++) {
        // Spread around targetX with NODE_GAP_X spacing.
        initialX.set(coNodes[i].id, targetX + (i - (count - 1) / 2) * NODE_GAP_X);
      }
    }

    const forceNodes: ForceNode[] = filteredGraph.nodes.map((n) => ({
      id: n.id,
      data: n,
      x: initialX.get(n.id) ?? (Math.random() - 0.5) * 400,
      y: nodeYMap.get(n.id) ?? 0,
    }));

    const nodeMap = new Map(forceNodes.map((n) => [n.id, n]));
    const forceLinks: ForceLink[] = filteredGraph.edges
      .filter((e) => nodeMap.has(e.from) && nodeMap.has(e.to))
      .map((e) => ({ source: e.from, target: e.to, ejerandel: e.ejerandel }));

    // Group nodes by their Y level for same-level collision
    const nodesByY = new Map<number, ForceNode[]>();
    for (const node of forceNodes) {
      const y = nodeYMap.get(node.id) ?? 0;
      if (!nodesByY.has(y)) nodesByY.set(y, []);
      nodesByY.get(y)!.push(node);
    }

    // Custom force: snap Y + only repel nodes on the SAME level horizontally
    function forceHierarchy() {
      // Snap Y to pre-computed positions
      for (const node of forceNodes) {
        const targetY = nodeYMap.get(node.id) ?? 0;
        node.vy = (node.vy ?? 0) * 0.1;
        node.y = (node.y ?? 0) * 0.15 + targetY * 0.85;
      }

      // BIZZ-1005: Forbedret same-level X repulsion med stærkere push
      // og label-aware collision radius.
      const MIN_DIST_COMPANY = NODE_W + 44;
      const MIN_DIST_PROPERTY = NODE_W_PROPERTY + 24;
      const MIN_DIST_PERSON = NODE_W + 44;
      for (const [, siblings] of nodesByY) {
        // Sortér siblings for stabil ordering (undgår oscillation)
        siblings.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
        for (let i = 0; i < siblings.length; i++) {
          for (let j = i + 1; j < siblings.length; j++) {
            const a = siblings[i];
            const b = siblings[j];
            const bothProperty = a.data.type === 'property' && b.data.type === 'property';
            const eitherPerson = a.data.type === 'person' || b.data.type === 'person';
            const minDist = bothProperty
              ? MIN_DIST_PROPERTY
              : eitherPerson
                ? MIN_DIST_PERSON
                : MIN_DIST_COMPANY;
            const dx = (b.x ?? 0) - (a.x ?? 0);
            const absDx = Math.abs(dx);
            if (absDx < minDist) {
              // Stærkere push (0.7 vs 0.6) for hurtigere separation
              const push = (minDist - absDx) * 0.7;
              const sign = dx >= 0 ? 1 : -1;
              a.x = (a.x ?? 0) - push * sign;
              b.x = (b.x ?? 0) + push * sign;
            }
          }
        }
      }

      // Enforce edge constraint: source must be above target
      for (const link of forceLinks) {
        const src =
          typeof link.source === 'object' ? link.source : nodeMap.get(link.source as string);
        const tgt =
          typeof link.target === 'object' ? link.target : nodeMap.get(link.target as string);
        if (!src || !tgt) continue;
        const srcId =
          typeof link.source === 'object' ? (link.source as ForceNode).id : (link.source as string);
        const tgtId =
          typeof link.target === 'object' ? (link.target as ForceNode).id : (link.target as string);
        const srcNode = effectiveGraph.nodes.find((n) => n.id === srcId);
        const tgtNode = effectiveGraph.nodes.find((n) => n.id === tgtId);
        const srcH = srcNode ? getNodeH(srcNode) : NODE_H;
        const tgtH = tgtNode ? getNodeH(tgtNode) : NODE_H;
        const minGap = Math.max(srcH, tgtH) + 30;
        if ((src.y ?? 0) + minGap > (tgt.y ?? 0)) {
          const mid = ((src.y ?? 0) + (tgt.y ?? 0)) / 2;
          src.y = mid - minGap / 2;
          tgt.y = mid + minGap / 2;
        }
      }
    }

    const simulation = forceSimulation<ForceNode>(forceNodes)
      .force(
        'link',
        forceLink<ForceNode, ForceLink>(forceLinks)
          .id((d) => d.id)
          .distance(80)
          // Weaker link force so property edges don't pull siblings on top of each other
          .strength(0.15)
      )
      // No global charge — only same-level repulsion in forceHierarchy
      .force('centerX', forceCenter(0, 0).strength(0.05))
      .force('hierarchy', () => forceHierarchy())
      .alpha(1)
      // BIZZ-1058: Hurtigere alphaDecay for store grafer (20+ noder)
      .alphaDecay(forceNodes.length > 20 ? 0.05 : 0.03)
      // BIZZ-690: Højere velocityDecay (0.6) gør simulering mere dæmpet.
      .velocityDecay(0.6);

    // BIZZ-401: Run simulation in async chunks to avoid blocking the main thread.
    let cancelled = false;
    // BIZZ-1058: Større batches + færre total ticks for store grafer
    const TICKS_PER_BATCH = forceNodes.length > 20 ? 50 : 30;
    const TOTAL_TICKS = forceNodes.length > 20 ? 100 : forceNodes.length > 10 ? 150 : 120;
    let ticksDone = 0;

    const runBatch = () => {
      if (cancelled) return;
      const batchSize = Math.min(TICKS_PER_BATCH, TOTAL_TICKS - ticksDone);
      simulation.tick(batchSize);
      ticksDone += batchSize;

      if (ticksDone < TOTAL_TICKS) {
        setTimeout(runBatch, 0);
        return;
      }

      // Final pass: hard-snap Y to exact pre-computed position
      for (const node of forceNodes) {
        node.y = nodeYMap.get(node.id) ?? 0;
      }

      const newPositions = new Map<string, { x: number; y: number }>();
      for (const node of forceNodes) {
        // Respect user-dragged positions — they take precedence over simulation
        const userPos = userPositionsRef.current.get(node.id);
        if (userPos) {
          newPositions.set(node.id, userPos);
        } else {
          newPositions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
        }
      }
      setPositions(newPositions);
      setTimeout(() => {
        if (!cancelled) setFitTrigger((t) => t + 1);
      }, 80);
      // BIZZ-865/932: Marker simulation complete via ref (ikke state).
      // Ref flipper til true ved første completion og forbliver true —
      // efterfølgende simulation-restarts skjuler IKKE diagrammet.
      // Kort delay (180ms) sikrer fitView-transformet er applied først.
      setTimeout(() => {
        if (!cancelled) {
          hasEverSimulated.current = true;
          // BIZZ-1000: Capture diagram as base64 PNG for AI export
          if (onDiagramReady && svgRef.current) {
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svgRef.current);
            const svgBlob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svgString}`], {
              type: 'image/svg+xml;charset=utf-8',
            });
            const svgUrl = URL.createObjectURL(svgBlob);
            const img = new Image();
            img.onload = () => {
              const scale = 2;
              const canvas = document.createElement('canvas');
              canvas.width = img.width * scale;
              canvas.height = img.height * scale;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.fillStyle = '#0f172a';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.scale(scale, scale);
                ctx.drawImage(img, 0, 0);
                const dataUrl = canvas.toDataURL('image/png');
                const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
                onDiagramReady(base64);
              }
              URL.revokeObjectURL(svgUrl);
            };
            img.src = svgUrl;
          }
        }
      }, 180);
    };

    runBatch();

    return () => {
      cancelled = true;
      simulation.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredGraph, depthMap, nodeYMap]);

  // ── Compute SVG viewBox ──
  const viewBox = useMemo(() => {
    if (positions.size === 0) return { minX: 0, minY: 0, w: 800, h: 600 };
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [nodeId, pos] of positions.entries()) {
      const node = filteredGraph.nodes.find((n) => n.id === nodeId);
      const nh = node ? getNodeH(node, expandedOverflow) : NODE_H;
      const nw = node?.type === 'property' ? NODE_W_PROPERTY : NODE_W;
      minX = Math.min(minX, pos.x - nw / 2);
      minY = Math.min(minY, pos.y - nh / 2);
      maxX = Math.max(maxX, pos.x + nw / 2);
      maxY = Math.max(maxY, pos.y + nh / 2);
    }
    const pad = 60;
    // Smaller top pad so the topmost node sits closer to the container top
    // when top-aligning the diagram (user request).
    const padTop = 20;
    return {
      minX: minX - pad,
      minY: minY - padTop,
      w: maxX - minX + pad * 2,
      h: maxY - minY + padTop + pad,
    };
  }, [positions, expandedOverflow, filteredGraph.nodes]);

  // ── Auto-zoom to fit + center in container ──
  const initialFitDone = useRef(false);
  // Reset fit flag when graph changes
  useEffect(() => {
    initialFitDone.current = false;
  }, [filteredGraph]);

  // Stabilisér viewBox-værdier som primitiver for at undgå uendelig effect-loop
  const vbKey = `${viewBox.minX.toFixed(1)}_${viewBox.minY.toFixed(1)}_${viewBox.w.toFixed(1)}_${viewBox.h.toFixed(1)}`;

  useEffect(() => {
    if (positions.size === 0 || viewBox.w <= 0 || viewBox.h <= 0) return;

    const doFit = () => {
      // Kør kun én gang — undgå at overskrive brugerens zoom/pan
      if (initialFitDone.current) return;
      const c = containerRef.current;
      if (!c) return;
      const cW = c.clientWidth;
      const cH = c.clientHeight;
      if (cW < 50 || cH < 50) return;

      // BIZZ-552: Tillad højere max-zoom (2.5x) så små grafer (2-3 noder)
      // fylder canvas i stedet for at flyde ude i hjørnet. Cap'et på 1.5x
      // efterlod for meget tom plads.
      // BIZZ-931/932: Minimum zoom floor sat til 0.5 (50%) så noder
      // altid er læsbare. Ved 0.15 var 320px noder kun ~48px — usynlige.
      const fit = Math.min((cW - 40) / viewBox.w, (cH - 40) / viewBox.h, 2.5);
      const z = Math.max(fit, 0.5);
      const scaledW = viewBox.w * z + 32;
      const scaledH = viewBox.h * z + 32;
      const panX = Math.round((cW - scaledW) / 2);
      // BIZZ-552: Center vertikalt når indhold passer ind i canvas. Store
      // diagrammer (scaledH > cH) top-alignes med 8px så scrolling/panning
      // afslører resten — undgår at brugeren mister starten af træet.
      const panY = scaledH < cH ? Math.round((cH - scaledH) / 2) : 8;
      setZoom(z);
      setPanOffset({ x: panX, y: panY });
      initialFitDone.current = true;
    };

    // Schedule fit — rAF + fallback timers for layout timing (kun første gang)
    const id1 = requestAnimationFrame(doFit);
    const id2 = setTimeout(doFit, 150);
    const id3 = setTimeout(doFit, 400);
    return () => {
      cancelAnimationFrame(id1);
      clearTimeout(id2);
      clearTimeout(id3);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.size, vbKey, fitTrigger]);

  // ── Node drag: start ──
  const handleNodeMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation();
      e.preventDefault();
      const pos = positions.get(nodeId);
      if (!pos) return;
      dragRef.current = {
        active: true,
        nodeId,
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
        didMove: false,
      };
    },
    [positions]
  );

  // ── SVG background: start pan ──
  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only pan if clicking on SVG background (not on a node)
      if (dragRef.current.active) return;
      panRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        startPanX: panOffset.x,
        startPanY: panOffset.y,
      };
    },
    [panOffset]
  );

  // ── Global mousemove: handle both node drag and canvas pan ──
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragRef.current.active && dragRef.current.nodeId) {
        const dx = (e.clientX - dragRef.current.startX) / zoom;
        const dy = (e.clientY - dragRef.current.startY) / zoom;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragRef.current.didMove = true;
        const newPos = {
          x: dragRef.current.origX + dx,
          y: dragRef.current.origY + dy,
        };
        // Persist manual position so re-simulation doesn't overwrite it
        userPositionsRef.current.set(dragRef.current.nodeId!, newPos);
        setPositions((prev) => {
          const next = new Map(prev);
          next.set(dragRef.current.nodeId!, newPos);
          return next;
        });
      } else if (panRef.current.active) {
        const dx = e.clientX - panRef.current.startX;
        const dy = e.clientY - panRef.current.startY;
        setPanOffset({ x: panRef.current.startPanX + dx, y: panRef.current.startPanY + dy });
      }
    },
    [zoom]
  );

  // ── Global mouseup: stop drag or pan ──
  const handleMouseUp = useCallback(() => {
    // Reset didMove after a short delay so the click handler can check it
    setTimeout(() => {
      dragRef.current.didMove = false;
    }, 10);
    dragRef.current.active = false;
    dragRef.current.nodeId = null;
    panRef.current.active = false;
  }, []);

  // ── Global window mouseup listener to catch releases outside the container ──
  useEffect(() => {
    const handler = () => {
      if (dragRef.current.active || panRef.current.active) {
        handleMouseUp();
      }
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [handleMouseUp]);

  /**
   * Zoom towards a specific point in container-local coordinates.
   * Adjusts panOffset so the content under (cx, cy) stays fixed on screen.
   *
   * @param cx - X position relative to container left edge
   * @param cy - Y position relative to container top edge
   * @param newZoom - Target zoom level
   * @param prevZoom - Current zoom level
   * @param prevPan - Current pan offset
   */
  function zoomToPoint(
    cx: number,
    cy: number,
    newZoom: number,
    prevZoom: number,
    prevPan: { x: number; y: number }
  ) {
    const scale = newZoom / prevZoom;
    setPanOffset({
      x: cx - scale * (cx - prevPan.x),
      y: cy - scale * (cy - prevPan.y),
    });
    setZoom(newZoom);
  }

  // ── Mouse wheel zoom centered on cursor (attached via ref to avoid passive event issues) ──
  const zoomRef = useRef(zoom);
  // Sync ref in effect to avoid accessing refs during render
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  const panOffsetRef = useRef(panOffset);
  useEffect(() => {
    panOffsetRef.current = panOffset;
  }, [panOffset]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      const prevZoom = zoomRef.current;
      const newZoom = Math.min(Math.max(prevZoom + delta, 0.1), 3);

      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      zoomToPoint(cx, cy, newZoom, prevZoom, panOffsetRef.current);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [isFullscreen]);

  // ── Double-click on background to zoom in, centered on click position ──
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    // Check if the click target is a node element (text, rect with fill, circle, g)
    // We only want to zoom when clicking empty space, not on nodes
    const target = e.target as Element;
    const tag = target.tagName.toLowerCase();
    // Allow zoom on: the container div itself, SVG element, or the transparent hit-area rect
    const isEmptyArea =
      tag === 'div' ||
      tag === 'svg' ||
      (tag === 'rect' && target.getAttribute('fill') === 'transparent');
    if (!isEmptyArea) return;

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const prevZoom = zoomRef.current;
    const newZoom = Math.min(prevZoom + 0.25, 3);

    zoomToPoint(cx, cy, newZoom, prevZoom, panOffsetRef.current);
  }, []);

  // ── Escape key to exit fullscreen ──
  useEffect(() => {
    if (!isFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFullscreen]);

  // ── Re-fit and center when entering/exiting fullscreen (container size changes) ──
  // BIZZ-365: Reset initialFitDone so the auto-center effect actually runs after the
  // container has resized. Without this, the guard on line ~639 skips the fit.
  useEffect(() => {
    initialFitDone.current = false;
    const timer = setTimeout(() => setFitTrigger((t) => t + 1), 150);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  // ── BIZZ-604: Re-fit når containeren bliver synlig (tab-skift) ──
  // Når diagrammet er mountet i en skjult tab, er clientWidth 0 og auto-fit
  // skipper. ResizeObserver registrerer transitionen fra 0 → positiv bredde
  // (eller en betydelig størrelsesændring) og trigger re-fit så nodes
  // centreres i det faktiske viewport.
  useEffect(() => {
    const c = containerRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    let lastW = c.clientWidth;
    let lastH = c.clientHeight;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        // Trigger re-fit når containeren går fra ~usynlig til synlig
        // (cW < 50 → cW ≥ 50) eller ved stor størrelsesændring (>20% delta).
        const becameVisible = lastW < 50 && cr.width >= 50;
        const significantResize =
          lastW >= 50 &&
          (Math.abs(cr.width - lastW) / Math.max(lastW, 1) > 0.2 ||
            Math.abs(cr.height - lastH) / Math.max(lastH, 1) > 0.2);
        if (becameVisible || significantResize) {
          initialFitDone.current = false;
          setFitTrigger((t) => t + 1);
        }
        lastW = cr.width;
        lastH = cr.height;
      }
    });
    observer.observe(c);
    return () => observer.disconnect();
  }, []);

  // ── BIZZ-597 Fase 3: Auto-expand root person-node ved mount ──
  // Når diagrammets main-node er en person (person-siden) med enhedsNummer,
  // kalder vi expandPersonDynamic automatisk så personens virksomheder +
  // ejendomme hentes uden at brugeren skal trykke "Udvid" manuelt.
  // Virksomhedsdiagrammer (main-node type=main/company) påvirkes ikke.
  const autoExpandDoneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const mainNode = graph.nodes.find((n) => n.id === graph.mainId);
    if (!mainNode) return;

    // BIZZ-597 Fase 3: Main-node er selv en person → auto-expand hans
    // personlige ejendomme + virksomheder så vi får fuld view uden manuel
    // klik på Udvid.
    // SKIP auto-expand når resolve allerede leverer alle virksomheder (v2):
    // resolve sætter ikke expandableChildren på person-noden, og grafen
    // indeholder allerede alle company-noder som children.
    if (mainNode.type === 'person' && mainNode.enhedsNummer != null) {
      // Når onExpand er sat (v2 mode) og person-noden ikke har
      // expandableChildren, har resolve allerede leveret alle noder
      const resolveDeliveredAll =
        onExpand && (mainNode.expandableChildren == null || mainNode.expandableChildren === 0);
      if (resolveDeliveredAll) {
        // Markér som expanded så Udvid-knappen skjules
        if (!expandedDynamic.has(mainNode.id)) markExpanded(mainNode.id);
        return;
      }
      if (!autoExpandDoneRef.current.has(mainNode.id)) {
        autoExpandDoneRef.current.add(mainNode.id);
        if (!expandedDynamic.has(mainNode.id) && !loadingExpansion.has(mainNode.id)) {
          if (onExpand) {
            setLoadingExpansion((prev) => new Set([...prev, mainNode.id]));
            void onExpand(mainNode.id, 'person').then((result) => {
              setLoadingExpansion((prev) => {
                const s = new Set(prev);
                s.delete(mainNode.id);
                return s;
              });
              if (result) {
                addExtensionNodesWithLevel(result.nodes, mainNode.id);
                setExtensionEdges((prev) => [...prev, ...result.edges]);
                markExpanded(mainNode.id);
              }
            });
          } else {
            void expandPersonDynamic(mainNode.id, mainNode.enhedsNummer);
          }
        }
      }
      return;
    }

    // BIZZ-1122: Auto-expand af person-noder på virksomhedsdiagrammer er
    // DEAKTIVERET. Expand-routen tilføjer ALLE virksomheder personen har
    // roller i (inkl. bestyrelse/direktion), hvilket forurener ejerstruktur-
    // diagrammet med urelaterede virksomheder. Ejerstrukturen vises allerede
    // korrekt via /api/cvr-public/related med hierarkisk ejetAfCvr.
  }, [graph, expandPersonDynamic, expandedDynamic, loadingExpansion, onExpand]);

  // ── Expand/collapse all helpers ──
  // Nodes that have expandable children (expandableChildren > 0)
  const allExpandableIds = useMemo(
    () => effectiveGraph.nodes.filter((n) => (n.expandableChildren ?? 0) > 0).map((n) => n.id),
    [effectiveGraph.nodes]
  );
  // BIZZ-582: Person-noder med enhedsNummer der ikke er udvidet endnu — kan
  // udvides via expandPersonDynamic for at vise personligt ejede virksomheder
  // og ejendomme.
  const canExpandPersons = useMemo(() => {
    return effectiveGraph.nodes.filter(
      (n) =>
        n.type === 'person' &&
        n.enhedsNummer != null &&
        !expandedDynamic.has(n.id) &&
        !loadingExpansion.has(n.id)
    );
  }, [effectiveGraph.nodes, expandedDynamic, loadingExpansion]);
  // Currently visible expandable nodes that are NOT yet expanded (can expand next)
  const canExpandMore = useMemo(() => {
    const visibleIds = new Set(filteredGraph.nodes.map((n) => n.id));
    return allExpandableIds.filter((id) => visibleIds.has(id) && !expandedNodes.has(id));
  }, [allExpandableIds, filteredGraph.nodes, expandedNodes]);
  // BIZZ-1129: Virksomheder med Udvid-knap der kan udvides via toolbar
  const canExpandCompanies = useMemo(() => {
    return effectiveGraph.nodes.filter(
      (n) =>
        n.type !== 'main' &&
        n.cvr != null &&
        n.expandableChildren != null &&
        n.expandableChildren > 0 &&
        !expandedDynamic.has(n.id) &&
        !loadingExpansion.has(n.id)
    );
  }, [effectiveGraph.nodes, expandedDynamic, loadingExpansion]);
  // BIZZ-1130: Can collapse = vi er over niveau 0
  const canCollapseAny = currentMaxLevel > 0;

  /**
   * BIZZ-582: Expand one level: expand co-owners on currently visible nodes,
   * AND fire person-dynamic-expand for any person-node der ikke er udvidet
   * endnu. Det betyder Udvid-knappen nu også henter personligt ejede
   * virksomheder + ejendomme i ét klik.
   *
   * BIZZ-619: Udvid slår nu også `showProperties` på — hvis brugeren aktivt
   * udvider diagrammet, er det i praksis altid fordi de vil se alt, inkl.
   * personligt ejede ejendomme der ellers er skjult bag toggle'en.
   */
  function expandOneLevel() {
    let didSomething = false;
    if (canExpandMore.length > 0) {
      setExpandedNodes((prev) => {
        const next = new Set(prev);
        for (const id of canExpandMore) next.add(id);
        return next;
      });
      // BIZZ-1133: Track co-owner reveals ved dette niveau
      const nextLevel = currentMaxLevel + 1;
      setCoOwnerLevelMap((prev) => {
        const next = new Map(prev);
        for (const id of canExpandMore) next.set(id, nextLevel);
        return next;
      });
      didSomething = true;
    }
    if (canExpandPersons.length > 0) {
      for (const p of canExpandPersons) {
        if (p.enhedsNummer != null) {
          if (onExpand) {
            setLoadingExpansion((prev) => new Set([...prev, p.id]));
            void onExpand(p.id, 'person').then((result) => {
              setLoadingExpansion((prev) => {
                const s = new Set(prev);
                s.delete(p.id);
                return s;
              });
              if (result) {
                addExtensionNodesWithLevel(result.nodes, p.id);
                setExtensionEdges((prev) => [...prev, ...result.edges]);
                if (result.nodes.length > 0 || result.edges.length > 0) {
                  markExpanded(p.id);
                }
              }
            });
          } else {
            void expandPersonDynamic(p.id, p.enhedsNummer);
          }
        }
      }
      didSomething = true;
    }
    // BIZZ-1129: Udvid ALLE virksomheder med Udvid-knap
    if (canExpandCompanies.length > 0) {
      for (const c of canExpandCompanies) {
        if (c.cvr != null) {
          if (onExpand) {
            setLoadingExpansion((prev) => new Set([...prev, c.id]));
            void onExpand(c.id, 'company').then((result) => {
              setLoadingExpansion((prev) => {
                const s = new Set(prev);
                s.delete(c.id);
                return s;
              });
              if (result) {
                addExtensionNodesWithLevel(result.nodes, c.id);
                setExtensionEdges((prev) => [...prev, ...result.edges]);
                markExpanded(c.id);
              }
            });
          }
        }
      }
      didSomething = true;
    }
    // Afslør ejendomme når brugeren udvider — ellers vil Udvid-klik ikke
    // synligt gøre noget for person-diagrammer hvor de nyligt hentede
    // property-noder er filtered bag showProperties=false.
    if (!showProperties) {
      setShowProperties(true);
      didSomething = true;
    }
    if (!didSomething) return;
  }

  /**
   * BIZZ-1130: Collapse det højeste expand-niveau.
   * Fjerner noder + edges ved currentMaxLevel, gendanner Udvid-knapper.
   * Klik flere gange for at folde diagrammet helt sammen.
   */
  function collapseOneLevel() {
    if (currentMaxLevel <= 0) return;
    const levelToRemove = currentMaxLevel;

    // Find alle node-IDs ved dette niveau
    const idsAtLevel = new Set<string>();
    for (const [id, level] of nodeLevelMap) {
      if (level === levelToRemove) idsAtLevel.add(id);
    }
    if (idsAtLevel.size === 0) return;

    // 1. Re-hide co-owners der blev afsløret ved dette niveau
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      for (const [parentId, level] of coOwnerLevelMap) {
        if (level === levelToRemove) next.delete(parentId);
      }
      return next;
    });
    setCoOwnerLevelMap((prev) => {
      const next = new Map(prev);
      for (const [parentId, level] of prev) {
        if (level === levelToRemove) next.delete(parentId);
      }
      return next;
    });

    // 2. Fjern extension-noder + edges ved dette niveau
    setExtensionNodes((prev) => prev.filter((n) => !idsAtLevel.has(n.id)));
    setExtensionEdges((prev) =>
      prev.filter((e) => !idsAtLevel.has(e.from) && !idsAtLevel.has(e.to))
    );

    // 3. Gendanner Udvid-knapper — fjern alle expandedDynamic-entries
    //    der blev sat ved dette level (via dynamicExpandLevelMap).
    //    + fjern source-entries fra expansionSourceMap.
    setExpandedDynamic((prev) => {
      const next = new Set(prev);
      // Fjern noder der selv er ved dette level
      for (const id of idsAtLevel) next.delete(id);
      // Fjern noder der blev markeret som expanded ved dette level
      for (const [nodeId, level] of dynamicExpandLevelMap) {
        if (level === levelToRemove) next.delete(nodeId);
      }
      return next;
    });
    setDynamicExpandLevelMap((prev) => {
      const next = new Map(prev);
      for (const [nodeId, level] of prev) {
        if (level === levelToRemove) next.delete(nodeId);
      }
      return next;
    });
    setExpansionSourceMap((prev) => {
      const next = new Map(prev);
      for (const id of idsAtLevel) next.delete(id);
      return next;
    });

    // 4. Fjern level-entries fra map
    setNodeLevelMap((prev) => {
      const next = new Map(prev);
      for (const id of idsAtLevel) next.delete(id);
      return next;
    });

    // 5. Notify parent (DiagramV2) så allNodesRef/allBfesRef ryddes
    if (onCollapse) onCollapse(Array.from(idsAtLevel));
  }

  /** Toolbar with zoom controls + fullscreen toggle */
  const toolbar = (
    <div
      className={`flex items-center justify-between py-2 -mt-2 ${isFullscreen ? 'z-10 bg-[#0a1020]' : 'sticky top-0 z-10 bg-[#0a1020]/95 backdrop-blur-sm'}`}
    >
      <h2 className="text-white font-semibold text-base flex items-center gap-2">
        <Briefcase size={16} className="text-blue-400" />
        {effectiveGraph.nodes.some((n) => n.type === 'property')
          ? lang === 'da'
            ? 'Ejerskabsdiagram'
            : 'Ownership Diagram'
          : lang === 'da'
            ? 'Relationsdiagram'
            : 'Relations Diagram'}
      </h2>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            const c = containerRef.current;
            if (!c) {
              setZoom((z) => Math.min(z + 0.15, 3));
              return;
            }
            const cx = c.clientWidth / 2,
              cy = c.clientHeight / 2;
            zoomToPoint(
              cx,
              cy,
              Math.min(zoomRef.current + 0.15, 3),
              zoomRef.current,
              panOffsetRef.current
            );
          }}
          className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-xs transition"
          aria-label="Zoom ind"
        >
          +
        </button>
        <span className="text-slate-500 text-[10px] w-8 text-center">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => {
            const c = containerRef.current;
            if (!c) {
              setZoom((z) => Math.max(z - 0.15, 0.15));
              return;
            }
            const cx = c.clientWidth / 2,
              cy = c.clientHeight / 2;
            zoomToPoint(
              cx,
              cy,
              Math.max(zoomRef.current - 0.15, 0.15),
              zoomRef.current,
              panOffsetRef.current
            );
          }}
          className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-xs transition"
          aria-label="Zoom ud"
        >
          &minus;
        </button>
        <button
          onClick={() => {
            initialFitDone.current = false;
            setFitTrigger((t) => t + 1);
          }}
          className="px-2 h-7 flex items-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-[10px] transition"
          title={lang === 'da' ? 'Tilpas og centrer' : 'Fit & center'}
        >
          {lang === 'da' ? 'Centrer' : 'Fit'}
        </button>
        <button
          onClick={() => {
            // Clear manual drag positions so simulation re-layout takes effect
            userPositionsRef.current.clear();
            initialFitDone.current = false;
            setFitTrigger((t) => t + 1);
            containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
            containerRef.current
              ?.closest('[class*="overflow-y"]')
              ?.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className="px-2 h-7 flex items-center gap-1 text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-[10px] transition"
          title={lang === 'da' ? 'Nulstil visning og manuelle træk' : 'Reset view and manual drags'}
        >
          <RotateCcw size={11} />
          {lang === 'da' ? 'Reset' : 'Reset'}
        </button>
        {/* BIZZ-1132: Expand / Collapse med niveau-indikator */}
        <span className="w-px h-5 bg-slate-700/50 mx-1" />
        {currentMaxLevel > 0 && (
          <span className="text-slate-500 text-[9px] tabular-nums mr-1">
            {lang === 'da' ? `Niv. ${currentMaxLevel}` : `Lv. ${currentMaxLevel}`}
          </span>
        )}
        <button
          onClick={expandOneLevel}
          disabled={
            canExpandMore.length === 0 &&
            canExpandPersons.length === 0 &&
            canExpandCompanies.length === 0
          }
          className={`h-7 px-2 flex items-center gap-1 bg-slate-800 border border-slate-700/50 rounded-lg text-[10px] transition ${
            canExpandMore.length === 0 &&
            canExpandPersons.length === 0 &&
            canExpandCompanies.length === 0
              ? 'text-slate-600 cursor-not-allowed opacity-50'
              : 'text-slate-400 hover:text-white'
          }`}
          title={lang === 'da' ? 'Udvid næste niveau' : 'Expand next level'}
        >
          <ChevronsUpDown size={12} />
          {lang === 'da' ? 'Udvid' : 'Expand'}
        </button>
        <button
          onClick={collapseOneLevel}
          disabled={!canCollapseAny}
          className={`h-7 px-2 flex items-center gap-1 bg-slate-800 border border-slate-700/50 rounded-lg text-[10px] transition ${
            !canCollapseAny
              ? 'text-slate-600 cursor-not-allowed opacity-50'
              : 'text-slate-400 hover:text-white'
          }`}
          title={
            lang === 'da' ? `Skjul niveau ${currentMaxLevel}` : `Collapse level ${currentMaxLevel}`
          }
        >
          <ChevronsDownUp size={12} />
          {lang === 'da' ? 'Skjul' : 'Collapse'}
        </button>
        <span className="text-slate-500 text-[10px] ml-2 hidden sm:inline">
          {lang === 'da'
            ? 'Træk noder · Hold og træk for panorering · Dobbeltklik for zoom'
            : 'Drag nodes · Hold & drag to pan · Double-click to zoom'}
        </span>
        {/* BIZZ-451: Toggle property nodes */}
        {propertyCount > 0 && (
          <button
            onClick={() => {
              setShowProperties((s) => !s);
              // Trigger re-fit after toggling property visibility
              initialFitDone.current = false;
              setTimeout(() => setFitTrigger((t) => t + 1), 50);
            }}
            className={`h-7 px-2 flex items-center gap-1 text-[10px] font-medium border rounded-lg transition ${
              showProperties
                ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-800 border-slate-700/50 text-slate-400 hover:text-slate-300'
            }`}
            title={
              showProperties
                ? lang === 'da'
                  ? 'Skjul ejendomme'
                  : 'Hide properties'
                : lang === 'da'
                  ? `Vis ejendomme (${propertyCount})`
                  : `Show properties (${propertyCount})`
            }
          >
            <Building2 size={11} />
            {showProperties
              ? lang === 'da'
                ? 'Ejendomme'
                : 'Properties'
              : lang === 'da'
                ? `Ejendomme (${propertyCount})`
                : `Properties (${propertyCount})`}
          </button>
        )}
        {/* BIZZ-1004: Toggle personligt ejede ejendomme — kun på virksomhedsdiagram */}
        {defaultShowProperties && personalPropNodeIds.size > 0 && (
          <button
            onClick={() => {
              setShowPersonalProps((s) => !s);
              initialFitDone.current = false;
              setTimeout(() => setFitTrigger((t) => t + 1), 50);
            }}
            className={`h-7 px-2 flex items-center gap-1 text-[10px] font-medium border rounded-lg transition ml-1 ${
              showPersonalProps
                ? 'bg-violet-600/20 border-violet-500/40 text-violet-300'
                : 'bg-slate-800 border-slate-700/50 text-slate-400 hover:text-slate-300'
            }`}
            title={
              showPersonalProps
                ? lang === 'da'
                  ? 'Skjul personlige ejendomme'
                  : 'Hide personal properties'
                : lang === 'da'
                  ? 'Vis personlige ejendomme'
                  : 'Show personal properties'
            }
            aria-label={
              showPersonalProps
                ? lang === 'da'
                  ? 'Skjul personlige ejendomme'
                  : 'Hide personal properties'
                : lang === 'da'
                  ? 'Vis personlige ejendomme'
                  : 'Show personal properties'
            }
          >
            <Home size={11} />
            {lang === 'da' ? 'Personlige' : 'Personal'}
          </button>
        )}
        {/* BIZZ-427: Toggle ceased/historical owners */}
        {effectiveGraph.nodes.some((n) => n.isCeased) && (
          <button
            onClick={() => setShowCeased((s) => !s)}
            className={`h-7 px-2 flex items-center gap-1 text-[10px] font-medium border rounded-lg transition ml-1 ${
              showCeased
                ? 'bg-amber-600/20 border-amber-500/40 text-amber-300'
                : 'bg-slate-800 border-slate-700/50 text-slate-400 hover:text-slate-300'
            }`}
            title={lang === 'da' ? 'Vis/skjul ophørte ejere' : 'Show/hide ceased owners'}
          >
            <Clock size={11} />
            {lang === 'da' ? 'Historiske' : 'Historical'}
          </button>
        )}
        {/* Fullscreen toggle */}
        <button
          onClick={() => {
            setIsFullscreen((f) => !f);
            // Trigger re-fit efter fullscreen toggle (container ændrer størrelse)
            setTimeout(() => setFitTrigger((t) => t + 1), 150);
          }}
          className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg transition ml-1"
          aria-label="Skift fuldskærm"
          title={
            isFullscreen
              ? lang === 'da'
                ? 'Luk fuldskærm (Esc)'
                : 'Exit fullscreen (Esc)'
              : lang === 'da'
                ? 'Fuldskærm'
                : 'Fullscreen'
          }
        >
          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        {/* BIZZ-867/934: Eksport af diagram som PNG billede.
            Serialiserer SVG → Canvas → PNG blob → download. */}
        <button
          onClick={async () => {
            const svgEl = svgRef.current;
            if (!svgEl) return;
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svgEl);
            const svgBlob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svgString}`], {
              type: 'image/svg+xml;charset=utf-8',
            });
            const svgUrl = URL.createObjectURL(svgBlob);
            const img = new Image();
            img.onload = () => {
              const scale = 2; // 2x for high-DPI
              const canvas = document.createElement('canvas');
              canvas.width = img.width * scale;
              canvas.height = img.height * scale;
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              ctx.fillStyle = '#0f172a'; // dark background
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.scale(scale, scale);
              ctx.drawImage(img, 0, 0);
              canvas.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `diagram-${Date.now()}.png`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }, 'image/png');
              URL.revokeObjectURL(svgUrl);
            };
            img.src = svgUrl;
          }}
          className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg transition ml-1"
          aria-label={lang === 'da' ? 'Eksportér diagram som PNG' : 'Export diagram as PNG'}
          title={lang === 'da' ? 'Eksportér som PNG-billede' : 'Export as PNG image'}
        >
          <Download size={13} />
        </button>
        {/* BIZZ-1003: "Send til AI" knap fjernet — AI henter diagram direkte via tool */}
      </div>
    </div>
  );

  // BIZZ-1006/1035: Shared-entity links deaktiveret — skabte forvirrende linjer
  const _sharedLinks = useMemo(() => {
    const targetToSources = new Map<string, string[]>();
    for (const edge of filteredGraph.edges) {
      const sources = targetToSources.get(edge.to) ?? [];
      sources.push(edge.from);
      targetToSources.set(edge.to, sources);
    }
    const links: Array<{ a: string; b: string; shared: string }> = [];
    for (const [target, sources] of targetToSources) {
      if (sources.length < 2) continue;
      // Create pairwise links between sources that share a target
      for (let i = 0; i < sources.length && i < 5; i++) {
        for (let j = i + 1; j < sources.length && j < 5; j++) {
          links.push({ a: sources[i], b: sources[j], shared: target });
        }
      }
    }
    return links;
  }, [filteredGraph.edges]);

  /** SVG edges + nodes content (shared between normal and fullscreen) */
  const svgContent = (
    <>
      {/* Transparent background rect for pan/double-click hit area */}
      <rect
        x={viewBox.minX}
        y={viewBox.minY}
        width={viewBox.w}
        height={viewBox.h}
        fill="transparent"
      />

      {/* BIZZ-1006/1035: Shared-entity links deaktiveret — skabte forvirrende linjer */}

      {/* ── Edges ── */}
      {filteredGraph.edges.map((edge, i) => {
        const fromPos = positions.get(edge.from);
        const toPos = positions.get(edge.to);
        if (!fromPos || !toPos) return null;

        const fromNode = filteredGraph.nodes.find((n) => n.id === edge.from);
        const toNode = filteredGraph.nodes.find((n) => n.id === edge.to);
        const fromH = fromNode ? getNodeH(fromNode, expandedOverflow) : NODE_H;
        const toH = toNode ? getNodeH(toNode, expandedOverflow) : NODE_H;
        const isCoOwnerEdge = fromNode?.isCoOwner || toNode?.isCoOwner;

        const sx = fromPos.x;
        const sy = fromPos.y + fromH / 2;
        const ex = toPos.x;
        const ey = toPos.y - toH / 2;
        const midY = (sy + ey) / 2;
        const midX = (sx + ex) / 2;
        // BIZZ-1042: Kontrolpunkter for Bezier — blend mod midtpunkt for
        // at undgå at kurven strækker sig horisontalt ud over node-grænser.
        const cx1 = sx + (midX - sx) * 0.15;
        const cx2 = ex + (midX - ex) * 0.15;

        // Property edges rendered with emerald color to match property nodes
        const isPropertyEdge = toNode?.type === 'property' || edge.to.startsWith('props-overflow-');
        // BIZZ-585: Person→property edges stippled med lysere emerald så
        // personligt-ejede-relationer er visuelt adskilt fra virksomheds-
        // ejendom-relationer. Brugeren kan dermed hurtigt identificere
        // hvilke ejendomme der ejes direkte af personen vs via selskab.
        // BIZZ-689: crossOwnership-edges (krydsejerskab mellem virksomheder
        // i samme graf) bruger amber-farve + dashed for visuel distinktion
        // fra primary parent→child-edges.
        // personallyOwned edges er person→ejendom og bør vises som
        // ejendomslinjer (grøn), ikke som crossOwnership (amber)
        const isCrossOwnership = !!edge.crossOwnership && !edge.personallyOwned;
        /* BIZZ-1086: crossOwnership-linjer gjort mere subtile (0.35 opacity) */
        // Person→property bruger SAMME stil som company→property (ensartet look)
        const strokeColor = isCrossOwnership
          ? 'rgba(251,191,36,0.35)' // amber-400 subtil
          : isCoOwnerEdge
            ? 'rgba(167,139,250,0.55)'
            : isPropertyEdge
              ? 'rgba(52,211,153,0.65)'
              : edge.from === effectiveGraph.mainId || edge.to === effectiveGraph.mainId
                ? 'rgba(96,165,250,0.85)'
                : 'rgba(148,163,184,0.75)';
        // BIZZ-689: cross-ownership bruger længere dash-pattern (6 4),
        // co-owner bruger (4 3). Ejendomme er solid (ingen dash).
        const dashArray = isCrossOwnership ? '6 4' : isCoOwnerEdge ? '4 3' : undefined;

        return (
          <g key={`e-${i}`}>
            <path
              d={`M ${sx} ${sy} C ${cx1} ${midY}, ${cx2} ${midY}, ${ex} ${ey}`}
              fill="none"
              stroke={strokeColor}
              strokeWidth={isCrossOwnership ? 1.25 : isCoOwnerEdge ? 1.5 : 2.25}
              strokeDasharray={dashArray}
            />
            <polygon
              points={`${ex},${ey} ${ex - 5},${ey - 9} ${ex + 5},${ey - 9}`}
              fill={strokeColor}
            />
            {edge.ejerandel && (
              <>
                <rect
                  x={midX - 28}
                  y={midY - 8}
                  width="56"
                  height="16"
                  rx="4"
                  fill="rgba(16,185,129,0.1)"
                  stroke="rgba(16,185,129,0.2)"
                  strokeWidth="0.5"
                />
                <text
                  x={midX}
                  y={midY + 3}
                  textAnchor="middle"
                  fill="rgba(52,211,153,0.85)"
                  fontSize="9"
                  fontWeight="500"
                >
                  {edge.ejerandel}
                </text>
              </>
            )}
          </g>
        );
      })}

      {/* ── Nodes ── */}
      {filteredGraph.nodes.map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const isMain = node.type === 'main';
        const isPerson = node.type === 'person';
        const isProperty = node.type === 'property';
        const isStatus = node.type === 'status';
        const isCoOwner = node.isCoOwner;
        // BIZZ-357: Detect ceased companies for distinct greyed-out rendering
        const isCeased = node.isCeased === true;
        const hasExpandable = (node.expandableChildren ?? 0) > 0;
        const h = getNodeH(node, expandedOverflow);
        const isExpanded = expandedNodes.has(node.id);

        let fill: string, stroke: string, textFill: string, iconStroke: string;
        if (isMain) {
          fill = MAIN_FILL;
          stroke = MAIN_STROKE;
          textFill = '#ffffff';
          iconStroke = 'rgba(96,165,250,0.7)';
        } else if (isProperty) {
          fill = PROPERTY_FILL;
          stroke = PROPERTY_STROKE;
          textFill = 'rgba(167,243,208,0.95)';
          iconStroke = 'rgba(52,211,153,0.7)';
        } else if (isStatus) {
          fill = 'rgba(71,85,105,0.15)';
          stroke = 'rgba(100,116,139,0.4)';
          textFill = 'rgba(165,180,200,0.9)';
          iconStroke = 'rgba(148,163,184,0.5)';
        } else if (isPerson) {
          fill = PERSON_FILL;
          stroke = PERSON_STROKE;
          textFill = PERSON_TEXT;
          iconStroke = PERSON_ICON;
        } else if (isCeased) {
          // BIZZ-357: Ceased companies get a grey wash with dashed border
          fill = CEASED_FILL;
          stroke = CEASED_STROKE;
          textFill = 'rgba(160,165,175,0.75)';
          iconStroke = 'rgba(120,130,145,0.5)';
        } else if (isCoOwner) {
          fill = COOWNER_FILL;
          stroke = COOWNER_STROKE;
          textFill = 'rgba(220,225,235,0.85)';
          iconStroke = 'rgba(140,150,170,0.6)';
        } else {
          fill = COMPANY_FILL;
          stroke = COMPANY_STROKE;
          textFill = 'rgba(230,235,245,0.95)';
          iconStroke = 'rgba(148,163,184,0.6)';
        }

        const rx = isPerson ? h / 2 : isProperty ? 16 : 12;
        // BIZZ-563: Overflow-noder bruger nu NODE_W_PROPERTY (260px) i kollapseret
        // tilstand — kun count + "Vis alle" vises, ingen adresse-liste. Den bredere
        // NODE_W_OVERFLOW (400) var overkill for kompakt indhold og bidrag til
        // overlap med sibling-noder. Modal viser fuld liste (BIZZ-479).
        const w = node.overflowItems ? NODE_W_PROPERTY : isProperty ? NODE_W_PROPERTY : NODE_W;
        const x = pos.x - w / 2;
        // Overflow-noder: forankr fra toppen (brug kollapseret højde) så de udvider nedad
        const collapsedH = node.overflowItems
          ? 30 +
            Math.min(node.overflowItems.length, OVERFLOW_INITIAL_SHOW) * 16 +
            (node.overflowItems.length > OVERFLOW_INITIAL_SHOW ? 20 : 0)
          : h;
        const y = pos.y - collapsedH / 2;

        // ── Overflow list node — BIZZ-563: kompakt count-only visning ──
        // Tidligere viste vi de første 5 adresser inline, men det gjorde boksen
        // ~130px høj og overlappede sibling-noder selv med dedikeret sub-row
        // (BIZZ-558). Nu viser vi kun antal + "Vis alle"-knap. Fuld liste i
        // modal (BIZZ-479).
        if (node.overflowItems) {
          return (
            <g
              key={node.id}
              style={{ cursor: 'grab' }}
              onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
            >
              {/* BIZZ-354: Tooltip for readability at low zoom */}
              <title>
                {node.label}
                {node.sublabel ? ` — ${node.sublabel}` : ''}
              </title>
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                rx={12}
                fill="rgba(30,41,59,0.6)"
                stroke="rgba(71,85,105,0.4)"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
              <text
                x={x + w / 2}
                y={y + 18}
                textAnchor="middle"
                fill="rgba(165,180,200,0.95)"
                fontSize="11"
                fontWeight="600"
                className="pointer-events-none"
              >
                {node.label}
              </text>
              {node.overflowItems.length > 0 && (
                <g
                  className="cursor-pointer"
                  style={{ pointerEvents: 'auto' }}
                  onClick={(e) => {
                    // BIZZ-479: Åbn modal i stedet for at udvide inline. Fold-
                    // ud-logikken kollapsede tidligere layoutet når overflow
                    // havde 20+ items (fx NOVO NORDISK's 74 ejendomme).
                    e.stopPropagation();
                    setOverflowModalNode(node);
                  }}
                >
                  <rect
                    x={x + w / 2 - 50}
                    y={y + h - 18}
                    width={100}
                    height={15}
                    rx={8}
                    fill="rgba(51,65,85,0.6)"
                    stroke="rgba(71,85,105,0.5)"
                    strokeWidth="0.5"
                  />
                  <text
                    x={x + w / 2}
                    y={y + h - 8}
                    textAnchor="middle"
                    fill="rgba(148,163,184,0.9)"
                    fontSize="8"
                    fontWeight="500"
                  >
                    ▸ Vis alle {node.overflowItems.length}
                  </text>
                </g>
              )}
            </g>
          );
        }

        return (
          <g
            key={node.id}
            style={{ cursor: node.link ? 'pointer' : 'grab' }}
            onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
            onClick={() => {
              if (!dragRef.current.didMove) {
                if (onNodeClick) {
                  // BIZZ-368: caller-controlled navigation (e.g. switch tab instead of navigate)
                  onNodeClick(node);
                } else if (node.link) {
                  window.location.href = node.link;
                }
              }
            }}
          >
            <title>
              {node.label}
              {isCeased ? ' (Ophørt)' : ''}
              {node.sublabel ? ` — ${node.sublabel}` : ''}
            </title>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={rx}
              fill={fill}
              stroke={stroke}
              strokeWidth={isMain ? 2 : 1}
              // BIZZ-357: Ceased companies get a dashed border; co-owners also dashed
              strokeDasharray={isCeased || isCoOwner ? '4 3' : undefined}
            />
            {/* BIZZ-357: "Ophørt" badge in top-right corner of ceased company nodes */}
            {isCeased && (
              <>
                <rect
                  x={x + NODE_W - 56}
                  y={y + 6}
                  width={50}
                  height={13}
                  rx={4}
                  fill="rgba(75,80,95,0.7)"
                  stroke="rgba(100,110,130,0.4)"
                  strokeWidth={0.75}
                />
                <text
                  x={x + NODE_W - 31}
                  y={y + 15.5}
                  fill="rgba(180,185,195,0.85)"
                  fontSize="7.5"
                  fontWeight="500"
                  textAnchor="middle"
                  className="pointer-events-none"
                >
                  Ophørt
                </text>
              </>
            )}
            {(() => {
              // Top-aligned text positioning — all content starts from top of box
              const topY = y + 12; // 12px padding from top
              const _iconCy = topY + 6; // icon center Y

              return (
                <>
                  {isPerson ? (
                    <circle
                      cx={x + 20}
                      cy={pos.y}
                      r={6}
                      fill="none"
                      stroke={iconStroke}
                      strokeWidth="1.2"
                    />
                  ) : (
                    <>
                      {isProperty ? (
                        /* Property icon — house */
                        <path
                          d={`M${x + 12} ${topY + 7} l6-5 6 5 v7h-4v-4h-4v4h-4v-7z`}
                          fill="none"
                          stroke={iconStroke}
                          strokeWidth="1.2"
                        />
                      ) : (
                        <rect
                          x={x + 12}
                          y={topY}
                          width={12}
                          height={12}
                          rx={2}
                          fill="none"
                          stroke={iconStroke}
                          strokeWidth="1"
                        />
                      )}
                      {/* Property nodes: address (line 1), postnr/by (line 2), BFE (line 3)
                          Non-property nodes: label (line 1), role/CVR (line 2) */}
                      {isProperty ? (
                        (() => {
                          const parts = node.label.split(',').map((s) => s.trim());
                          const street = parts[0] ?? node.label;
                          const postBy = parts.slice(1).join(', ');
                          // Truncate street to fit in box (NODE_W=320, ~30 chars at 11px)
                          const maxStreet = 32;
                          const streetText =
                            street.length > maxStreet ? street.slice(0, maxStreet) + '…' : street;
                          return (
                            <>
                              <text
                                x={x + 30}
                                y={topY + 10}
                                fill={textFill}
                                fontSize="11"
                                fontWeight="500"
                                className="cursor-pointer pointer-events-none"
                              >
                                {streetText}
                              </text>
                              {postBy && (
                                <text
                                  x={x + 30}
                                  y={topY + 23}
                                  fill="rgba(167,243,208,0.85)"
                                  fontSize="9.5"
                                  className="pointer-events-none"
                                >
                                  {postBy.length > 36 ? postBy.slice(0, 36) + '…' : postBy}
                                </text>
                              )}
                              {node.bfeNummer && (
                                <text
                                  x={x + 30}
                                  y={topY + 38}
                                  fill="rgba(110,231,183,0.65)"
                                  fontSize="8.5"
                                  className="pointer-events-none"
                                >
                                  BFE {node.bfeNummer.toLocaleString('da-DK')}
                                </text>
                              )}
                            </>
                          );
                        })()
                      ) : (
                        <>
                          <text
                            x={x + 30}
                            y={topY + 10}
                            fill={textFill}
                            fontSize="11"
                            fontWeight={isMain ? '600' : '500'}
                            className="cursor-pointer pointer-events-none"
                          >
                            {node.label.length > 44 ? node.label.slice(0, 44) + '…' : node.label}
                          </text>
                          {node.personRolle ? (
                            <text
                              x={x + 30}
                              y={topY + 23}
                              fill="rgba(196,167,255,0.9)"
                              fontSize="9"
                              fontWeight="500"
                              className="pointer-events-none"
                            >
                              {node.personRolle.length > 50
                                ? node.personRolle.slice(0, 50) + '…'
                                : node.personRolle}
                            </text>
                          ) : node.cvr ? (
                            <text
                              x={x + 30}
                              y={topY + 23}
                              fill="rgba(165,180,200,0.9)"
                              fontSize="9"
                              className="pointer-events-none"
                            >
                              CVR {node.cvr}
                            </text>
                          ) : null}
                        </>
                      )}
                      {/* Branche */}
                      {node.branche && (
                        <text
                          x={x + 30}
                          y={topY + 35}
                          fill="rgba(155,170,190,0.75)"
                          fontSize="9"
                          className="pointer-events-none"
                        >
                          {node.branche.length > 50
                            ? node.branche.slice(0, 50) + '…'
                            : node.branche}
                        </text>
                      )}
                      {/* Sublabel fallback (form) if no branche — NOT for property nodes
                          (property nodes render BFE at y+38 instead) */}
                      {!node.branche && !isProperty && node.sublabel && (
                        <text
                          x={x + 30}
                          y={topY + 35}
                          fill="rgba(155,170,190,0.75)"
                          fontSize="9"
                          className="pointer-events-none"
                        >
                          {node.sublabel.length > 50
                            ? node.sublabel.slice(0, 50) + '…'
                            : node.sublabel}
                        </text>
                      )}
                      {/* Separator line before persons */}
                      {node.noeglePersoner && node.noeglePersoner.length > 0 && (
                        <line
                          x1={x + 10}
                          y1={topY + 42}
                          x2={x + NODE_W - 10}
                          y2={topY + 42}
                          stroke="rgba(71,85,105,0.3)"
                          strokeWidth="0.5"
                        />
                      )}
                      {/* Key persons inside company box — klikbar expand til person-node */}
                      {node.noeglePersoner &&
                        node.noeglePersoner.slice(0, 5).map((p, pi) => {
                          const personNodeId = `en-${p.enhedsNummer}`;
                          const alreadyInGraph = effectiveGraph.nodes.some(
                            (n) => n.id === personNodeId
                          );
                          const isLoading = loadingExpansion.has(personNodeId);
                          return (
                            <g key={pi}>
                              <circle
                                cx={x + 16}
                                cy={topY + 50 + pi * PERSON_ROW_H}
                                r={3.5}
                                fill="none"
                                stroke={
                                  p.rolle === 'Bestyrelse'
                                    ? 'rgba(139,92,246,0.5)'
                                    : 'rgba(245,158,11,0.5)'
                                }
                                strokeWidth="0.8"
                              />
                              <text
                                x={x + 23}
                                y={topY + 53 + pi * PERSON_ROW_H}
                                fill="rgba(196,167,255,0.7)"
                                fontSize="8"
                                className="pointer-events-none cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href = `/dashboard/owners/${p.enhedsNummer}`;
                                }}
                                style={{ cursor: 'pointer', pointerEvents: 'auto' }}
                              >
                                {(() => {
                                  const label = p.rolle ? `${p.navn}, ${p.rolle}` : p.navn;
                                  return label.length > 40 ? label.slice(0, 40) + '…' : label;
                                })()}
                              </text>
                              {/* BIZZ-1125: Expand nøgleperson til person-node med ejendomme */}
                              {!alreadyInGraph && (
                                <g
                                  className="cursor-pointer"
                                  style={{ pointerEvents: 'auto' }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onTouchStart={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isLoading) return;
                                    // Opret person-node i grafen
                                    const newPersonNode: DiagramNode = {
                                      id: personNodeId,
                                      label: p.navn,
                                      type: 'person',
                                      enhedsNummer: p.enhedsNummer,
                                      link: `/dashboard/owners/${p.enhedsNummer}`,
                                    };
                                    const newEdge: DiagramEdge = {
                                      from: personNodeId,
                                      to: node.id,
                                      ejerandel: p.rolle === 'Bestyrelse' ? 'Best.' : 'Dir.',
                                    };
                                    addExtensionNodesWithLevel([newPersonNode], node.id);
                                    setExtensionEdges((prev) => [...prev, newEdge]);
                                    // Kald expand for at hente personens ejendomme
                                    if (onExpand) {
                                      setLoadingExpansion(
                                        (prev) => new Set([...prev, personNodeId])
                                      );
                                      void onExpand(personNodeId, 'person').then((result) => {
                                        setLoadingExpansion((prev) => {
                                          const s = new Set(prev);
                                          s.delete(personNodeId);
                                          return s;
                                        });
                                        if (result) {
                                          addExtensionNodesWithLevel(result.nodes, personNodeId);
                                          setExtensionEdges((prev) => [...prev, ...result.edges]);
                                          if (result.nodes.length > 0 || result.edges.length > 0) {
                                            markExpanded(personNodeId);
                                          }
                                        }
                                      });
                                    }
                                  }}
                                  aria-label={`Udvid ${p.navn} i diagrammet`}
                                >
                                  <rect
                                    x={x + NODE_W - 46}
                                    y={topY + 43 + pi * PERSON_ROW_H}
                                    width={32}
                                    height={14}
                                    rx={7}
                                    fill="rgba(16,185,129,0.12)"
                                    stroke="rgba(52,211,153,0.35)"
                                    strokeWidth="0.5"
                                  />
                                  <text
                                    x={x + NODE_W - 30}
                                    y={topY + 53 + pi * PERSON_ROW_H}
                                    textAnchor="middle"
                                    fill="rgba(52,211,153,0.9)"
                                    fontSize="7"
                                    fontWeight="500"
                                    className="pointer-events-none"
                                  >
                                    {isLoading ? '…' : '+ Vis'}
                                  </text>
                                </g>
                              )}
                              {alreadyInGraph && (
                                <text
                                  x={x + NODE_W - 14}
                                  y={topY + 53 + pi * PERSON_ROW_H}
                                  fill="rgba(148,163,184,0.5)"
                                  fontSize="7"
                                  textAnchor="end"
                                  className="pointer-events-none"
                                >
                                  {p.rolle === 'Bestyrelse' ? 'Best.' : 'Dir.'}
                                </text>
                              )}
                            </g>
                          );
                        })}
                    </>
                  )}
                  {/* Person node label (centered) */}
                  {isPerson && (
                    <text
                      x={x + 30}
                      y={pos.y + 4}
                      fill={textFill}
                      fontSize="11"
                      fontWeight={isMain ? '600' : '500'}
                      className="cursor-pointer pointer-events-none"
                    >
                      {node.label.length > 44 ? node.label.slice(0, 44) + '…' : node.label}
                    </text>
                  )}
                  {/* Person dynamic expand — fetch this person's other owned companies.
                      BIZZ-586: Tilladt OGSAA paa root-person-noder (isMain) saa
                      personligt ejede virksomheder + ejendomme kan vises paa
                      person-side-diagrammet. Tidligere udelukket via !isMain. */}
                  {isPerson &&
                    node.enhedsNummer != null &&
                    node.expandableChildren != null &&
                    node.expandableChildren > 0 &&
                    (() => {
                      const personLoading = loadingExpansion.has(node.id);
                      const personExpanded = expandedDynamic.has(node.id);
                      // Once expanded, hide the button so the person can't re-trigger a duplicate fetch
                      if (personExpanded) return null;
                      return (
                        <g
                          className="cursor-pointer"
                          style={{ pointerEvents: 'auto' }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onTouchStart={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (personLoading) return;
                            if (onExpand) {
                              setLoadingExpansion((prev) => new Set([...prev, node.id]));
                              void onExpand(node.id, 'person').then((result) => {
                                setLoadingExpansion((prev) => {
                                  const s = new Set(prev);
                                  s.delete(node.id);
                                  return s;
                                });
                                if (result) {
                                  addExtensionNodesWithLevel(result.nodes, node.id);
                                  setExtensionEdges((prev) => [...prev, ...result.edges]);
                                  if (result.nodes.length > 0 || result.edges.length > 0) {
                                    markExpanded(node.id);
                                  }
                                }
                              });
                            } else {
                              expandPersonDynamic(node.id, node.enhedsNummer!);
                            }
                          }}
                        >
                          <rect
                            x={x + NODE_W - 68}
                            y={pos.y - 8}
                            width={58}
                            height={16}
                            rx={8}
                            fill="rgba(139,92,246,0.15)"
                            stroke="rgba(139,92,246,0.4)"
                            strokeWidth="0.6"
                          />
                          <text
                            x={x + NODE_W - 39}
                            y={pos.y + 3}
                            textAnchor="middle"
                            fill="rgba(196,167,255,0.95)"
                            fontSize="8"
                            fontWeight="500"
                            className="pointer-events-none"
                          >
                            {personLoading ? '… henter' : '▸ Udvid'}
                          </text>
                        </g>
                      );
                    })()}
                  {/* BIZZ-1081: Virksomheds-Udvid — vis for virksomheder der kan have
                      ejere eller ejendomme at opdage. Skjules efter expand.
                      BIZZ-1122: Skjul for main-node og noder med expandableChildren=0. */}
                  {!isPerson &&
                    node.cvr != null &&
                    node.type !== 'main' &&
                    node.expandableChildren != null &&
                    node.expandableChildren > 0 &&
                    (() => {
                      const companyLoading = loadingExpansion.has(node.id);
                      const companyExpanded = expandedDynamic.has(node.id);
                      if (companyExpanded) return null;
                      return (
                        <g
                          className="cursor-pointer"
                          style={{ pointerEvents: 'auto' }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onTouchStart={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (companyLoading) return;
                            if (onExpand) {
                              setLoadingExpansion((prev) => new Set([...prev, node.id]));
                              void onExpand(node.id, 'company').then((result) => {
                                setLoadingExpansion((prev) => {
                                  const s = new Set(prev);
                                  s.delete(node.id);
                                  return s;
                                });
                                if (result) {
                                  addExtensionNodesWithLevel(result.nodes, node.id);
                                  setExtensionEdges((prev) => [...prev, ...result.edges]);
                                  markExpanded(node.id);
                                }
                              });
                            } else {
                              expandCompanyDynamic(node.id, node.cvr!);
                            }
                          }}
                        >
                          <rect
                            x={x + NODE_W - 68}
                            y={pos.y - 8}
                            width={58}
                            height={16}
                            rx={8}
                            fill="rgba(139,92,246,0.15)"
                            stroke="rgba(139,92,246,0.4)"
                            strokeWidth="0.6"
                          />
                          <text
                            x={x + NODE_W - 39}
                            y={pos.y + 3}
                            textAnchor="middle"
                            fill="rgba(196,167,255,0.95)"
                            fontSize="8"
                            fontWeight="500"
                            className="pointer-events-none"
                          >
                            {companyLoading ? '… henter' : '▸ Udvid'}
                          </text>
                        </g>
                      );
                    })()}
                </>
              );
            })()}
            {/* Fold/unfold for co-owner children — KUN vis hvis noden har
                skjulte children med collapseParent (ikke ejerskabs-expand) */}
            {hasExpandable && effectiveGraph.nodes.some((n) => n.collapseParent === node.id) && (
              <g
                className="cursor-pointer"
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node.id);
                }}
              >
                <rect
                  x={x + NODE_W - 56}
                  y={y + h - 14}
                  width={52}
                  height={15}
                  rx={8}
                  fill={isExpanded ? 'rgba(139,92,246,0.2)' : 'rgba(51,65,85,0.6)'}
                  stroke={isExpanded ? 'rgba(139,92,246,0.4)' : 'rgba(71,85,105,0.5)'}
                  strokeWidth="0.5"
                />
                <text
                  x={x + NODE_W - 30}
                  y={y + h - 4}
                  textAnchor="middle"
                  fill={isExpanded ? 'rgba(196,167,255,0.9)' : 'rgba(148,163,184,0.8)'}
                  fontSize="7.5"
                  fontWeight="500"
                >
                  {isExpanded ? '▾ Skjul' : '▸ Udvid'} {node.expandableChildren}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </>
  );

  /** The interactive SVG canvas wrapper */
  const canvasEl = (
    <div
      ref={containerRef}
      className={`bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-auto select-none ${isFullscreen ? 'flex-1' : ''}`}
      style={{
        minHeight: isFullscreen ? undefined : '500px',
        maxHeight: isFullscreen ? undefined : '85vh',
        cursor: 'grab',
      }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      // BIZZ-555: Pan-handler er flyttet fra <svg> til ydre <div> så hele
      // canvas-området kan trækkes — ikke kun området hvor SVG-indholdets
      // bounding-box ligger. Node-mousedown stopPropagation så klik på
      // noder ikke trigger pan.
      onMouseDown={handleSvgMouseDown}
    >
      <div
        style={{
          transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
          transformOrigin: 'top left',
          padding: 16,
        }}
      >
        {/* BIZZ-865/932: Loading-dot vises kun ved allerførste render
            (ingen positions endnu). Efterfølgende sim-restarts viser
            eksisterende layout mens nyt beregnes. */}
        {!hasEverSimulated.current && positions.size === 0 && filteredGraph.nodes.length > 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-2 h-2 rounded-full bg-blue-400/60 animate-pulse" />
          </div>
        )}
        <svg
          ref={svgRef}
          width={viewBox.w}
          height={viewBox.h}
          viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.w} ${viewBox.h}`}
          // BIZZ-932: SVG synlig så snart positions er beregnet (positions.size > 0)
          // ELLER hasEverSimulated er true. Undgår permanent opacity:0 fra
          // oscillerende simulationReady state. Første render fade'r ind via
          // CSS-transition; efterfølgende restarts holder SVG synlig.
          style={{
            overflow: 'visible',
            opacity: hasEverSimulated.current || positions.size > 0 ? 1 : 0,
            transition: 'opacity 180ms ease-out',
          }}
        >
          {svgContent}
        </svg>
      </div>
    </div>
  );

  /** Warning badge when nodes are hidden due to overflow grouping */
  const hiddenWarning = effectiveGraph.hiddenCount ? (
    <div className="absolute top-3 right-3 z-10 max-w-[200px] px-2.5 py-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[10px] font-medium leading-tight backdrop-blur-sm">
      <span className="font-bold">{effectiveGraph.hiddenCount}</span>{' '}
      {lang === 'da'
        ? `virksomheder relateret til "flere virksomheder" er ikke vist`
        : `companies related to "more companies" are not shown`}
    </div>
  ) : null;

  // BIZZ-479: Modal til overflow-lister (fx NOVO NORDISK's 74 ejendomme).
  // Tidligere foldede listen ud inline i SVG og kolliderede med andre noder
  // + skar pile. Nu åbner "Vis alle" en scrollbar modal så det ikke påvirker
  // diagram-layoutet.
  const overflowModal = overflowModalNode ? (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="overflow-modal-title"
      onClick={() => setOverflowModalNode(null)}
    >
      <div
        className="bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/40">
          <h2 id="overflow-modal-title" className="text-white text-sm font-medium">
            {overflowModalNode.label}
          </h2>
          <button
            onClick={() => setOverflowModalNode(null)}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800/50"
            aria-label={lang === 'da' ? 'Luk' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-3 space-y-1">
          {(overflowModalNode.overflowItems ?? []).map((item, idx) => (
            <a
              key={idx}
              href={item.link}
              onClick={(e) => {
                if (!item.link) e.preventDefault();
              }}
              className={`block px-3 py-2 rounded-lg text-xs text-slate-200 hover:bg-slate-800/60 hover:text-blue-300 transition-colors ${
                item.link ? 'cursor-pointer' : 'cursor-default text-slate-400'
              }`}
            >
              <span className="text-slate-500 mr-2">•</span>
              {item.label}
            </a>
          ))}
        </div>
        <div className="px-5 py-2 border-t border-slate-700/40 text-[10px] text-slate-500">
          {overflowModalNode.overflowItems?.length ?? 0} {lang === 'da' ? 'enheder' : 'items'}
        </div>
      </div>
    </div>
  ) : null;

  // ── Fullscreen overlay (BIZZ-248: topbar with close button) ──
  // BIZZ-850: Portal til document.body saa overlay ikke bliver trapped
  // i <main>.z-0 stacking context. <header> i dashboard-layout er z-10
  // sibling og ville ellers dække vores z-50 selvom tal er højere —
  // fordi `<main>` creates en ny stacking-context der isolerer z-50.
  if (isFullscreen) {
    const overlay = (
      <div className="fixed inset-0 z-[100] bg-slate-950/95 flex flex-col">
        {/* Topbar with title + close button */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/40 shrink-0">
          <h2 className="text-white text-sm font-medium">
            {lang === 'da' ? 'Relationsdiagram' : 'Relationship diagram'}
          </h2>
          <button
            onClick={() => setIsFullscreen(false)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/40 rounded-lg transition-colors"
            aria-label={lang === 'da' ? 'Luk fuldskærm' : 'Close fullscreen'}
          >
            <Minimize2 size={12} />
            {lang === 'da' ? 'Luk' : 'Close'}
            <kbd className="ml-1 text-[10px] text-slate-600 bg-slate-800 px-1 rounded">ESC</kbd>
          </button>
        </div>
        <div className="p-4 gap-3 flex flex-col flex-1 min-h-0">
          {toolbar}
          <div className="relative flex-1 flex flex-col">
            {canvasEl}
            {hiddenWarning}
          </div>
        </div>
        {overflowModal}
      </div>
    );
    // createPortal kun i browser-kontekst — SSR render returnerer null
    // (overlay vises kun ved user-klik, saa SSR-path bliver aldrig ramt).
    return typeof document !== 'undefined' ? createPortal(overlay, document.body) : null;
  }

  // ── Normal inline mode ──
  return (
    <div className="space-y-1">
      {toolbar}
      <div className="relative">
        {canvasEl}
        {hiddenWarning}
      </div>
      {overflowModal}
    </div>
  );
}

// BIZZ-600: Memoize med default shallow-compare — graph, lang og
// onNodeClick skal være stable refs fra parent (memoiseres typisk via
// useMemo/useCallback) for at memoet rammer. Dynamic import i parents
// behøver ikke default-export-ændring fordi memo(Fn) også er en gyldig
// funktionel komponent.
export default memo(DiagramForce);
