/**
 * DiagramV2 — Unified relationsdiagram (v2) for virksomheder, personer og ejendomme.
 *
 * Feature-flagged bag NEXT_PUBLIC_DIAGRAM2_ENABLED. Erstatter på sigt de tre
 * separate diagram-flows (buildDiagramGraph, buildPersonDiagramGraph,
 * PropertyOwnerDiagram) med en cache-first, expand-baseret tilgang.
 *
 * Data-flow:
 *   1. Fetch initial graf fra /api/diagram/resolve (cache-first)
 *   2. Renderer via DiagramForce (genbrugt — D3 force-layout)
 *   3. Expand via /api/diagram/expand (cache-first med 2nd-degree edges)
 *
 * @param rootType  - Entitetstype: company, person eller property
 * @param rootId    - CVR-nummer, enhedsNummer eller BFE-nummer
 * @param rootLabel - Visningsnavn til root-noden
 * @param lang      - Sprog (da/en)
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import dynamic from 'next/dynamic';
import type { DiagramGraph, DiagramNode, DiagramEdge } from './DiagramData';

/** DiagramForce — dynamic import for at holde d3-force ude af initial bundle */
const DiagramForce = dynamic(() => import('./DiagramForce'), {
  ssr: false,
  loading: () => <div className="w-full h-96 bg-slate-800/50 rounded-xl animate-pulse" />,
});

export interface DiagramV2Props {
  /** Entitetstype for root-noden */
  rootType: 'company' | 'person' | 'property';
  /** CVR, enhedsNummer eller BFE som string */
  rootId: string;
  /** Visningsnavn til root-noden */
  rootLabel: string;
  /** Sprog */
  lang: 'da' | 'en';
  /** BIZZ-1115: Optional node-click override (fx tab-skift på personsiden) */
  onNodeClick?: (node: DiagramNode) => void;
  /** BIZZ-1115: Callback med base64 PNG når diagram er renderet (til AI-export) */
  onDiagramReady?: (base64Png: string) => void;
  /** BIZZ-1143: Pre-fetched resolve data fra parent — bruger data direkte og skipper intern fetch */
  prefetchedGraph?: { graph: unknown } | null;
}

/**
 * DiagramV2 — cache-first relationsdiagram med smart expand.
 *
 * Orchestrator-komponent der henter data via /api/diagram/* og renderer
 * via den eksisterende DiagramForce-komponent.
 *
 * @param props - Se DiagramV2Props
 * @returns Diagram UI med loading/error states
 */
