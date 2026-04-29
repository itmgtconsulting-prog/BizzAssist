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
import { Loader2, AlertTriangle } from 'lucide-react';
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
  rootLabel: _rootLabel,
  lang,
}: DiagramV2Props) {
  const da = lang === 'da';
  const [graph, setGraph] = useState<DiagramGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Ref der holder styr på alle node-IDs og BFE-numre i grafen
   * (inkl. extension-noder). Bruges til dedup i expand-kald.
   */
  const allNodeIdsRef = useRef<Set<string>>(new Set());
  const allBfesRef = useRef<Set<number>>(new Set());

  /** Opdater refs når graf ændrer sig */
  useEffect(() => {
    if (!graph) return;
    const ids = new Set(graph.nodes.map((n) => n.id));
    const bfes = new Set(graph.nodes.filter((n) => n.bfeNummer != null).map((n) => n.bfeNummer!));
    allNodeIdsRef.current = ids;
    allBfesRef.current = bfes;
  }, [graph]);

  /** Hent initial graf fra /api/diagram/resolve */
  useEffect(() => {
    setLoading(true);
    setError(null);
    setGraph(null);

    const controller = new AbortController();
    fetch(`/api/diagram/resolve?type=${rootType}&id=${encodeURIComponent(rootId)}`, {
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
  }, [rootType, rootId, da]);

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
      // Find node i grafen for at hente cvr/enhedsNummer
      const node = graph?.nodes.find((n) => n.id === nodeId);
      if (!node) return null;

      const body = {
        nodeType,
        nodeId,
        cvr: node.cvr ? String(node.cvr) : undefined,
        enhedsNummer: node.enhedsNummer ? String(node.enhedsNummer) : undefined,
        existingNodeIds: [...allNodeIdsRef.current],
        existingBfes: [...allBfesRef.current],
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
          allNodeIdsRef.current.add(n.id);
          if (n.bfeNummer != null) allBfesRef.current.add(n.bfeNummer);
        }

        return data.nodes.length > 0 || data.edges.length > 0 ? data : null;
      } catch {
        return null;
      }
    },
    [graph]
  );

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 size={16} className="animate-spin text-blue-400" />
        <span className="text-slate-400 text-sm">
          {da ? 'Bygger diagram…' : 'Building diagram…'}
        </span>
      </div>
    );
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
    />
  );
}
