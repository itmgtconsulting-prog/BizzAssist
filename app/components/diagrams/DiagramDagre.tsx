'use client';

/**
 * Dagre-based SVG diagram — uses directed acyclic graph layout.
 * Proper hierarchical layout with bezier edges connecting box edges.
 *
 * @param props - DiagramVariantProps
 */

import { useMemo, useRef, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import dagre from 'dagre';
import { Building2 } from 'lucide-react';
import type { DiagramVariantProps } from './DiagramData';

/** Node dimensions */
const NODE_W = 220;
const NODE_H_COMPANY = 52;
const NODE_H_PERSON = 36;

/**
 * DiagramDagre — Directed graph layout rendered as SVG.
 *
 * @param props - graph + lang
 */
export default function DiagramDagre({ graph, lang: _lang }: DiagramVariantProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  // ── Layout with dagre ──
  const layout = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: 'TB',
      nodesep: 60,
      ranksep: 80,
      marginx: 40,
      marginy: 40,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of graph.nodes) {
      const h = node.type === 'person' ? NODE_H_PERSON : NODE_H_COMPANY;
      g.setNode(node.id, { width: NODE_W, height: h });
    }

    for (const edge of graph.edges) {
      g.setEdge(edge.from, edge.to);
    }

    dagre.layout(g);

    const nodePositions = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const node of graph.nodes) {
      const n = g.node(node.id);
      if (n) {
        nodePositions.set(node.id, {
          x: n.x - n.width / 2,
          y: n.y - n.height / 2,
          w: n.width,
          h: n.height,
        });
      }
    }

    const graphInfo = g.graph();
    const width = (graphInfo.width ?? 800) + 80;
    const height = (graphInfo.height ?? 600) + 80;

    return { nodePositions, width, height };
  }, [graph]);

  // Auto-zoom to fit
  useEffect(() => {
    if (!containerRef.current) return;
    const timer = setTimeout(() => {
      const c = containerRef.current;
      if (!c) return;
      const cW = c.clientWidth - 32;
      const cH = c.clientHeight - 32;
      if (layout.width > 0 && layout.height > 0) {
        const fit = Math.min(cW / layout.width, cH / layout.height, 1);
        if (fit < 0.95) setZoom(Math.max(fit, 0.2));
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [layout]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-base flex items-center gap-2">
          <Building2 size={16} className="text-purple-400" />
          Dagre Layout
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setZoom((z) => Math.min(z + 0.15, 2))}
            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-xs transition"
          >
            +
          </button>
          <span className="text-slate-500 text-[10px] w-8 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.max(z - 0.15, 0.15))}
            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-xs transition"
          >
            &minus;
          </button>
          <button
            onClick={() => setZoom(1)}
            className="px-2 h-7 flex items-center text-slate-400 hover:text-white bg-slate-800 border border-slate-700/50 rounded-lg text-[10px] transition"
          >
            100%
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-auto"
        style={{ maxHeight: '70vh' }}
      >
        <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', padding: 16 }}>
          <svg width={layout.width} height={layout.height} style={{ overflow: 'visible' }}>
            {/* Edges */}
            {graph.edges.map((edge, i) => {
              const fromPos = layout.nodePositions.get(edge.from);
              const toPos = layout.nodePositions.get(edge.to);
              if (!fromPos || !toPos) return null;

              // Connect from bottom-center of parent to top-center of child
              const sx = fromPos.x + fromPos.w / 2;
              const sy = fromPos.y + fromPos.h;
              const ex = toPos.x + toPos.w / 2;
              const ey = toPos.y;

              const midY = (sy + ey) / 2;
              const midX = (sx + ex) / 2;
              const labelY = midY - 2;

              return (
                <g key={`e-${i}`}>
                  <path
                    d={`M ${sx} ${sy} C ${sx} ${midY}, ${ex} ${midY}, ${ex} ${ey}`}
                    fill="none"
                    stroke={
                      edge.from === graph.mainId || edge.to === graph.mainId
                        ? 'rgba(59,130,246,0.5)'
                        : 'rgba(100,116,139,0.4)'
                    }
                    strokeWidth="1.5"
                  />
                  {edge.ejerandel && (
                    <>
                      <rect
                        x={midX - 28}
                        y={labelY - 8}
                        width="56"
                        height="16"
                        rx="4"
                        fill="rgba(16,185,129,0.1)"
                        stroke="rgba(16,185,129,0.25)"
                        strokeWidth="0.5"
                      />
                      <text
                        x={midX}
                        y={labelY + 3}
                        textAnchor="middle"
                        fill="rgba(52,211,153,0.9)"
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

            {/* Nodes */}
            {graph.nodes.map((node) => {
              const pos = layout.nodePositions.get(node.id);
              if (!pos) return null;
              const isMain = node.type === 'main';
              const isPerson = node.type === 'person';
              // BIZZ-357: Detect ceased companies for greyed-out rendering
              const isCeased = node.isCeased === true;

              const boxFill = isMain
                ? 'rgba(37,99,235,0.15)'
                : isCeased
                  ? 'rgba(30,30,35,0.55)'
                  : 'rgba(30,41,59,0.7)';
              const boxStroke = isMain
                ? 'rgba(59,130,246,0.5)'
                : isCeased
                  ? 'rgba(100,110,130,0.35)'
                  : 'rgba(51,65,85,0.5)';

              return (
                <g
                  key={node.id}
                  className="cursor-pointer"
                  onClick={() => node.link && router.push(node.link)}
                >
                  {/* Box */}
                  <rect
                    x={pos.x}
                    y={pos.y}
                    width={pos.w}
                    height={pos.h}
                    rx={isPerson ? pos.h / 2 : 12}
                    fill={boxFill}
                    stroke={boxStroke}
                    strokeWidth={isMain ? 2 : 1}
                    // BIZZ-357: Dashed border for ceased companies
                    strokeDasharray={isCeased ? '4 3' : undefined}
                  />
                  {/* BIZZ-357: "Ophørt" badge for ceased companies */}
                  {isCeased && (
                    <>
                      <rect
                        x={pos.x + pos.w - 50}
                        y={pos.y + 5}
                        width={44}
                        height={12}
                        rx={3}
                        fill="rgba(75,80,95,0.7)"
                        stroke="rgba(100,110,130,0.4)"
                        strokeWidth={0.75}
                      />
                      <text
                        x={pos.x + pos.w - 28}
                        y={pos.y + 14}
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
                    <circle
                      cx={pos.x + 20}
                      cy={pos.y + pos.h / 2}
                      r={6}
                      fill="none"
                      stroke="rgba(148,163,184,0.6)"
                      strokeWidth="1"
                    />
                  ) : (
                    <rect
                      x={pos.x + 12}
                      y={pos.y + pos.h / 2 - 6}
                      width={12}
                      height={12}
                      rx={2}
                      fill="none"
                      stroke={isMain ? 'rgba(96,165,250,0.7)' : 'rgba(148,163,184,0.5)'}
                      strokeWidth="1"
                    />
                  )}
                  {/* Label */}
                  <text
                    x={pos.x + 36}
                    y={node.sublabel ? pos.y + pos.h / 2 - 3 : pos.y + pos.h / 2 + 4}
                    fill={
                      isMain
                        ? '#ffffff'
                        : isCeased
                          ? 'rgba(160,165,175,0.75)'
                          : 'rgba(226,232,240,0.9)'
                    }
                    fontSize="11"
                    fontWeight={isMain ? '600' : '500'}
                  >
                    {node.label.length > 22 ? node.label.slice(0, 22) + '…' : node.label}
                  </text>
                  {node.sublabel && (
                    <text
                      x={pos.x + 36}
                      y={pos.y + pos.h / 2 + 12}
                      fill="rgba(100,116,139,0.7)"
                      fontSize="8"
                    >
                      {node.sublabel.length > 30 ? node.sublabel.slice(0, 30) + '…' : node.sublabel}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
