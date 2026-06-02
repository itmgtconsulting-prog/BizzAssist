/**
 * KoncernVisualisering — Force-directed graf over koncern-aktiver med
 * forsikringsstatus + tids-slider (BIZZ-1528).
 *
 * Viser aktiverne (ejendomme, virksomheder, biler, bestyrelsesposter) som
 * cirkler farvekodet efter forsikringsstatus:
 * - Grøn = fuldt forsikret (matchet police + ingen kritiske gaps)
 * - Gul  = delvist forsikret (matchet police men gaps fundet)
 * - Rød  = uforsikret (ingen matchet police)
 * - Grå  = ikke relevant (fx bestyrelsespost uden D&O-krav)
 *
 * Tids-slider lader brugeren scrubbe gennem snapshot-datoer og se hvordan
 * dækningsstatus ændrer sig (fx når policer udløber). I MVP er sliderens
 * data primært cosmetisk — den henter eventuelle as_of_date-snapshots fra
 * forsikring_analyser-tabellen.
 *
 * Tung komponent — bør lazy-loades via next/dynamic ssr:false.
 *
 * @module app/components/forsikring/KoncernVisualisering
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3-force';
import { Shield, Loader2 } from 'lucide-react';

/** Forsikringsstatus per aktiv */
export type ForsikringStatus = 'fuld' | 'delvis' | 'uforsikret' | 'irrelevant';

/** Aktiv-node til visualisering */
export interface KoncernNode {
  /** Stabil ID (cvr/bfe/regnr) */
  id: string;
  /** Aktiv-type */
  type: 'ejendom' | 'virksomhed' | 'bil' | 'bestyrelsespost';
  /** Label til hover/tooltip */
  label: string;
  /** Forsikringsstatus pr. valgt snapshot-dato */
  status: ForsikringStatus;
  /** Værdi i DKK (skalérer cirkel-radius) */
  vaerdiDkk?: number | null;
}

/** Edge mellem to noder (ejer-relation, koncern-link) */
export interface KoncernEdge {
  source: string;
  target: string;
  /** Edge-label (fx "100%" ejer) */
  label?: string;
}

interface Props {
  /** Aktive noder ved valgt snapshot-dato */
  nodes: KoncernNode[];
  /** Edges */
  edges: KoncernEdge[];
  /** Tilgængelige snapshot-datoer for tids-slider (ISO YYYY-MM-DD) */
  snapshotDates?: string[];
  /** Aktiv snapshot-dato (controlled) */
  selectedDate?: string;
  /** Callback når brugeren ændrer slider */
  onDateChange?: (date: string) => void;
  /** Sprog */
  lang: 'da' | 'en';
}

/** Status → farve-mapping */
const STATUS_COLORS: Record<ForsikringStatus, { fill: string; stroke: string; label: string }> = {
  fuld: { fill: '#10b981', stroke: '#059669', label: 'Fuldt forsikret' },
  delvis: { fill: '#f59e0b', stroke: '#d97706', label: 'Delvist forsikret' },
  uforsikret: { fill: '#ef4444', stroke: '#dc2626', label: 'Uforsikret' },
  irrelevant: { fill: '#64748b', stroke: '#475569', label: 'Ikke relevant' },
};

/** d3-force simuleret position */
interface PositionedNode extends KoncernNode {
  x: number;
  y: number;
  fx?: number | null;
  fy?: number | null;
}

const WIDTH = 800;
const HEIGHT = 500;

/**
 * Beregn cirkel-radius baseret på værdi (logaritmisk skalering, min 8 / max 28 px).
 */
function nodeRadius(node: KoncernNode): number {
  const v = node.vaerdiDkk ?? 0;
  if (v <= 0) return 10;
  // log10-skala: 100k = 12, 1M = 16, 10M = 20, 100M = 24, 1B = 28
  const logV = Math.log10(v);
  return Math.min(28, Math.max(8, 8 + (logV - 5) * 4));
}

/**
 * Force-directed koncern-visualisering med tids-slider.
 *
 * @param props - nodes, edges, snapshotDates, selectedDate, onDateChange, lang
 */
