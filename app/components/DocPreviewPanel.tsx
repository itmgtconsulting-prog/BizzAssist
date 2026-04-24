/**
 * DocPreviewPanel — fixed right-side preview panel, globally available.
 *
 * BIZZ-807: Only renders when `useDocPreview().isOpen` is true. The
 * dashboard layout measures the panel width via a CSS variable so main
 * content pushes left instead of being overlaid.
 *
 * Layout contract:
 *   - Panel is `position: fixed`, flush right, below the topbar.
 *   - Width is published as `--bizz-docpreview-w` on :root so layout CSS
 *     can reserve padding-right on the main content wrapper.
 *   - User dismisses with the X button — no auto-close on navigation.
 *
 * @module app/components/DocPreviewPanel
 */
'use client';

import { useEffect, useState } from 'react';
import { X, Download, FileText, GripVertical } from 'lucide-react';
import { useDocPreview } from '@/app/context/DocPreviewContext';
import { useLanguage } from '@/app/context/LanguageContext';

const DEFAULT_WIDTH_PX = 520;
const MIN_WIDTH_PX = 360;
const MAX_WIDTH_PX = 1100;
const DEFAULT_TOP_OFFSET_PX = 72;

export function DocPreviewPanel() {
  const { content, isOpen, close } = useDocPreview();
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [widthPx, setWidthPx] = useState(DEFAULT_WIDTH_PX);
  const [topOffsetPx, setTopOffsetPx] = useState(DEFAULT_TOP_OFFSET_PX);

  // Load persisted width + measure topbar on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = Number(window.localStorage.getItem('bizz-docpreview-w'));
    if (stored >= MIN_WIDTH_PX && stored <= MAX_WIDTH_PX) setWidthPx(stored);
    const topbar = document.querySelector(
      'header, [data-dashboard-topbar], nav.topbar'
    ) as HTMLElement | null;
    if (topbar) {
      const rect = topbar.getBoundingClientRect();
      const offset = rect.top + rect.height;
      if (offset > 0 && offset < 300) setTopOffsetPx(offset);
    }
  }, []);

  // Publish width + open-state via CSS variable so the layout can reserve room
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isOpen) {
      document.documentElement.style.setProperty('--bizz-docpreview-w', `${widthPx}px`);
    } else {
      document.documentElement.style.removeProperty('--bizz-docpreview-w');
    }
    return () => {
      document.documentElement.style.removeProperty('--bizz-docpreview-w');
    };
  }, [widthPx, isOpen]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const vw = window.innerWidth;
      const next = Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, vw - ev.clientX));
      setWidthPx(next);
      window.localStorage.setItem('bizz-docpreview-w', String(Math.round(next)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Early return AFTER hooks so rules-of-hooks stay happy
  if (!isOpen || !content) return null;

  return (
    <aside
      className="fixed right-0 bottom-0 z-40 bg-slate-950 border-l border-slate-700/40 flex flex-col shadow-2xl"
      style={{ top: `${topOffsetPx}px`, width: `${widthPx}px` }}
      aria-label={da ? 'Dokument-preview' : 'Document preview'}
    >
      {/* Left-edge drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startDrag}
        className="absolute left-0 top-0 bottom-0 w-1.5 -translate-x-full cursor-col-resize bg-slate-800/40 hover:bg-blue-500/40 transition-colors group"
        title={da ? 'Træk for at ændre bredde' : 'Drag to resize'}
      >
        <GripVertical
          size={12}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
        />
      </div>

      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 flex items-center gap-2 shrink-0">
        <FileText size={14} className="text-blue-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white truncate">{content.name}</p>
          <p className="text-[10px] text-slate-500 uppercase">
            {content.fileType}
            {typeof content.sizeBytes === 'number' &&
              ` · ${Math.round(content.sizeBytes / 1024)} KB`}
            {content.truncated && ` · ${da ? 'beskåret' : 'truncated'}`}
          </p>
        </div>
        {content.downloadUrl && (
          <a
            href={content.downloadUrl}
            download
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[10px] transition-colors shrink-0"
            title={da ? 'Hent fil' : 'Download'}
          >
            <Download size={10} />
            {da ? 'Hent' : 'Download'}
          </a>
        )}
        <button
          type="button"
          onClick={close}
          aria-label={da ? 'Luk preview' : 'Close preview'}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body — scrollable preview. BIZZ-815: render strategi styret af
          content.kind. Default 'text' for bagudkompatibilitet. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {content.kind === 'table' && content.columns && content.rows ? (
          <TablePreview columns={content.columns} rows={content.rows} />
        ) : (
          <pre className="text-xs text-slate-200 whitespace-pre-wrap font-sans leading-relaxed">
            {content.text}
          </pre>
        )}
      </div>
    </aside>
  );
}

/**
 * BIZZ-815: HTML-tabel med sticky header, zebra rows, og "vis flere"-
 * toggle for store datasets. Formateret til at være læsbar i det
 * smalle preview-panel (~360px default).
 */
function TablePreview({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const INITIAL_ROWS = 200;
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? rows : rows.slice(0, INITIAL_ROWS);
  const hasMore = rows.length > INITIAL_ROWS;

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide flex items-center justify-between">
        <span>
          {columns.length} {columns.length === 1 ? 'kolonne' : 'kolonner'} · {rows.length}{' '}
          {rows.length === 1 ? 'række' : 'rækker'}
        </span>
        {hasMore && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-blue-400 hover:text-blue-300 text-[10px] font-medium uppercase tracking-wide normal-case"
          >
            Vis alle →
          </button>
        )}
      </div>
      <div className="rounded-md border border-slate-700/50 overflow-hidden">
        <table className="w-full text-xs text-slate-200">
          <thead className="bg-slate-800/60 sticky top-0 z-10">
            <tr>
              {columns.map((col, i) => (
                <th
                  key={i}
                  className="px-2 py-1.5 text-left font-semibold text-slate-300 border-b border-slate-700/40"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? 'bg-slate-900/30' : 'bg-slate-900/10'}>
                {columns.map((_, ci) => (
                  <td
                    key={ci}
                    className="px-2 py-1 border-b border-slate-800/40 align-top whitespace-nowrap max-w-[200px] truncate"
                    title={row[ci] ?? ''}
                  >
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && !showAll && (
        <p className="text-[10px] text-slate-500 italic">
          Viser første {INITIAL_ROWS} af {rows.length} rækker. Download for komplet data.
        </p>
      )}
    </div>
  );
}
