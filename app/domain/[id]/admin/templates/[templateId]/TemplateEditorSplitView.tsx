/**
 * TemplateEditorSplitView — master-detail layout for the template editor.
 *
 * BIZZ-787: The template editor is split into two resizable columns:
 *   * LEFT: TemplateEditorClient (Metadata/Instructions/Examples/Placeholders/Versions)
 *   * RIGHT: TemplateDocumentsPanel — dokumenter som forsyner AI med
 *     baggrundsviden for denne specifikke skabelon.
 *
 * A draggable vertical divider lets the admin rebalance the split between
 * editing the template and managing its AI-context documents. Position is
 * persisted in localStorage so it survives reloads.
 *
 * @module app/domain/[id]/admin/templates/[templateId]/TemplateEditorSplitView
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { GripVertical, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import TemplateEditorClient from './TemplateEditorClient';
import { TemplateDocumentsPanel } from './TemplateDocumentsPanel';

interface Props {
  domainId: string;
  templateId: string;
}

const STORAGE_KEY = 'bizz-template-editor-split-pct';

export function TemplateEditorSplitView({ domainId, templateId }: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [leftPct, setLeftPct] = useState(60);
  const [collapsed, setCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Restore persisted divider position on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    if (saved >= 30 && saved <= 85) setLeftPct(saved);
  }, []);

  // Drag handler for the divider. Constrained to [30, 85] so neither side
  // disappears entirely — collapse toggle handles the "hide docs" case.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const onMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const pct = ((ev.clientX - rect.left) / rect.width) * 100;
        setLeftPct(Math.max(30, Math.min(85, pct)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.localStorage.setItem(STORAGE_KEY, String(Math.round(leftPct)));
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [leftPct]
  );

  return (
    <div
      ref={containerRef}
      className="flex w-full relative"
      style={{ minHeight: 'calc(100vh - 140px)' }}
    >
      {/* LEFT: template editor */}
      <div
        className="min-w-0 overflow-hidden"
        style={{ width: collapsed ? '100%' : `${leftPct}%` }}
      >
        <TemplateEditorClient domainId={domainId} templateId={templateId} />
      </div>

      {/* Floating "show docs" button while collapsed */}
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-800/90 hover:bg-slate-700 border border-slate-700/40 rounded-md text-xs text-slate-200 shadow-lg"
          title={da ? 'Vis dokumenter' : 'Show documents'}
        >
          <PanelRightOpen size={13} />
          {da ? 'Vis dokumenter' : 'Show documents'}
        </button>
      )}

      {/* DIVIDER + RIGHT: documents panel */}
      {!collapsed && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(leftPct)}
            aria-valuemin={30}
            aria-valuemax={85}
            onMouseDown={startResize}
            className="group relative w-1.5 shrink-0 cursor-col-resize bg-slate-800/40 hover:bg-blue-500/40 transition-colors"
            title={da ? 'Træk for at justere opdelingen' : 'Drag to resize split'}
          >
            <GripVertical
              size={14}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
            />
          </div>

          <div
            className="min-w-0 overflow-hidden border-l border-slate-700/40"
            style={{ width: `${100 - leftPct}%` }}
          >
            <div className="h-full flex flex-col">
              <div className="flex justify-end px-2 py-1 border-b border-slate-700/40 bg-slate-900/40">
                <button
                  type="button"
                  onClick={() => setCollapsed(true)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  title={da ? 'Skjul dokumenter' : 'Hide documents'}
                >
                  <PanelRightClose size={13} />
                  {da ? 'Skjul' : 'Hide'}
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <TemplateDocumentsPanel domainId={domainId} templateId={templateId} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