export default function DiagramV2({
  rootType,
  rootId,
  rootLabel,
  lang,
  onNodeClick,
  onDiagramReady,
  prefetchedGraph = null,
}: DiagramV2Props) {
  const da = lang === 'da';
  const [graph, setGraph] = useState<DiagramGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Ref der holder styr på alle noder i grafen (inkl. extension-noder).
   * Bruges til at finde cvr/enhedsNummer ved expand og til dedup.
   */
  const allNodesRef = useRef<Map<string, DiagramNode>>(new Map());
  const allBfesRef = useRef<Set<number>>(new Set());

  /** Opdater refs når initial graf ændrer sig */
  useEffect(() => {
    if (!graph) return;
    const map = new Map<string, DiagramNode>();
    for (const n of graph.nodes) map.set(n.id, n);
    allNodesRef.current = map;
    allBfesRef.current = new Set(
      graph.nodes.filter((n) => n.bfeNummer != null).map((n) => n.bfeNummer!)
    );
  }, [graph]);

  /** Hent initial graf fra /api/diagram/resolve (eller brug prefetched data fra parent) */
  useEffect(() => {
    setError(null);
    setGraph(null);

    // BIZZ-1143: Brug prefetched graf fra parent — skip intern fetch
    if (prefetchedGraph) {
      const g = prefetchedGraph.graph as DiagramGraph | null;
      if (g) {
        setGraph(g);
      } else {
        setError(da ? 'Ingen data fundet' : 'No data found');
      }
      setLoading(false);
      return;
    }

    // Fallback: ingen prefetched data → fetch selv (virksomheds-/personsider)
    setLoading(true);
    const controller = new AbortController();
    // BIZZ-1114: Send rootLabel som query param — bruges for property root-node adresse
    const resolveParams = new URLSearchParams({ type: rootType, id: rootId });
    if (rootLabel) resolveParams.set('label', rootLabel);
    fetch(`/api/diagram/resolve?${resolveParams}`, {
      signal: controller.signal,
    })
      .then((r) =>
        r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.error ?? 'Fejl')))
      )
      .then((data: { graph: DiagramGraph | null }) => {
        if (data.graph) {
          setGraph(data.graph);
        } else {
          setError(da ? 'Ingen data fundet' : 'No data found');
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(da ? 'Kunne ikke hente diagramdata' : 'Failed to load diagram data');
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [rootType, rootId, da, prefetchedGraph]);

  /**
   * Expand-handler — kaldet af DiagramForce via onExpand prop.
   * Sender expand-request til /api/diagram/expand med eksisterende node-IDs
   * for dedup og 2nd-degree edge detection.
   *
   * @param nodeId - ID på den node der udvides
   * @param nodeType - 'person' eller 'company'
   * @returns Nye noder + edges, eller null ved fejl
   */
  const handleExpand = useCallback(
    async (
      nodeId: string,
      nodeType: 'person' | 'company'
    ): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] } | null> => {
      // BIZZ-1102: Find node i ALLE kendte noder (inkl. extensions) — ikke kun initial graph.
      // BIZZ-1125: Nøgleperson-expand opretter node i DiagramForce extensionNodes
      // SAMTIDIG med expand-kaldet — node er muligvis ikke i allNodesRef endnu.
      // Fallback: parse nodeId (en-XXXXX → enhedsNummer, cvr-XXXXX → cvr).
      const node = allNodesRef.current.get(nodeId);
      let cvr: string | undefined = node?.cvr ? String(node.cvr) : undefined;
      let enhedsNummer: string | undefined = node?.enhedsNummer
        ? String(node.enhedsNummer)
        : undefined;
      if (!node) {
        if (nodeType === 'person' && nodeId.startsWith('en-')) {
          enhedsNummer = nodeId.replace('en-', '');
        } else if (nodeType === 'company' && nodeId.startsWith('cvr-')) {
          cvr = nodeId.replace('cvr-', '');
        } else {
          return null;
        }
      }

      const body = {
        nodeType,
        nodeId,
        cvr,
        enhedsNummer,
        existingNodeIds: [...allNodesRef.current.keys()],
        existingBfes: [...allBfesRef.current],
        // BIZZ-1122: context fortæller expand-route om den skal filtrere
        // person-expand til ejerskabs-virksomheder (company-diagram context)
        context: rootType,
      };

      try {
        const res = await fetch('/api/diagram/expand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) return null;
        const data: { nodes: DiagramNode[]; edges: DiagramEdge[] } = await res.json();

        // Opdater tracking-refs med nye noder
        for (const n of data.nodes) {
          allNodesRef.current.set(n.id, n);
          if (n.bfeNummer != null) allBfesRef.current.add(n.bfeNummer);
        }

        // Returner altid data (selv tom) så DiagramForce markerer noden som
        // expanded og skjuler Udvid-knappen — ellers forbliver knappen synlig
        // for virksomheder uden ejendomme (fx Radyx Pharma Tech).
        return data;
      } catch {
        return null;
      }
    },
    [rootType]
  );

  /**
   * Collapse callback — ryd allNodesRef/allBfesRef for fjernede noder
   * så næste expand-kald ikke sender dem som "eksisterende".
   */
  const handleCollapse = useCallback((removedNodeIds: string[]) => {
    for (const id of removedNodeIds) {
      const node = allNodesRef.current.get(id);
      if (node?.bfeNummer != null) allBfesRef.current.delete(node.bfeNummer);
      allNodesRef.current.delete(id);
    }
  }, []);

  // Loading state — tom div, parent-sidens loading.tsx viser allerede spinner
  if (loading) {
    return <div className="w-full h-96" />;
  }

  // Error state
  if (error) {
    return (
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 text-center">
        <AlertTriangle size={20} className="text-amber-400 mx-auto mb-2" />
        <p className="text-slate-400 text-sm">{error}</p>
      </div>
    );
  }

  // No data
  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 text-center">
        <p className="text-slate-500 text-sm">
          {da ? 'Ingen relationer fundet' : 'No relationships found'}
        </p>
      </div>
    );
  }

  return (
    <DiagramForce
      graph={graph}
      lang={lang}
      defaultShowProperties={rootType !== 'person'}
      onExpand={handleExpand}
      onCollapse={handleCollapse}
      onNodeClick={onNodeClick}
      onDiagramReady={onDiagramReady}
    />
  );
}
