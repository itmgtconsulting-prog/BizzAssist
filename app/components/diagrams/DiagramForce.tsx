'use client';

/**
 * D3 Force-directed diagram — physics simulation for organic layout.
 * Supports fold/expand of co-owners. Persons shown in purple.
 *
 * @param props - DiagramVariantProps
 */

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import type { DiagramVariantProps, DiagramNode } from './DiagramData';

// ─── Constants ──────────────────────────────────────────────────────────────

const NODE_W = 320;
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
  if (node.overflowItems) {
    const isExpanded = expandedOverflowIds?.has(node.id) ?? false;
    const showCount = isExpanded
      ? node.overflowItems.length
      : Math.min(node.overflowItems.length, OVERFLOW_INITIAL_SHOW);
    const hasToggle = node.overflowItems.length > OVERFLOW_INITIAL_SHOW;
    return 30 + showCount * 16 + (hasToggle ? 20 : 0);
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
 * @param props - graph + lang + optional onNodeClick override
 */
export default function DiagramForce({ graph, lang, onNodeClick }: DiagramVariantProps) {
  const _router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  /** User-dragged node positions — preserved across simulation re-runs.
   * Cleared when user clicks Reset. */
  const userPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  /** Set of node IDs whose co-owners are currently expanded */
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  /** Set of overflow node IDs that are fully expanded (show all items) — starter udfoldet */
  const [expandedOverflow, setExpandedOverflow] = useState<Set<string>>(() => {
    // Alle overflow-noder starter udfoldet
    return new Set(graph.nodes.filter((n) => n.overflowItems).map((n) => n.id));
  });

  /** BIZZ-427: Toggle visibility of ceased/historical owners */
  const [showCeased, setShowCeased] = useState(false);

  /** BIZZ-451: Toggle visibility of property nodes — default ON */
  const propertyCount = useMemo(
    () => graph.nodes.filter((n) => n.type === 'property').length,
    [graph.nodes]
  );
  const [showProperties, setShowProperties] = useState(true);

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
  const filteredGraph = useMemo(() => {
    const visibleNodes = graph.nodes.filter((n) => {
      // BIZZ-427: Hide ceased/historical owners unless toggle is on
      if (!showCeased && n.isCeased) return false;
      // BIZZ-451: Hide property nodes unless toggle is on
      if (!showProperties && n.type === 'property') return false;
      // Always show non-co-owner nodes
      if (!n.isCoOwner) return true;
      // Show co-owner only if its parent is expanded
      return n.collapseParent ? expandedNodes.has(n.collapseParent) : true;
    });
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = graph.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));
    return { nodes: visibleNodes, edges: visibleEdges };
  }, [graph, expandedNodes, showCeased, showProperties]);

  // ── Compute topological depth (owners above, subsidiaries below) ──
  // Co-owners are placed between the subsidiary's parent and the subsidiary
  // itself (depth - 0.5), so they visually sit in between.
  const depthMap = useMemo(() => {
    const depths = new Map<string, number>();
    depths.set(graph.mainId, 0);

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
      if (!parentEdges.has(edge.to)) parentEdges.set(edge.to, []);
      parentEdges.get(edge.to)!.push(edge.from);
      if (!childEdges.has(edge.from)) childEdges.set(edge.from, []);
      childEdges.get(edge.from)!.push(edge.to);
    }

    // BFS upward (skip co-owners — they get special depth later)
    // BIZZ-426: Use shallowest (closest to root) depth when a node is reachable via multiple paths
    const upQueue = [graph.mainId];
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
    // BFS downward (skip co-owners). Properties are NOT assigned integer depth —
    // they'll be placed in Pass 3 of nodeYMap directly below their specific owner.
    const nodeById = new Map(filteredGraph.nodes.map((n) => [n.id, n]));
    const downQueue = [graph.mainId];
    while (downQueue.length > 0) {
      const current = downQueue.shift()!;
      const d = depths.get(current) ?? 0;
      for (const c of childEdges.get(current) ?? []) {
        if (!depths.has(c) && !coOwnerIds.has(c)) {
          const childNode = nodeById.get(c);
          const isPropertyLike = childNode?.type === 'property' || c.startsWith('props-overflow-');
          if (isPropertyLike) {
            // Properties get their owner's depth — they'll be positioned below
            // the specific owner's sub-row in nodeYMap Pass 3
            depths.set(c, d);
          } else {
            depths.set(c, d + 1);
            downQueue.push(c);
          }
        }
      }
    }

    // Assign co-owners:
    //   - PERSON co-owners go to the very top of the diagram (below min depth)
    //     to avoid overlap with company rows when expanded (user request)
    //   - COMPANY co-owners stay at targetDepth - 0.5 (one half-level above subsidiary)
    // Find the minimum depth among non-co-owner nodes (the topmost company/main)
    let minDepth = 0;
    for (const [id, d] of depths) {
      if (!coOwnerIds.has(id) && d < minDepth) minDepth = d;
    }
    for (const [coId, targetId] of coOwnerTarget) {
      const coNode = nodeById.get(coId);
      if (coNode?.type === 'person') {
        // All person co-owners pinned to the very top
        depths.set(coId, minDepth - 1);
      } else {
        const targetDepth = depths.get(targetId) ?? 1;
        depths.set(coId, targetDepth - 0.5);
      }
    }

    return depths;
  }, [filteredGraph, graph.mainId]);

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

    // Group only NON-co-owner, NON-property nodes by depth for standard sub-row layout.
    // Properties are placed in Pass 3 directly below their specific owner.
    const nodeById = new Map(filteredGraph.nodes.map((n) => [n.id, n]));
    const isPropertyId = (id: string) => {
      const n = nodeById.get(id);
      return n?.type === 'property' || id.startsWith('props-overflow-');
    };
    // Map from owner node id → list of property node ids
    const propertiesByOwner = new Map<string, string[]>();
    for (const edge of filteredGraph.edges) {
      if (isPropertyId(edge.to)) {
        if (!propertiesByOwner.has(edge.from)) propertiesByOwner.set(edge.from, []);
        propertiesByOwner.get(edge.from)!.push(edge.to);
      }
    }
    const byDepth = new Map<number, string[]>();
    for (const node of filteredGraph.nodes) {
      if (coOwnerIds.has(node.id)) continue;
      if (isPropertyId(node.id)) continue; // placed in Pass 3
      const d = depthMap.get(node.id) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(node.id);
    }
    // Re-order each depth group: persons first, then companies.
    // (Properties are handled in Pass 3 — not in byDepth anymore.)
    for (const [depth, ids] of byDepth) {
      const persons = ids.filter((id) => nodeById.get(id)?.type === 'person');
      const companies = ids.filter((id) => nodeById.get(id)?.type !== 'person');

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
        let subRowHasProperties = false;
        for (let i = startIdx; i < endIdx; i++) {
          if (nodeIds[i] !== '__pad__' && targetsWithCoOwners.has(nodeIds[i])) {
            subRowHasCoOwners = true;
          }
          if (nodeIds[i] !== '__pad__' && propertiesByOwner.has(nodeIds[i])) {
            subRowHasProperties = true;
          }
        }
        if (sr > 0 || depth !== sortedDepths[0]) {
          levelHeight += subRowGap;
        }
        if (subRowHasCoOwners) {
          levelHeight += CO_ROW_GAP;
        }
        // Reserve space for properties below this sub-row if any company here owns properties
        if (subRowHasProperties) {
          // Find max property count per owner in this sub-row to size the reservation
          let maxPropsInSubrow = 0;
          for (let i = startIdx; i < endIdx; i++) {
            if (nodeIds[i] === '__pad__') continue;
            const props = propertiesByOwner.get(nodeIds[i]);
            if (props) {
              const propSubrows = Math.ceil(props.length / MAX_PER_ROW);
              maxPropsInSubrow = Math.max(maxPropsInSubrow, propSubrows);
            }
          }
          // 95 initial gap + 70 per additional sub-row
          levelHeight += 95 + Math.max(0, maxPropsInSubrow - 1) * 70;
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
            // Extra gap if PREVIOUS sub-row had owners with properties
            const prevStart = prevSubRow * MAX_PER_ROW;
            const prevEnd = Math.min(prevStart + MAX_PER_ROW, nodeIds.length);
            let prevMaxProps = 0;
            for (let j = prevStart; j < prevEnd; j++) {
              if (nodeIds[j] === '__pad__') continue;
              const props = propertiesByOwner.get(nodeIds[j]);
              if (props) {
                const pr = Math.ceil(props.length / MAX_PER_ROW);
                prevMaxProps = Math.max(prevMaxProps, pr);
              }
            }
            if (prevMaxProps > 0) {
              runningY += 95 + Math.max(0, prevMaxProps - 1) * 70;
            }
          }
          // Check if this sub-row needs extra space for co-owners above it
          const startIdx = subRow * MAX_PER_ROW;
          const endIdx = Math.min(startIdx + MAX_PER_ROW, nodeIds.length);
          let subRowHasCoOwners = false;
          for (let j = startIdx; j < endIdx; j++) {
            if (nodeIds[j] !== '__pad__' && targetsWithCoOwners.has(nodeIds[j])) {
              subRowHasCoOwners = true;
              break;
            }
          }
          if (subRowHasCoOwners) {
            runningY += CO_ROW_GAP;
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
    // All person co-owners collected globally, placed on a shared row at the top
    const allPersonCoOwners: string[] = [];
    for (const [, coIds] of coByTarget) {
      const targetY =
        yMap.get([...coByTarget.keys()].find((k) => coByTarget.get(k) === coIds) ?? '') ?? 0;
      void targetY; // unused here — handled below per target
      const companies = coIds.filter((id) => nodeById.get(id)?.type === 'company');
      const persons = coIds.filter((id) => nodeById.get(id)?.type === 'person');
      allPersonCoOwners.push(...persons);
      // Place company co-owners relative to their target
      if (companies.length > 0) {
        const actualTargetId = [...coByTarget.entries()].find(([, v]) => v === coIds)?.[0];
        void actualTargetId; // not directly needed — we iterate below
      }
    }
    // Actually iterate properly (simpler): re-loop for companies
    for (const [targetId, coIds] of coByTarget) {
      const targetY = yMap.get(targetId) ?? 0;
      const targetDepth = depthMap.get(targetId) ?? 0;
      const coRowGap = getSubRowGap(targetDepth);
      const companies = coIds.filter((id) => nodeById.get(id)?.type === 'company');
      const companyBaseY = targetY - CO_ROW_GAP;
      for (let i = 0; i < companies.length; i++) {
        const subRow = Math.floor(i / MAX_PER_ROW);
        yMap.set(companies[i], companyBaseY + subRow * coRowGap);
      }
    }
    // Place ALL person co-owners at the very top (one shared Y row, or stacked if many)
    if (allPersonCoOwners.length > 0) {
      const personRowGap = 80;
      const personBaseY = globalMinY - CO_ROW_GAP;
      // Deduplicate while preserving order
      const uniquePersons = [...new Set(allPersonCoOwners)];
      for (let i = 0; i < uniquePersons.length; i++) {
        const subRow = Math.floor(i / MAX_PER_ROW);
        yMap.set(uniquePersons[i], personBaseY - subRow * personRowGap);
      }
    }

    // Pass 3: Place properties directly below their specific owner.
    // Each owner's properties form their own sub-row at ownerY + PROPERTY_ROW_GAP.
    const PROPERTY_ROW_GAP = 95;
    const PROPERTY_SUBROW_GAP = 70;
    for (const [ownerId, propIds] of propertiesByOwner) {
      const ownerY = yMap.get(ownerId);
      if (ownerY == null) continue;
      const propBaseY = ownerY + PROPERTY_ROW_GAP;
      for (let i = 0; i < propIds.length; i++) {
        const subRow = Math.floor(i / MAX_PER_ROW);
        yMap.set(propIds[i], propBaseY + subRow * PROPERTY_SUBROW_GAP);
      }
    }

    // Pass 4: Enforce max MAX_PER_ROW properties per Y line, iteratively.
    // Properties from multiple owners in the same sub-row share the same Y,
    // potentially exceeding 5. Repeatedly wrap extras to the next sub-row until
    // no Y row has > MAX_PER_ROW properties.
    const allPropIds = [...propertiesByOwner.values()].flat();
    for (let iter = 0; iter < 10; iter++) {
      const propsByY = new Map<number, string[]>();
      for (const propId of allPropIds) {
        const y = yMap.get(propId);
        if (y == null) continue;
        if (!propsByY.has(y)) propsByY.set(y, []);
        propsByY.get(y)!.push(propId);
      }
      let anyWrapped = false;
      for (const [y, propsAtY] of propsByY) {
        if (propsAtY.length <= MAX_PER_ROW) continue;
        // Wrap extras to next sub-row (y + PROPERTY_SUBROW_GAP)
        for (let i = MAX_PER_ROW; i < propsAtY.length; i++) {
          yMap.set(propsAtY[i], y + PROPERTY_SUBROW_GAP);
        }
        anyWrapped = true;
      }
      if (!anyWrapped) break;
    }

    return yMap;
  }, [filteredGraph, depthMap, getSubRowGap, getLevelGap]);

  // ── Run force simulation (hybrid: strict Y from nodeYMap, organic X from physics) ──
  useEffect(() => {
    if (filteredGraph.nodes.length === 0) return;

    // Group by Y position (from nodeYMap) for initial X spread — ensures
    // persons and companies on separate sub-rows get independent X layouts
    const byY = new Map<number, DiagramNode[]>();
    for (const n of filteredGraph.nodes) {
      const y = nodeYMap.get(n.id) ?? 0;
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y)!.push(n);
    }

    // Build owner lookup: property node id → owner company node id (from edges)
    const ownerOfProperty = new Map<string, string>();
    for (const edge of filteredGraph.edges) {
      const toNode = filteredGraph.nodes.find((n) => n.id === edge.to);
      if (toNode?.type === 'property' || edge.to.startsWith('props-overflow-')) {
        if (!ownerOfProperty.has(edge.to)) ownerOfProperty.set(edge.to, edge.from);
      }
    }

    // Assign initial X positions: process Y rows top-to-bottom so property rows
    // can reuse their owner's X position (computed in earlier iteration).
    const initialX = new Map<string, number>();
    const sortedYs = [...byY.keys()].sort((a, b) => a - b);
    for (const y of sortedYs) {
      const nodes = byY.get(y)!;
      // Split into property nodes (positioned under owner) vs others (spread evenly)
      const propNodes = nodes.filter(
        (n) => n.type === 'property' || n.id.startsWith('props-overflow-')
      );
      const otherNodes = nodes.filter(
        (n) => n.type !== 'property' && !n.id.startsWith('props-overflow-')
      );
      // Spread non-property nodes evenly
      const otherCount = otherNodes.length;
      for (let i = 0; i < otherNodes.length; i++) {
        initialX.set(otherNodes[i].id, (i - (otherCount - 1) / 2) * NODE_GAP_X);
      }
      // Group property nodes by their owner to cluster siblings together
      const propsByOwner = new Map<string, DiagramNode[]>();
      for (const p of propNodes) {
        const owner = ownerOfProperty.get(p.id) ?? '__unknown__';
        if (!propsByOwner.has(owner)) propsByOwner.set(owner, []);
        propsByOwner.get(owner)!.push(p);
      }
      // Place each group centered on its owner's X
      for (const [ownerId, props] of propsByOwner) {
        const ownerX = initialX.get(ownerId) ?? 0;
        const n = props.length;
        // Use tighter spacing for properties so they cluster under owner
        const propSpacing = NODE_W + 20;
        for (let i = 0; i < n; i++) {
          initialX.set(props[i].id, ownerX + (i - (n - 1) / 2) * propSpacing);
        }
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

      // Same-level X repulsion: only push apart nodes that share the same Y level.
      // Property nodes use tighter minDist so they cluster under their owner.
      const MIN_DIST_COMPANY = NODE_W + 36;
      const MIN_DIST_PROPERTY = NODE_W + 16;
      for (const [, siblings] of nodesByY) {
        for (let i = 0; i < siblings.length; i++) {
          for (let j = i + 1; j < siblings.length; j++) {
            const a = siblings[i];
            const b = siblings[j];
            const bothProperty = a.data.type === 'property' && b.data.type === 'property';
            const minDist = bothProperty ? MIN_DIST_PROPERTY : MIN_DIST_COMPANY;
            const dx = (b.x ?? 0) - (a.x ?? 0);
            const absDx = Math.abs(dx);
            if (absDx < minDist) {
              const push = (minDist - absDx) * (bothProperty ? 0.2 : 0.5);
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
        const srcNode = graph.nodes.find((n) => n.id === srcId);
        const tgtNode = graph.nodes.find((n) => n.id === tgtId);
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
          .strength(0.5)
      )
      // No global charge — only same-level repulsion in forceHierarchy
      .force('centerX', forceCenter(0, 0).strength(0.05))
      .force('hierarchy', () => forceHierarchy())
      .alpha(1)
      .alphaDecay(0.03);

    // BIZZ-401: Run simulation in async chunks to avoid blocking the main thread.
    // Previously 120 synchronous ticks blocked navigation for large diagrams.
    // Now runs 30 ticks per frame via setTimeout, yielding to the event loop between batches.
    let cancelled = false;
    const TICKS_PER_BATCH = 30;
    const TOTAL_TICKS = 120;
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
      minX = Math.min(minX, pos.x - NODE_W / 2);
      minY = Math.min(minY, pos.y - nh / 2);
      maxX = Math.max(maxX, pos.x + NODE_W / 2);
      maxY = Math.max(maxY, pos.y + nh / 2);
    }
    const pad = 60;
    return {
      minX: minX - pad,
      minY: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
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

      const fit = Math.min((cW - 40) / viewBox.w, (cH - 40) / viewBox.h, 1.5);
      const z = Math.max(fit, 0.15);
      const scaledW = viewBox.w * z + 32;
      const scaledH = viewBox.h * z + 32;
      const panX = Math.round((cW - scaledW) / 2);
      // Center small diagrams vertically; large ones align near top
      const centeredY = Math.round((cH - scaledH) / 2);
      const panY = scaledH > cH ? Math.min(8, centeredY) : centeredY;
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

  // ── Expand/collapse all helpers ──
  // Nodes that have expandable children (expandableChildren > 0)
  const allExpandableIds = useMemo(
    () => graph.nodes.filter((n) => (n.expandableChildren ?? 0) > 0).map((n) => n.id),
    [graph.nodes]
  );
  // Currently visible expandable nodes that are NOT yet expanded (can expand next)
  const canExpandMore = useMemo(() => {
    const visibleIds = new Set(filteredGraph.nodes.map((n) => n.id));
    return allExpandableIds.filter((id) => visibleIds.has(id) && !expandedNodes.has(id));
  }, [allExpandableIds, filteredGraph.nodes, expandedNodes]);
  // Whether anything is expanded at all
  const canCollapseAny = expandedNodes.size > 0;

  /**
   * Expand one level: expand all currently visible nodes that have co-owners but aren't expanded yet.
   */
  function expandOneLevel() {
    if (canExpandMore.length === 0) return;
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      for (const id of canExpandMore) next.add(id);
      return next;
    });
  }

  /**
   * Collapse all expanded nodes back to the initial state.
   */
  function collapseAll() {
    setExpandedNodes(new Set());
  }

  /** Toolbar with zoom controls + fullscreen toggle */
  const toolbar = (
    <div className="flex items-center justify-between sticky top-0 z-10 bg-[#0a1020]/95 backdrop-blur-sm py-2 -mt-2">
      <h2 className="text-white font-semibold text-base flex items-center gap-2">
        <Briefcase size={16} className="text-blue-400" />
        {graph.nodes.some((n) => n.type === 'property')
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
        {/* Expand / Collapse all co-owners */}
        <span className="w-px h-5 bg-slate-700/50 mx-1" />
        <button
          onClick={expandOneLevel}
          disabled={canExpandMore.length === 0}
          className={`h-7 px-2 flex items-center gap-1 bg-slate-800 border border-slate-700/50 rounded-lg text-[10px] transition ${
            canExpandMore.length === 0
              ? 'text-slate-600 cursor-not-allowed opacity-50'
              : 'text-slate-400 hover:text-white'
          }`}
          title={lang === 'da' ? 'Udvid næste niveau' : 'Expand next level'}
        >
          <ChevronsUpDown size={12} />
          {lang === 'da' ? 'Udvid' : 'Expand'}
        </button>
        <button
          onClick={collapseAll}
          disabled={!canCollapseAny}
          className={`h-7 px-2 flex items-center gap-1 bg-slate-800 border border-slate-700/50 rounded-lg text-[10px] transition ${
            !canCollapseAny
              ? 'text-slate-600 cursor-not-allowed opacity-50'
              : 'text-slate-400 hover:text-white'
          }`}
          title={lang === 'da' ? 'Skjul alle' : 'Collapse all'}
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
        {/* BIZZ-427: Toggle ceased/historical owners */}
        {graph.nodes.some((n) => n.isCeased) && (
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
      </div>
    </div>
  );

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

        // Property edges rendered with emerald color to match property nodes
        const isPropertyEdge = toNode?.type === 'property' || edge.to.startsWith('props-overflow-');
        const strokeColor = isCoOwnerEdge
          ? 'rgba(167,139,250,0.55)'
          : isPropertyEdge
            ? 'rgba(52,211,153,0.65)'
            : edge.from === graph.mainId || edge.to === graph.mainId
              ? 'rgba(96,165,250,0.85)'
              : 'rgba(148,163,184,0.75)';

        return (
          <g key={`e-${i}`}>
            <path
              d={`M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`}
              fill="none"
              stroke={strokeColor}
              strokeWidth={isCoOwnerEdge ? 1.5 : 2.25}
              strokeDasharray={isCoOwnerEdge ? '4 3' : undefined}
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
        const x = pos.x - NODE_W / 2;
        // Overflow-noder: forankr fra toppen (brug kollapseret højde) så de udvider nedad
        const collapsedH = node.overflowItems
          ? 30 +
            Math.min(node.overflowItems.length, OVERFLOW_INITIAL_SHOW) * 16 +
            (node.overflowItems.length > OVERFLOW_INITIAL_SHOW ? 20 : 0)
          : h;
        const y = pos.y - collapsedH / 2;

        // ── Overflow list node (expandable list of companies) ──
        if (node.overflowItems) {
          const isOvExpanded = expandedOverflow.has(node.id);
          const items = isOvExpanded
            ? node.overflowItems
            : node.overflowItems.slice(0, OVERFLOW_INITIAL_SHOW);

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
                width={NODE_W}
                height={h}
                rx={12}
                fill="rgba(30,41,59,0.6)"
                stroke="rgba(71,85,105,0.4)"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
              <text
                x={x + 14}
                y={y + 18}
                fill="rgba(165,180,200,0.9)"
                fontSize="10"
                fontWeight="500"
                className="pointer-events-none"
              >
                {node.label}
              </text>
              {items.map((item, idx) => (
                <text
                  key={idx}
                  x={x + 18}
                  y={y + 34 + idx * 16}
                  fill="rgba(96,165,250,0.8)"
                  fontSize="9"
                  className="cursor-pointer"
                  style={{ cursor: 'pointer', pointerEvents: 'auto' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (item.link) window.location.href = item.link;
                  }}
                >
                  {'•'} {item.label.length > 42 ? item.label.slice(0, 42) + '…' : item.label}
                </text>
              ))}
              {node.overflowItems.length > OVERFLOW_INITIAL_SHOW && (
                <g
                  className="cursor-pointer"
                  style={{ pointerEvents: 'auto' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedOverflow((prev) => {
                      const next = new Set(prev);
                      if (next.has(node.id)) next.delete(node.id);
                      else next.add(node.id);
                      return next;
                    });
                  }}
                >
                  <rect
                    x={x + NODE_W / 2 - 40}
                    y={y + h - 18}
                    width={80}
                    height={15}
                    rx={8}
                    fill="rgba(51,65,85,0.6)"
                    stroke="rgba(71,85,105,0.5)"
                    strokeWidth="0.5"
                  />
                  <text
                    x={x + NODE_W / 2}
                    y={y + h - 8}
                    textAnchor="middle"
                    fill="rgba(148,163,184,0.8)"
                    fontSize="8"
                    fontWeight="500"
                  >
                    {isOvExpanded ? `▾ Skjul` : `▸ Vis alle ${node.overflowItems.length}`}
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
              width={NODE_W}
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
                      {/* Key persons inside company box */}
                      {node.noeglePersoner &&
                        node.noeglePersoner.slice(0, 5).map((p, pi) => (
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
                              {p.navn.length > 36 ? p.navn.slice(0, 36) + '…' : p.navn}
                            </text>
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
                          </g>
                        ))}
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
                </>
              );
            })()}
            {hasExpandable && (
              <g
                className="cursor-pointer"
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
      className={`bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden select-none ${isFullscreen ? 'flex-1' : ''}`}
      style={{
        minHeight: isFullscreen ? undefined : '500px',
        maxHeight: isFullscreen ? undefined : '85vh',
        cursor: 'grab',
      }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      <div
        style={{
          transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
          transformOrigin: 'top left',
          padding: 16,
        }}
      >
        <svg
          ref={svgRef}
          width={viewBox.w}
          height={viewBox.h}
          viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.w} ${viewBox.h}`}
          style={{ overflow: 'visible' }}
          onMouseDown={handleSvgMouseDown}
        >
          {svgContent}
        </svg>
      </div>
    </div>
  );

  /** Warning badge when nodes are hidden due to overflow grouping */
  const hiddenWarning = graph.hiddenCount ? (
    <div className="absolute top-3 right-3 z-10 max-w-[200px] px-2.5 py-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[10px] font-medium leading-tight backdrop-blur-sm">
      <span className="font-bold">{graph.hiddenCount}</span>{' '}
      {lang === 'da'
        ? `virksomheder relateret til "flere virksomheder" er ikke vist`
        : `companies related to "more companies" are not shown`}
    </div>
  ) : null;

  // ── Fullscreen overlay (BIZZ-248: topbar with close button) ──
  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-950/95 flex flex-col">
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
      </div>
    );
  }

  // ── Normal inline mode ──
  return (
    <div className="space-y-1">
      {toolbar}
      <div className="relative">
        {canvasEl}
        {hiddenWarning}
      </div>
    </div>
  );
}