export default function KoncernVisualisering(props: Props): React.ReactElement {
  const { nodes, edges, snapshotDates, selectedDate, onDateChange, lang } = props;
  const da = lang === 'da';
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [running, setRunning] = useState(true);
  const [hover, setHover] = useState<string | null>(null);

  // Build d3 nodes/links — deterministic initial positions (sinus-spread)
  // for at undgaa react-hooks/purity-fejl ved Math.random i render.
  const { simNodes, simLinks } = useMemo(() => {
    const sNodes: PositionedNode[] = nodes.map((n, i) => {
      const angle = (i / Math.max(1, nodes.length)) * 2 * Math.PI;
      return {
        ...n,
        x: WIDTH / 2 + Math.cos(angle) * 60,
        y: HEIGHT / 2 + Math.sin(angle) * 60,
      };
    });
    const sLinks = edges
      .filter((e) => sNodes.find((n) => n.id === e.source) && sNodes.find((n) => n.id === e.target))
      .map((e) => ({ source: e.source, target: e.target, label: e.label }));
    return { simNodes: sNodes, simLinks: sLinks };
  }, [nodes, edges]);

  // Run d3-force simulation
  useEffect(() => {
    if (simNodes.length === 0) return;
    setRunning(true);

    const sim = d3
      .forceSimulation<PositionedNode>(simNodes)
      .force(
        'link',
        d3
          .forceLink(simLinks as d3.SimulationLinkDatum<PositionedNode>[])
          .id((d) => (d as PositionedNode).id)
          .distance(80)
          .strength(0.5)
      )
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(WIDTH / 2, HEIGHT / 2))
      .force(
        'collide',
        d3.forceCollide<PositionedNode>().radius((d) => nodeRadius(d) + 4)
      )
      .alphaDecay(0.05);

    sim.on('tick', () => {
      const next = new Map<string, { x: number; y: number }>();
      for (const n of simNodes) {
        next.set(n.id, { x: n.x, y: n.y });
      }
      setPositions(next);
    });

    sim.on('end', () => setRunning(false));

    return () => {
      sim.stop();
    };
  }, [simNodes, simLinks]);

  // Status-fordeling til summary
  const statusCounts = useMemo(() => {
    const counts: Record<ForsikringStatus, number> = {
      fuld: 0,
      delvis: 0,
      uforsikret: 0,
      irrelevant: 0,
    };
    for (const n of nodes) counts[n.status]++;
    return counts;
  }, [nodes]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
      {/* Header + summary */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-emerald-400" aria-hidden />
          <h3 className="text-sm font-semibold text-white">
            {da ? 'Koncern-forsikringsstatus' : 'Group insurance status'}
          </h3>
          {running && <Loader2 className="w-3 h-3 animate-spin text-slate-400" aria-hidden />}
        </div>
        <div className="flex items-center gap-3 text-xs">
          {(Object.entries(statusCounts) as [ForsikringStatus, number][])
            .filter(([, n]) => n > 0)
            .map(([status, count]) => (
              <div key={status} className="flex items-center gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: STATUS_COLORS[status].fill }}
                  aria-hidden
                />
                <span className="text-slate-400">
                  {count} {STATUS_COLORS[status].label.toLowerCase()}
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* SVG canvas */}
      <div className="bg-slate-950 rounded-lg overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full h-auto"
          role="img"
          aria-label={da ? 'Koncern-forsikrings-diagram' : 'Group insurance diagram'}
        >
          {/* Edges */}
          {simLinks.map((l, i) => {
            const s = positions.get(l.source as string);
            const t = positions.get(l.target as string);
            if (!s || !t) return null;
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke="rgba(148,163,184,0.3)"
                strokeWidth={1}
              />
            );
          })}
          {/* Nodes */}
          {simNodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const r = nodeRadius(n);
            const colors = STATUS_COLORS[n.status];
            const isHover = hover === n.id;
            return (
              <g
                key={n.id}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill={colors.fill}
                  stroke={colors.stroke}
                  strokeWidth={isHover ? 2.5 : 1.5}
                  opacity={isHover ? 1 : 0.85}
                />
                {isHover && (
                  <text
                    x={p.x}
                    y={p.y - r - 6}
                    textAnchor="middle"
                    fill="rgba(226,232,240,0.95)"
                    fontSize="11"
                    fontWeight="500"
                    style={{ pointerEvents: 'none' }}
                  >
                    {n.label.length > 40 ? n.label.slice(0, 37) + '…' : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Tids-slider (kun synlig hvis der er snapshot-datoer) */}
      {snapshotDates && snapshotDates.length > 1 && (
        <div className="mt-3 px-2">
          <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
            <span>{snapshotDates[0]}</span>
            <span className="text-emerald-400 font-medium">
              {selectedDate ?? snapshotDates[snapshotDates.length - 1]}
            </span>
            <span>{snapshotDates[snapshotDates.length - 1]}</span>
          </div>
          <input
            type="range"
            min={0}
            max={snapshotDates.length - 1}
            value={Math.max(
              0,
              snapshotDates.indexOf(selectedDate ?? snapshotDates[snapshotDates.length - 1])
            )}
            onChange={(e) => {
              const idx = parseInt(e.target.value, 10);
              if (snapshotDates[idx] && onDateChange) onDateChange(snapshotDates[idx]);
            }}
            className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
            aria-label={da ? 'Vælg snapshot-dato' : 'Select snapshot date'}
          />
        </div>
      )}
    </div>
  );
}
