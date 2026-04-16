'use client';
'use no memo';

/**
 * DiagramSimple — Clean vertikalt ejerskabsdiagram.
 * Ingen D3 force simulation — ren layout-beregning i useMemo.
 * Klikbare noder via <a> tags (ingen router.push / onClick-issues).
 * BIZZ-348: Noder wrappes til næste linje efter max MAX_PER_ROW per række.
 * BIZZ-323: Fuldskærm har topbar med titel og luk-knap.
 *
 * @module DiagramSimple
 */

import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Building2, Maximize2, Minimize2, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import type { DiagramVariantProps, DiagramNode, DiagramEdge } from './DiagramData';

// ─── Constants ──────────────────────────────────────────────────────────────

const NODE_W = 260;
const NODE_H = 56;
const NODE_H_PERSON = 32;
const GAP_X = 24;
const GAP_Y = 80;
/** BIZZ-348: Gap between sub-rows within the same depth level */
const SUB_ROW_GAP_Y = 16;
const PADDING = 32;
/** BIZZ-348: Maximum nodes rendered per horizontal row before wrapping */
const MAX_PER_ROW = 5;

// ─── Layout computation ─────────────────────────────────────────────────────

interface LayoutNode {
  node: DiagramNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayoutEdge {
  from: LayoutNode;
  to: LayoutNode;
  ejerandel?: string | null;
}

/**
 * Beregn layout for alle noder — simpelt hierarki baseret på edges.
 * Topologisk sortering: noder uden indgående edges er i top.
 * BIZZ-348: Noder på samme niveau wrappes til sub-rækker efter MAX_PER_ROW.
 *
 * @param nodes - Diagram nodes to lay out
 * @param edges - Diagram edges defining hierarchy
 * @returns Computed layout with positioned nodes, edges, and total dimensions
 */
function computeLayout(
  nodes: DiagramNode[],
  edges: DiagramEdge[]
): { layoutNodes: LayoutNode[]; layoutEdges: LayoutEdge[]; totalW: number; totalH: number } {
  if (nodes.length === 0) return { layoutNodes: [], layoutEdges: [], totalW: 0, totalH: 0 };

  // Byg adjacency
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const edgeMap = new Map<string, DiagramEdge>();
  for (const e of edges) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from)!.push(e.to);
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to)!.push(e.from);
    edgeMap.set(`${e.from}->${e.to}`, e);
  }

  // Find roots (ingen forældre)
  const roots = nodes.filter((n) => !parents.has(n.id) || parents.get(n.id)!.length === 0);

  // BFS for at tildele niveauer
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    level.set(r.id, 0);
    queue.push(r.id);
  }
  // Noder uden edges → level 0
  for (const n of nodes) {
    if (!level.has(n.id)) {
      level.set(n.id, 0);
      queue.push(n.id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const lvl = level.get(id)!;
    for (const childId of children.get(id) ?? []) {
      const existing = level.get(childId);
      if (existing === undefined || existing < lvl + 1) {
        level.set(childId, lvl + 1);
        queue.push(childId);
      }
    }
  }

  // Grupper noder per niveau
  const levels = new Map<number, DiagramNode[]>();
  let maxLevel = 0;
  for (const n of nodes) {
    const lvl = level.get(n.id) ?? 0;
    if (lvl > maxLevel) maxLevel = lvl;
    if (!levels.has(lvl)) levels.set(lvl, []);
    levels.get(lvl)!.push(n);
  }

  // Beregn positioner — BIZZ-348: wrap til næste sub-række efter MAX_PER_ROW noder
  const layoutMap = new Map<string, LayoutNode>();
  let totalW = 0;

  // Compute cumulative Y offsets across all levels and sub-rows
  const levelBaseY = new Map<number, number>();
  let cumulativeY = 0;
  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    levelBaseY.set(lvl, cumulativeY);
    const nodesAtLevel = levels.get(lvl) ?? [];
    // Determine how many sub-rows this level occupies
    const subRowCount = Math.ceil(nodesAtLevel.length / MAX_PER_ROW);
    // Each sub-row contributes its node height + GAP_Y; last sub-row just adds gap to next level
    const maxNodeH = nodesAtLevel.some((n) => n.type !== 'person') ? NODE_H : NODE_H_PERSON;
    // Total height: first sub-row included in GAP_Y spacing, extra sub-rows add SUB_ROW_GAP_Y
    cumulativeY += maxNodeH + GAP_Y + (subRowCount - 1) * (maxNodeH + SUB_ROW_GAP_Y);
  }

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const nodesAtLevel = levels.get(lvl) ?? [];
    const baseY = levelBaseY.get(lvl) ?? 0;
    const maxNodeH = nodesAtLevel.some((n) => n.type !== 'person') ? NODE_H : NODE_H_PERSON;

    // Split nodes into sub-rows of at most MAX_PER_ROW each
    for (let i = 0; i < nodesAtLevel.length; i++) {
      const n = nodesAtLevel[i];
      const h = n.type === 'person' ? NODE_H_PERSON : NODE_H;
      const subRow = Math.floor(i / MAX_PER_ROW);
      const posInRow = i % MAX_PER_ROW;

      // Nodes in this sub-row (may be fewer than MAX_PER_ROW for the last sub-row)
      const subRowStart = subRow * MAX_PER_ROW;
      const subRowCount = Math.min(MAX_PER_ROW, nodesAtLevel.length - subRowStart);
      const rowW = subRowCount * NODE_W + (subRowCount - 1) * GAP_X;
      if (rowW > totalW) totalW = rowW;

      // Center each sub-row horizontally
      const startX = -rowW / 2;
      const subRowY = baseY + subRow * (maxNodeH + SUB_ROW_GAP_Y);

      const ln: LayoutNode = {
        node: n,
        x: startX + posInRow * (NODE_W + GAP_X),
        y: subRowY,
        w: NODE_W,
        h,
      };
      layoutMap.set(n.id, ln);
    }
  }

  totalW += PADDING * 2;
  const totalH = cumulativeY - GAP_Y + PADDING * 2;

  // Byg layout edges
  const layoutEdges: LayoutEdge[] = [];
  for (const e of edges) {
    const from = layoutMap.get(e.from);
    const to = layoutMap.get(e.to);
    if (from && to) {
      layoutEdges.push({ from, to, ejerandel: e.ejerandel });
    }
  }

  return {
    layoutNodes: [...layoutMap.values()],
    layoutEdges,
    totalW,
    totalH,
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function DiagramSimple({ graph, lang }: DiagramVariantProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const panStart = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // Layout beregning — ren, ingen side-effects
  const { layoutNodes, layoutEdges, totalW, totalH } = useMemo(
    () => computeLayout(graph.nodes, graph.edges),
    [graph.nodes, graph.edges]
  );

  // Auto-fit zoom — beregnet, ikke i useEffect
  const autoFitZoom = useMemo(() => {
    if (totalW === 0 || totalH === 0) return 1;
    const fitW = 900 / totalW;
    const fitH = 600 / totalH;
    return Math.min(fitW, fitH, 1.2);
  }, [totalW, totalH]);

  // Sæt initial zoom én gang når layout er klar
  const initialFitDone = useRef(false);
  useEffect(() => {
    if (initialFitDone.current || autoFitZoom >= 1) return;
    initialFitDone.current = true;
    setZoom(autoFitZoom);
  }, [autoFitZoom]);

  // ── Pan handlers ──
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('a')) return;
      panStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      setIsPanning(true);
    },
    [pan]
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!panStart.current) return;
    setPan({
      x: panStart.current.px + (e.clientX - panStart.current.x),
      y: panStart.current.py + (e.clientY - panStart.current.y),
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    panStart.current = null;
    setIsPanning(false);
  }, []);

  // ── Zoom handlers ──
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(2, Math.max(0.2, z - e.deltaY * 0.001)));
  }, []);

  const reset = useCallback(() => {
    setZoom(autoFitZoom);
    setPan({ x: 0, y: 0 });
  }, [autoFitZoom]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((f) => !f);
    // Reset zoom+pan efter render så diagrammet passer til den nye containerstørrelse
    setTimeout(() => {
      setPan({ x: 0, y: 0 });
      if (containerRef.current && totalW > 0 && totalH > 0) {
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        const fitZoom = Math.min((w - 64) / totalW, (h - 64) / totalH, 1.5);
        setZoom(Math.max(0.2, fitZoom));
      }
    }, 50);
  }, [totalW, totalH]);

  // ── BIZZ-323: Escape key handler — exit fullscreen ──
  useEffect(() => {
    if (!isFullscreen) return;
    /**
     * Close fullscreen mode when Escape is pressed.
     * Only active while fullscreen is open to avoid global key conflicts.
     */
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isFullscreen]);

  const da = lang === 'da';

  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Building2 size={32} className="text-slate-600 mb-3" />
        <p className="text-slate-400 text-sm">
          {da ? 'Ingen relationer fundet' : 'No relations found'}
        </p>
      </div>
    );
  }

  // SVG offset: centrer diagrammet (x=0 er midten, så offset = halvt total bredde + padding)
  const offsetX = totalW / 2 + PADDING;
  const offsetY = PADDING;

  /** Zoom controls shared between inline and fullscreen toolbars */
  const zoomControls = (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => setZoom((z) => Math.min(2, z + 0.1))}
        className="p-1.5 rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
        title={da ? 'Zoom ind' : 'Zoom in'}
        aria-label={da ? 'Zoom ind' : 'Zoom in'}
      >
        <ZoomIn size={14} />
      </button>
      <span className="text-[10px] text-slate-500 tabular-nums w-8 text-center">
        {Math.round(zoom * 100)}%
      </span>
      <button
        onClick={() => setZoom((z) => Math.max(0.2, z - 0.1))}
        className="p-1.5 rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
        title={da ? 'Zoom ud' : 'Zoom out'}
        aria-label={da ? 'Zoom ud' : 'Zoom out'}
      >
        <ZoomOut size={14} />
      </button>
      <button
        onClick={reset}
        className="p-1.5 rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
        title={da ? 'Nulstil visning' : 'Reset view'}
        aria-label={da ? 'Nulstil visning' : 'Reset view'}
      >
        <RotateCcw size={14} />
      </button>
    </div>
  );

  /** The scrollable SVG canvas — shared between normal and fullscreen */
  const canvasEl = (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-2xl bg-slate-800/20 border border-slate-700/30"
      style={{
        height: isFullscreen ? 'calc(100vh - 56px)' : '70vh',
        cursor: isPanning ? 'grabbing' : 'grab',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      <svg
        width="100%"
        height="100%"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center top',
        }}
      >
        {/* Edges */}
        {layoutEdges.map((e, i) => {
          const x1 = offsetX + e.from.x + e.from.w / 2;
          const y1 = offsetY + e.from.y + e.from.h;
          const x2 = offsetX + e.to.x + e.to.w / 2;
          const y2 = offsetY + e.to.y;
          const midY = (y1 + y2) / 2;

          return (
            <g key={`e-${i}`}>
              <path
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="rgba(100,116,139,0.4)"
                strokeWidth="1.5"
              />
              {e.ejerandel && (
                <>
                  <rect
                    x={(x1 + x2) / 2 - 28}
                    y={midY - 8}
                    width="56"
                    height="16"
                    rx="4"
                    fill="rgba(16,185,129,0.1)"
                    stroke="rgba(16,185,129,0.25)"
                    strokeWidth="0.5"
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={midY + 3}
                    textAnchor="middle"
                    fill="rgba(52,211,153,0.85)"
                    fontSize="9"
                    fontWeight="500"
                  >
                    {e.ejerandel}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {layoutNodes.map((ln) => {
          const n = ln.node;
          const x = offsetX + ln.x;
          const y = offsetY + ln.y;
          const isMain = n.type === 'main';
          const isPerson = n.type === 'person';
          /** BIZZ-336: Property nodes get emerald/green palette — consistent with DiagramForce */
          const isProperty = n.type === 'property';
          // BIZZ-357: Detect ceased companies for greyed-out rendering
          const isCeased = n.isCeased === true;

          const fill = isMain
            ? 'rgba(37,99,235,0.15)'
            : isCeased
              ? 'rgba(30,30,35,0.55)'
              : isPerson
                ? 'rgba(139,92,246,0.1)'
                : isProperty
                  ? 'rgba(16,185,129,0.12)'
                  : 'rgba(30,41,59,0.8)';
          const stroke = isMain
            ? 'rgba(59,130,246,0.5)'
            : isCeased
              ? 'rgba(100,110,130,0.35)'
              : isPerson
                ? 'rgba(139,92,246,0.3)'
                : isProperty
                  ? 'rgba(52,211,153,0.45)'
                  : 'rgba(71,85,105,0.4)';
          const rx = isPerson ? 16 : 10;

          const content = (
            <g>
              <rect
                x={x}
                y={y}
                width={ln.w}
                height={ln.h}
                rx={rx}
                fill={fill}
                stroke={stroke}
                strokeWidth={isMain ? 2 : 1}
                // BIZZ-357: Dashed border for ceased companies
                strokeDasharray={isCeased ? '4 3' : undefined}
              />
              {/* BIZZ-357: "Ophørt" badge for ceased companies */}
              {isCeased && (
                <>
                  <rect
                    x={x + ln.w - 50}
                    y={y + 5}
                    width={44}
                    height={12}
                    rx={3}
                    fill="rgba(75,80,95,0.7)"
                    stroke="rgba(100,110,130,0.4)"
                    strokeWidth={0.75}
                  />
                  <text
                    x={x + ln.w - 28}
                    y={y + 14}
                    fill="rgba(180,185,195,0.85)"
                    fontSize="7"
                    fontWeight="500"
                    textAnchor="middle"
                  >
                    Ophørt
                  </text>
                </>
              )}
              {/* Icon */}
              {isPerson ? (
                <circle cx={x + 16} cy={y + ln.h / 2} r={6} fill="rgba(139,92,246,0.3)" />
              ) : isProperty ? (
                /* BIZZ-336: Small house icon approximated as a pentagon shape */
                <rect
                  x={x + 8}
                  y={y + ln.h / 2 - 6}
                  width={12}
                  height={12}
                  rx={2}
                  fill="rgba(52,211,153,0.25)"
                />
              ) : (
                <rect
                  x={x + 8}
                  y={y + ln.h / 2 - 6}
                  width={12}
                  height={12}
                  rx={2}
                  fill={isMain ? 'rgba(59,130,246,0.3)' : 'rgba(100,116,139,0.2)'}
                />
              )}
              {/* Label */}
              <text
                x={x + 28}
                y={y + (isPerson ? ln.h / 2 + 4 : 22)}
                fill={
                  isMain
                    ? '#fff'
                    : isCeased
                      ? 'rgba(160,165,175,0.75)'
                      : isPerson
                        ? '#c4b5fd'
                        : isProperty
                          ? 'rgba(110,231,183,0.95)'
                          : '#e2e8f0'
                }
                fontSize={isPerson ? 10 : 11}
                fontWeight={isMain ? 700 : 600}
              >
                {n.label.length > 32 ? n.label.slice(0, 30) + '…' : n.label}
              </text>
              {/* Sublabel */}
              {n.sublabel && !isPerson && (
                <text x={x + 28} y={y + 38} fill="rgba(148,163,184,0.7)" fontSize="9">
                  {n.sublabel.length > 40 ? n.sublabel.slice(0, 38) + '…' : n.sublabel}
                </text>
              )}
            </g>
          );

          // Wrap i <a> for klikbare noder
          if (n.link) {
            return (
              <a key={n.id} href={n.link} style={{ cursor: 'pointer' }}>
                {content}
              </a>
            );
          }
          return <g key={n.id}>{content}</g>;
        })}
      </svg>
    </div>
  );

  // ── BIZZ-323: Fullscreen overlay — topbar with title, zoom controls, close button ──
  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-950/95 flex flex-col">
        {/* Topbar: title + toolbar + close button */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/40 shrink-0">
          <h2 className="text-white text-sm font-medium flex items-center gap-2">
            <Building2 size={15} className="text-cyan-400" />
            {da ? 'Ejerskabsdiagram' : 'Ownership diagram'}
          </h2>
          <div className="flex items-center gap-3">
            {zoomControls}
            <span className="w-px h-5 bg-slate-700/50" />
            <button
              onClick={toggleFullscreen}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/40 rounded-lg transition-colors"
              aria-label={da ? 'Luk fuldskærm' : 'Close fullscreen'}
            >
              <Minimize2 size={12} />
              {da ? 'Luk' : 'Close'}
              <kbd className="ml-1 text-[10px] text-slate-600 bg-slate-800 px-1 rounded">ESC</kbd>
            </button>
          </div>
        </div>
        {/* Canvas fills remaining height */}
        {canvasEl}
      </div>
    );
  }

  // ── Normal inline mode ──
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-base flex items-center gap-2">
          <Building2 size={16} className="text-cyan-400" />
          {da ? 'Ejerskabsdiagram' : 'Ownership diagram'}
        </h2>
        <div className="flex items-center gap-1.5">
          {zoomControls}
          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
            title={da ? 'Fuldskærm' : 'Fullscreen'}
            aria-label={da ? 'Fuldskærm' : 'Fullscreen'}
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
      {canvasEl}
    </div>
  );
}
