/**
 * InlineTemplateDetailView — templateeditor åbnet inde i et andet panel
 * (fx højre side af /dashboard/admin/domains split-view eller Skabeloner-
 * sub-tab i domain admin).
 *
 * BIZZ-789: I stedet for at navigere væk til /domain/[id]/admin/templates/
 * [templateId] (som ombygger hele siden og mister sidebar/topbar/tabs),
 * render vi detalje-viewet HER — inline i panelet — med en horizontal
 * split:
 *   * TOP: TemplateEditorClient (skabelon-felter, compact)
 *   * Resizable horizontal divider (træk op/ned)
 *   * BUND: TemplateDocumentsPanel (tilknyttede dokumenter)
 *
 * Divider-position persisteres i localStorage så brugeren ikke skal
 * justere for hver skabelon.
 *
 * @module app/domain/[id]/admin/templates/InlineTemplateDetailView
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, GripHorizontal, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';
import TemplateEditorClient from './[templateId]/TemplateEditorClient';
import { TemplateDocumentsPanel } from './[templateId]/TemplateDocumentsPanel';

interface Props {
  domainId: string;
  templateId: string;
  onBack: () => void;
}

const STORAGE_KEY = 'bizz-template-inline-top-pct';

export function InlineTemplateDetailView({ domainId, templateId, onBack }: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [topPct, setTopPct] = useState(55);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    if (saved >= 20 && saved <= 80) setTopPct(saved);
  }, []);

  // Horizontal divider drag — updates the top-panel height percentage.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const onMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const pct = ((ev.clientY - rect.top) / rect.height) * 100;
        setTopPct(Math.max(20, Math.min(80, pct)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.localStorage.setItem(STORAGE_KEY, String(Math.round(topPct)));
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [topPct]
  );

  return (
    <div className="h-full flex flex-col">
      {/* Compact header: back + fuld visning link */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-slate-700/40 bg-slate-900/50">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <ArrowLeft size={12} />
          {da ? 'Tilbage til skabeloner' : 'Back to templates'}
        </button>
        <Link
          href={`/domain/${domainId}/admin/templates/${templateId}`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          title={da ? 'Åbn i fuld visning' : 'Open full view'}
        >
          <ExternalLink size={12} />
          {da ? 'Fuld visning' : 'Full view'}
        </Link>
      </div>

      {/* Horizontal split: template editor on top, documents on bottom */}
      <div ref={containerRef} className="flex-1 flex flex-col min-h-0">
        <div
          className="min-h-0 overflow-y-auto bizz-inline-editor"
          style={{ height: `${topPct}%` }}
        >
          <TemplateEditorClient domainId={domainId} templateId={templateId} />
        </div>

        {/* Divider */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={Math.round(topPct)}
          aria-valuemin={20}
          aria-valuemax={80}
          onMouseDown={startResize}
          className="group relative h-1.5 shrink-0 cursor-row-resize bg-slate-800/40 hover:bg-blue-500/40 transition-colors"
          title={da ? 'Træk for at justere opdelingen' : 'Drag to resize split'}
        >
          <GripHorizontal
            size={14}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
          />
        </div>

        <div className="min-h-0 overflow-hidden" style={{ height: `${100 - topPct}%` }}>
          <TemplateDocumentsPanel domainId={domainId} templateId={templateId} />
        </div>
      </div>

      {/* Compact overrides for the embedded editor — reduces padding/margins
          så template-felter fylder mindre når vi er i en smal/kort panel. */}
      <style jsx global>{`
        .bizz-inline-editor > div {
          max-width: 100% !important;
          padding-top: 0.75rem !important;
          padding-bottom: 0.75rem !important;
        }
        .bizz-inline-editor .max-w-4xl {
          max-width: 100% !important;
        }
        .bizz-inline-editor h1 {
          font-size: 1rem !important;
        }
        .bizz-inline-editor [role='tablist'] {
          font-size: 0.75rem;
        }
      `}</style>
    </div>
  );
}
