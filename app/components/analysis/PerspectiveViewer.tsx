'use client';

/**
 * React wrapper for the @finos/perspective `<perspective-viewer>` web component.
 *
 * Lazily initialises the Perspective WASM engine on first mount and loads
 * tabular data into an interactive pivot-table / chart viewer. Uses the
 * built-in "Pro Dark" theme to match the BizzAssist dark UI.
 *
 * This component MUST be imported via `next/dynamic` with `ssr: false` —
 * Perspective relies on WebAssembly which is browser-only.
 *
 * @module PerspectiveViewer
 */

import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle, useState } from 'react';
import { Loader2 } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single row of flat key-value data to display in the viewer */
type DataRow = Record<string, string | number | boolean | null>;

/** Props for the PerspectiveViewer component */
interface PerspectiveViewerProps {
  /** Array of flat objects — each object becomes one row */
  data: DataRow[];
  /** Optional title shown above the viewer */
  title?: string;
}

/** Methods exposed to parent components via ref */
export interface PerspectiveViewerHandle {
  /** Trigger a CSV download of the current view */
  downloadCsv: () => Promise<void>;
}

/**
 * Minimal type for the `<perspective-viewer>` DOM element.
 * Covers the methods we actually call — avoids importing the full
 * Perspective type-graph at the component boundary.
 */
interface PerspectiveViewerElement extends HTMLElement {
  load: (table: unknown) => Promise<void>;
  restore: (config: Record<string, unknown>) => Promise<void>;
  reset: () => Promise<void>;
  download: (options?: { formatted?: boolean }) => Promise<void>;
  delete: () => Promise<void>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Interactive pivot-table viewer powered by @finos/perspective.
 *
 * Loads data into a Perspective Table, renders it via the `<perspective-viewer>`
 * web component, and applies the Pro Dark theme. Exposes a `downloadCsv`
 * method via `useImperativeHandle` for parent-triggered exports.
 *
 * @param props - PerspectiveViewerProps
 * @param ref   - Optional ref for PerspectiveViewerHandle
 */
const PerspectiveViewer = forwardRef<PerspectiveViewerHandle, PerspectiveViewerProps>(
  function PerspectiveViewer({ data, title }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewerRef = useRef<PerspectiveViewerElement | null>(null);
    const clientRef = useRef<{ table: (data: unknown) => Promise<unknown> } | null>(null);
    const tableRef = useRef<unknown>(null);
    const [loading, setLoading] = useState(true);

    /**
     * Bootstrap Perspective: import WASM modules, register plugins,
     * create a web-worker client, and mount the `<perspective-viewer>` element.
     * Runs once on mount.
     */
    useEffect(() => {
      let cancelled = false;

      async function init() {
        if (!containerRef.current) return;

        // Dynamic imports — these pull in WASM and register custom elements
        const perspective = await import('@finos/perspective');
        await import('@finos/perspective-viewer');
        await import('@finos/perspective-viewer-datagrid');
        await import('@finos/perspective-viewer-d3fc');

        if (cancelled) return;

        // Create the Perspective web-worker client
        const client = await perspective.worker();
        clientRef.current = client as unknown as { table: (data: unknown) => Promise<unknown> };

        // Create and mount the viewer element
        const viewer = document.createElement('perspective-viewer') as PerspectiveViewerElement;
        viewer.setAttribute('theme', 'Pro Dark');
        viewer.style.width = '100%';
        viewer.style.height = '100%';

        // Clear container and append
        if (containerRef.current) {
          containerRef.current.innerHTML = '';
          containerRef.current.appendChild(viewer);
          viewerRef.current = viewer;
        }

        if (cancelled) return;
        setLoading(false);
      }

      init();

      return () => {
        cancelled = true;
        // Clean up the viewer on unmount
        if (viewerRef.current) {
          viewerRef.current.delete().catch(() => {
            // Viewer may already be detached — ignore
          });
          viewerRef.current = null;
        }
      };
    }, []);

    /**
     * Load or reload data into the Perspective table whenever `data` changes.
     * Creates a new Table from the worker client and passes it to the viewer.
     */
    useEffect(() => {
      if (loading || !viewerRef.current || !clientRef.current || data.length === 0) return;

      let cancelled = false;

      async function loadData() {
        if (!clientRef.current || !viewerRef.current) return;

        // Delete previous table if it exists
        if (
          tableRef.current &&
          typeof (tableRef.current as { delete?: () => Promise<void> }).delete === 'function'
        ) {
          await (tableRef.current as { delete: () => Promise<void> }).delete();
        }

        const table = await clientRef.current.table(data);
        if (cancelled) return;

        tableRef.current = table;
        await viewerRef.current.load(table);
      }

      loadData();

      return () => {
        cancelled = true;
      };
    }, [data, loading]);

    /** Trigger a CSV download of the current Perspective view */
    const downloadCsv = useCallback(async () => {
      if (viewerRef.current) {
        await viewerRef.current.download({ formatted: true });
      }
    }, []);

    useImperativeHandle(ref, () => ({ downloadCsv }), [downloadCsv]);

    return (
      <div className="flex flex-col h-full">
        {title && <div className="text-sm font-medium text-slate-300 mb-2">{title}</div>}
        <div className="flex-1 min-h-[400px] relative rounded-xl overflow-hidden border border-white/8">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0f172a]">
              <Loader2 size={20} className="animate-spin text-blue-400" />
            </div>
          )}
          <div
            ref={containerRef}
            className="w-full h-full"
            style={{ minHeight: 400, background: '#0f172a' }}
          />
        </div>
      </div>
    );
  }
);

export default PerspectiveViewer;
