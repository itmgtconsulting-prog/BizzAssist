/**
 * PerspectiveViewer — wrapper around @finos/perspective-viewer for BizzAssist.
 *
 * BIZZ-1037: Loaded via next/dynamic med ssr: false (WebAssembly kræver browser).
 * Bruger pro-dark theme der matcher BizzAssist's dark design.
 *
 * Features:
 *  - Modtager data som JSON array eller Apache Arrow buffer
 *  - Dark theme (pro-dark)
 *  - Konfigurérbar via plugin/columns/group-by/sort props
 *  - Eksponerer viewer-ref for programmatisk kontrol
 *
 * @param data - Array af datarækker (JSON) eller ArrayBuffer (Arrow)
 * @param columns - Kolonner der vises (default: alle)
 * @param groupBy - Group-by kolonner
 * @param splitBy - Split-by kolonner
 * @param sort - Sorteringsregler
 * @param plugin - Visningstype (datagrid, d3_y_bar, d3_y_line, etc.)
 */

'use client';

import { useEffect, useRef } from 'react';
import perspective from '@finos/perspective';
import '@finos/perspective-viewer';
import '@finos/perspective-viewer-datagrid';
import '@finos/perspective-viewer-d3fc';

/** Perspective viewer custom element type */
type PerspectiveViewerElement = HTMLElement & {
  load: (table: unknown) => Promise<void>;
  restore: (config: Record<string, unknown>) => Promise<void>;
  save: () => Promise<Record<string, unknown>>;
  delete: () => Promise<void>;
};

interface Props {
  /** Data som JSON array eller Arrow ArrayBuffer */
  data: Record<string, unknown>[] | ArrayBuffer;
  /** Synlige kolonner (default: alle) */
  columns?: string[];
  /** Group-by kolonner */
  groupBy?: string[];
  /** Split-by kolonner */
  splitBy?: string[];
  /** Sorteringsregler: [[kolonne, "asc"|"desc"]] */
  sort?: [string, 'asc' | 'desc'][];
  /** Visningstype: datagrid, d3_y_bar, d3_y_line, d3_y_scatter, d3_treemap */
  plugin?: string;
  /** Højde i pixels (default: 500) */
  height?: number;
}

export default function PerspectiveViewer({
  data,
  columns,
  groupBy,
  splitBy,
  sort,
  plugin = 'Datagrid',
  height = 500,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PerspectiveViewerElement | null>(null);
  const tableRef = useRef<unknown>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let viewer = viewerRef.current;
    if (!viewer) {
      viewer = document.createElement('perspective-viewer') as PerspectiveViewerElement;
      viewer.setAttribute('theme', 'Pro Dark');
      viewer.style.width = '100%';
      viewer.style.height = `${height}px`;
      containerRef.current.appendChild(viewer);
      viewerRef.current = viewer;
    }

    /** Indlæs data og konfiguration */
    const loadData = async () => {
      try {
        const worker = await perspective.worker();
        const table = await worker.table(data as Record<string, unknown>[]);
        tableRef.current = table;
        await viewer!.load(table);

        /* Anvend konfiguration hvis specificeret */
        const config: Record<string, unknown> = {};
        if (columns) config.columns = columns;
        if (groupBy) config.group_by = groupBy;
        if (splitBy) config.split_by = splitBy;
        if (sort) config.sort = sort;
        if (plugin) config.plugin = plugin;
        if (Object.keys(config).length > 0) {
          await viewer!.restore(config);
        }
      } catch (err) {
        console.error('[PerspectiveViewer] Load fejl:', err);
      }
    };

    loadData();

    const container = containerRef.current;
    return () => {
      if (viewerRef.current && container?.contains(viewerRef.current)) {
        viewerRef.current.delete().catch(() => {});
        container.removeChild(viewerRef.current);
        viewerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg overflow-hidden border border-slate-700/40"
      style={{ height: `${height}px` }}
    />
  );
}
