'use client';

/**
 * React Flow diagram — interactive node-based diagram with draggable nodes,
 * auto-routing edges, built-in zoom/pan.
 *
 * @param props - DiagramVariantProps
 */

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { Building2, Users } from 'lucide-react';
import type { DiagramVariantProps, DiagramNode } from './DiagramData';

/** Node data stored as Record<string, unknown> for React Flow compatibility */
type RFNodeData = Record<string, unknown> & DiagramNode;

/** Node dimensions for layout calculation */
const NODE_W = 220;
const NODE_H_COMPANY = 56;
const NODE_H_PERSON = 40;

// ─── Custom Node Components ─────────────────────────────────────────────────

/**
 * Company node renderer for React Flow.
 *
 * @param props - NodeProps with data containing DiagramNode fields
 */
function CompanyNode({ data }: { data: RFNodeData }) {
  const router = useRouter();
  const isMain = data.type === 'main';

  return (
    <div
      onClick={() => data.link && router.push(data.link)}
      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl transition cursor-pointer ${
        isMain
          ? 'bg-blue-600/20 border-2 border-blue-500/50'
          : 'bg-slate-800/80 border border-slate-700/50 hover:border-blue-500/40'
      }`}
      style={{ width: NODE_W }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-slate-600 !border-slate-500 !w-2 !h-2"
      />
      <Building2
        size={14}
        className={isMain ? 'text-blue-400 shrink-0' : 'text-slate-400 shrink-0'}
      />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold truncate ${isMain ? 'text-white' : 'text-slate-200'}`}>
          {data.label}
        </p>
        {data.sublabel && (
          <p className={`text-[9px] truncate ${isMain ? 'text-blue-300/60' : 'text-slate-500'}`}>
            {data.sublabel}
          </p>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-slate-600 !border-slate-500 !w-2 !h-2"
      />
    </div>
  );
}

/**
 * Person node renderer for React Flow.
 *
 * @param props - NodeProps with DiagramNode data
 */
function PersonNode({ data }: { data: RFNodeData }) {
  const router = useRouter();

  return (
    <div
      onClick={() => data.link && router.push(data.link)}
      className="flex items-center gap-1.5 px-3 py-2 bg-slate-800/60 border border-slate-600/40 rounded-full hover:border-slate-500/60 transition cursor-pointer"
      style={{ width: NODE_W }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-slate-600 !border-slate-500 !w-2 !h-2"
      />
      <Users size={12} className="text-slate-400 shrink-0" />
      <span className="text-slate-300 text-[10px] font-medium truncate">{data.label}</span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-slate-600 !border-slate-500 !w-2 !h-2"
      />
    </div>
  );
}

/** React Flow node type registry */
const nodeTypes: NodeTypes = {
  company: CompanyNode,
  person: PersonNode,
  main: CompanyNode,
};

// ─── Layout Helper ──────────────────────────────────────────────────────────

/**
 * Uses dagre to calculate initial node positions for React Flow.
 *
 * @param nodes - React Flow nodes
 * @param edges - React Flow edges
 * @returns Positioned nodes
 */
function getLayoutedElements(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 90, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    const h = node.type === 'person' ? NODE_H_PERSON : NODE_H_COMPANY;
    g.setNode(node.id, { width: NODE_W, height: h });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const dagreNode = g.node(node.id);
    const h = node.type === 'person' ? NODE_H_PERSON : NODE_H_COMPANY;
    return {
      ...node,
      position: {
        x: dagreNode.x - NODE_W / 2,
        y: dagreNode.y - h / 2,
      },
    };
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * DiagramFlow — React Flow interactive diagram.
 * Nodes are draggable, edges auto-route, built-in zoom/pan.
 *
 * @param props - graph + lang
 */
export default function DiagramFlow({ graph, lang }: DiagramVariantProps) {
  // Build React Flow nodes + edges from DiagramGraph
  const { rfNodes, rfEdges } = useMemo(() => {
    const rfEdges: Edge[] = graph.edges.map((e, i) => ({
      id: `e-${i}`,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      animated: false,
      label: e.ejerandel ?? undefined,
      labelStyle: { fill: 'rgba(52,211,153,0.9)', fontSize: 9, fontWeight: 500 },
      labelBgStyle: { fill: 'rgba(16,185,129,0.1)', stroke: 'rgba(16,185,129,0.25)' },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      style: {
        stroke:
          e.from === graph.mainId || e.to === graph.mainId
            ? 'rgba(59,130,246,0.5)'
            : 'rgba(100,116,139,0.45)',
        strokeWidth: 1.5,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 10,
        height: 10,
        color: 'rgba(100,116,139,0.4)',
      },
    }));

    const rfNodesRaw: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: n.type === 'person' ? 'person' : n.type === 'main' ? 'main' : 'company',
      data: { ...n } as RFNodeData,
      position: { x: 0, y: 0 },
    }));

    const rfNodes = getLayoutedElements(rfNodesRaw, rfEdges);
    return { rfNodes, rfEdges };
  }, [graph]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-base flex items-center gap-2">
          <Building2 size={16} className="text-cyan-400" />
          React Flow (Interactive)
        </h2>
        <span className="text-slate-500 text-[10px]">
          {lang === 'da'
            ? 'Scroll for zoom · Træk for panorering · Flyt noder frit'
            : 'Scroll to zoom · Drag to pan · Move nodes freely'}
        </span>
      </div>

      <div
        className="bg-slate-800/20 border border-slate-700/30 rounded-2xl overflow-hidden"
        style={{ height: '65vh' }}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'transparent' }}
        >
          <Background color="rgba(51,65,85,0.15)" gap={20} size={1} />
          <Controls className="!bg-slate-800 !border-slate-700 !rounded-lg [&>button]:!bg-slate-800 [&>button]:!border-slate-700 [&>button]:!text-slate-400 [&>button:hover]:!bg-slate-700" />
        </ReactFlow>
      </div>
    </div>
  );
}
