/**
 * DomainWorkspaceSplitView — 3-panel working surface med AI-agent + skabelon-
 * vælger permanent forankret i højre side af viewporten.
 *
 * BIZZ-800 / BIZZ-801: Når brugeren vælger en sag fra Domain/Sager-tab
 * åbner:
 *   * LEFT (inline, fits in DomainUserDashboardClient flow):
 *       - TOP: sager-listen
 *       - resizable horizontal bar
 *       - BOTTOM: valgt sag-detail med dokumenter
 *   * RIGHT (fixed, fylder hele viewport-højden fra top-bar til bund):
 *       - TOP: AI-agent chat
 *       - resizable horizontal bar
 *       - BOTTOM: skabelon-vælger
 *       - vertikal bar på venstre kant justerer panel-bredden
 *
 * Top-bar, sidebar og Domain-header bevares uændret — højre panel svæver
 * ovenpå som fixed side-vindue, og main-content får paddingRight via CSS-
 * variabel så tabs/header ikke glider ind under.
 *
 * @module app/domain/[id]/DomainWorkspaceSplitView
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  GripVertical,
  GripHorizontal,
  Bot,
  FileText,
  Briefcase,
  X,
  Send,
  Loader2,
  Paperclip,
  Sparkles,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { DomainCaseSummary } from './DomainCaseList';

interface TemplateSummary {
  id: string;
  name: string;
  file_type: string;
  status: 'active' | 'archived';
  description?: string | null;
}

interface CaseDocSummary {
  id: string;
  name: string;
}

interface Props {
  domainId: string;
  selectedCaseId: string;
  cases: DomainCaseSummary[];
  onSelectCase: (id: string) => void;
  onCloseWorkspace: () => void;
}

const STORAGE = {
  rightWidth: 'bizz-domain-ws-rightW-px',
  leftTop: 'bizz-domain-ws-leftTop-pct',
  rightTop: 'bizz-domain-ws-rightTop-pct',
};

/** Distance fra viewport-top til panelets top. Matcher DashboardLayout
 * topbar (≈ 72px) + en 2FA-banner (≈ 40px når synlig). Bruges som fallback
 * hvis vi ikke kan måle topbar-elementet på mount. */
const DEFAULT_TOP_OFFSET_PX = 72;

export function DomainWorkspaceSplitView({
  domainId,
  selectedCaseId,
  cases,
  onSelectCase,
  onCloseWorkspace,
}: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [rightWidthPx, setRightWidthPx] = useState(520);
  const [leftTopPct, setLeftTopPct] = useState(40);
  const [rightTopPct, setRightTopPct] = useState(55);
  const [topOffsetPx, setTopOffsetPx] = useState(DEFAULT_TOP_OFFSET_PX);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rw = Number(window.localStorage.getItem(STORAGE.rightWidth));
    if (rw >= 320 && rw <= 1100) setRightWidthPx(rw);
    const lt = Number(window.localStorage.getItem(STORAGE.leftTop));
    if (lt >= 20 && lt <= 80) setLeftTopPct(lt);
    const rt = Number(window.localStorage.getItem(STORAGE.rightTop));
    if (rt >= 20 && rt <= 80) setRightTopPct(rt);

    // BIZZ-801: Mål DashboardLayout's topbar-offset dynamisk.
    const topbar = document.querySelector(
      'header, [data-dashboard-topbar], nav.topbar'
    ) as HTMLElement | null;
    if (topbar) {
      const rect = topbar.getBoundingClientRect();
      const offset = rect.top + rect.height;
      if (offset > 0 && offset < 300) setTopOffsetPx(offset);
    }
  }, []);

  // BIZZ-801: Publicér højre-panelets bredde som CSS-variabel så parent-
  // containeren kan reservere padding-right og undgå at tabs/header glider
  // ind under panelet.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.style.setProperty('--bizz-workspace-right-w', `${rightWidthPx}px`);
    return () => {
      document.documentElement.style.removeProperty('--bizz-workspace-right-w');
    };
  }, [rightWidthPx]);

  const leftColRef = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);

  // ─── Drag handlers ──────────────────────────────────────────────────────
  const startVerticalResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      // Drag from right → left reduces panel width; vice versa.
      const vw = window.innerWidth;
      const newWidth = Math.max(320, Math.min(1100, vw - ev.clientX));
      setRightWidthPx(newWidth);
      window.localStorage.setItem(STORAGE.rightWidth, String(Math.round(newWidth)));
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
  }, []);

  const startHorizontalResize = useCallback(
    (getRef: () => HTMLDivElement | null, set: (pct: number) => void, storageKey: string) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        const el = getRef();
        if (!el) return;
        const onMove = (ev: MouseEvent) => {
          const rect = el.getBoundingClientRect();
          const pct = ((ev.clientY - rect.top) / rect.height) * 100;
          const clamped = Math.max(20, Math.min(80, pct));
          set(clamped);
          window.localStorage.setItem(storageKey, String(Math.round(clamped)));
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
      },
    []
  );

  const selectedCase = cases.find((c) => c.id === selectedCaseId) ?? null;

  // ─── Case detail state ──────────────────────────────────────────────────
  const [caseDocs, setCaseDocs] = useState<CaseDocSummary[]>([]);
  const [caseDocsLoading, setCaseDocsLoading] = useState(false);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());

  const loadCaseDocs = useCallback(async () => {
    if (!selectedCaseId) return;
    setCaseDocsLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}/docs`);
      if (r.ok) {
        const json = (await r.json()) as CaseDocSummary[] | { docs: CaseDocSummary[] };
        setCaseDocs(Array.isArray(json) ? json : (json.docs ?? []));
      } else {
        setCaseDocs([]);
      }
    } catch {
      setCaseDocs([]);
    } finally {
      setCaseDocsLoading(false);
    }
  }, [domainId, selectedCaseId]);

  useEffect(() => {
    void loadCaseDocs();
    setSelectedDocIds(new Set());
  }, [loadCaseDocs]);

  // ─── Templates ──────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTemplatesLoading(true);
      try {
        const r = await fetch(`/api/domain/${domainId}/templates`);
        if (!r.ok) return;
        const json = (await r.json()) as TemplateSummary[];
        if (cancelled) return;
        setTemplates(json.filter((t) => t.status === 'active'));
      } finally {
        if (!cancelled) setTemplatesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domainId]);

  // ─── AI chat ────────────────────────────────────────────────────────────
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMessages, setAiMessages] = useState<
    Array<{ role: 'user' | 'assistant'; text: string; timestamp: number }>
  >([]);
  const [aiError, setAiError] = useState<string | null>(null);

  const sendAi = async () => {
    if (!aiPrompt.trim() || aiBusy) return;
    if (!selectedTemplateId) {
      setAiError(
        da
          ? 'Vælg først en skabelon nedenfor før du sender en besked.'
          : 'Select a template below before sending a message.'
      );
      return;
    }
    setAiError(null);
    const prompt = aiPrompt.trim();
    setAiMessages((prev) => [...prev, { role: 'user', text: prompt, timestamp: Date.now() }]);
    setAiPrompt('');
    setAiBusy(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/case/${selectedCaseId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: selectedTemplateId,
          user_instructions: prompt,
          selected_doc_ids: Array.from(selectedDocIds),
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: 'Ukendt fejl' }));
        setAiError(body.error ?? (da ? 'Generation fejlede' : 'Generation failed'));
        return;
      }
      const json = (await r.json()) as { output_path?: string };
      setAiMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: json.output_path
            ? da
              ? `✓ Dokument genereret. Hent det via sagens dokumenter-fane.`
              : `✓ Document generated. Download from case documents.`
            : da
              ? '✓ Generation startet.'
              : '✓ Generation started.',
          timestamp: Date.now(),
        },
      ]);
    } catch {
      setAiError(da ? 'Netværksfejl' : 'Network error');
    } finally {
      setAiBusy(false);
    }
  };

  const toggleDoc = (id: string) => {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* LEFT — inline, flow-normal. Fits in DomainUserDashboardClient. */}
      <div
        ref={leftColRef}
        className="flex flex-col border border-slate-700/40 rounded-xl overflow-hidden"
        style={{ height: 'calc(100vh - 280px)', minHeight: 480 }}
      >
        {/* TOP-LEFT: sager-listen */}
        <div
          className="min-h-0 overflow-y-auto bg-slate-900/30"
          style={{ height: `${leftTopPct}%` }}
        >
          <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 flex items-center justify-between sticky top-0 z-10">
            <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Briefcase size={12} />
              {da ? 'Sager' : 'Cases'} · {cases.length}
            </p>
            <button
              type="button"
              onClick={onCloseWorkspace}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title={da ? 'Luk arbejdsområde' : 'Close workspace'}
            >
              <X size={12} />
            </button>
          </div>
          <ul className="divide-y divide-slate-800/60">
            {cases.map((c) => {
              const active = c.id === selectedCaseId;
              return (
                <li
                  key={c.id}
                  onClick={() => onSelectCase(c.id)}
                  className={`px-3 py-2 cursor-pointer transition-colors ${
                    active
                      ? 'bg-blue-500/15 border-l-2 border-blue-400'
                      : 'hover:bg-slate-800/60 border-l-2 border-transparent'
                  }`}
                >
                  <p className="text-sm text-white truncate">{c.name}</p>
                  {c.client_ref && (
                    <p className="text-[11px] text-slate-500 truncate">{c.client_ref}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Horizontal divider inside left column */}
        <div
          role="separator"
          aria-orientation="horizontal"
          onMouseDown={startHorizontalResize(
            () => leftColRef.current,
            setLeftTopPct,
            STORAGE.leftTop
          )}
          className="group h-1.5 shrink-0 cursor-row-resize bg-slate-800/40 hover:bg-blue-500/40 relative transition-colors"
          title={da ? 'Træk op/ned' : 'Drag up/down'}
        >
          <GripHorizontal
            size={12}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
          />
        </div>

        {/* BOTTOM-LEFT: selected case detail */}
        <div
          className="min-h-0 overflow-y-auto bg-slate-900/20"
          style={{ height: `${100 - leftTopPct}%` }}
        >
          <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 sticky top-0 z-10">
            <p className="text-xs font-semibold text-slate-300 truncate">
              {selectedCase?.name ?? (da ? 'Vælg en sag' : 'Select a case')}
            </p>
          </div>
          <div className="p-3 space-y-3">
            {selectedCase && (
              <>
                <div className="text-xs space-y-1">
                  {selectedCase.client_ref && (
                    <p>
                      <span className="text-slate-500">
                        {da ? 'Klient-reference: ' : 'Client ref: '}
                      </span>
                      <span className="text-slate-200">{selectedCase.client_ref}</span>
                    </p>
                  )}
                  <p>
                    <span className="text-slate-500">{da ? 'Status: ' : 'Status: '}</span>
                    <span className="text-slate-200 capitalize">{selectedCase.status}</span>
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">
                    {da ? 'Dokumenter' : 'Documents'} · {caseDocs.length}
                  </p>
                  {caseDocsLoading ? (
                    <Loader2 size={14} className="animate-spin text-blue-400" />
                  ) : caseDocs.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      {da ? 'Ingen dokumenter på sagen.' : 'No documents on this case.'}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {caseDocs.map((d) => {
                        const sel = selectedDocIds.has(d.id);
                        return (
                          <li key={d.id}>
                            <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800/40 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={sel}
                                onChange={() => toggleDoc(d.id)}
                                className="shrink-0"
                              />
                              <Paperclip size={11} className="text-slate-400 shrink-0" />
                              <span className="text-xs text-slate-200 truncate">{d.name}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {selectedDocIds.size > 0 && (
                    <p className="text-[10px] text-blue-300 mt-1.5">
                      {selectedDocIds.size}{' '}
                      {da
                        ? 'dokument(er) valgt — AI vil bruge disse som kontekst'
                        : 'doc(s) selected — AI will use as context'}
                    </p>
                  )}
                </div>
                <Link
                  href={`/domain/${domainId}/case/${selectedCaseId}`}
                  className="inline-flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200"
                >
                  {da ? 'Åbn i fuld visning →' : 'Open in full view →'}
                </Link>
              </>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT — FIXED side-panel, fylder fra topbar til bund */}
      <div
        ref={rightColRef}
        className="fixed right-0 bottom-0 z-30 bg-slate-950 border-l border-slate-700/40 flex flex-col shadow-2xl"
        style={{
          top: `${topOffsetPx}px`,
          width: `${rightWidthPx}px`,
        }}
      >
        {/* Vertical drag-handle on the LEFT edge of the fixed panel */}
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startVerticalResize}
          className="absolute left-0 top-0 bottom-0 w-1.5 -translate-x-full cursor-col-resize bg-slate-800/40 hover:bg-blue-500/40 transition-colors group"
          title={da ? 'Træk til højre/venstre' : 'Drag left/right'}
        >
          <GripVertical
            size={12}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
          />
        </div>

        {/* TOP-RIGHT: AI chat */}
        <div
          className="min-h-0 overflow-hidden flex flex-col bg-slate-900/20"
          style={{ height: `${rightTopPct}%` }}
        >
          <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 shrink-0 flex items-center gap-2">
            <Bot size={13} className="text-purple-400" />
            <p className="text-xs font-semibold text-slate-300">{da ? 'AI-agent' : 'AI agent'}</p>
            {selectedTemplateId && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                {da ? 'Skabelon valgt' : 'Template selected'}
              </span>
            )}
            {selectedDocIds.size > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                {selectedDocIds.size} {da ? 'dok' : 'doc'}
              </span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
            {aiMessages.length === 0 ? (
              <div className="text-xs text-slate-500 space-y-1.5">
                <p className="font-medium text-slate-400">
                  {da ? 'Sådan bruger du AI-agenten' : 'How to use the AI agent'}
                </p>
                <ol className="list-decimal list-inside space-y-1 pl-1">
                  <li>{da ? 'Vælg en skabelon nedenfor' : 'Pick a template below'}</li>
                  <li>
                    {da
                      ? 'Vælg de relevante dokumenter fra sagen (venstre)'
                      : 'Select relevant docs from the case (left)'}
                  </li>
                  <li>
                    {da
                      ? 'Skriv hvad AI\u2019en skal gøre — fx "Udfyld skabelonen baseret på ejerforhold i dokumenterne"'
                      : 'Write what the AI should do — e.g. "Fill the template based on ownership in the documents"'}
                  </li>
                </ol>
                <p className="pt-1.5 text-slate-600">
                  {da
                    ? 'AI\u2019en har adgang til BBR, CVR, ejerforhold og tinglysningsdata via BizzAssist.'
                    : 'The AI has access to BBR, CVR, ownership and tinglysning data via BizzAssist.'}
                </p>
              </div>
            ) : (
              aiMessages.map((m, i) => (
                <div
                  key={i}
                  className={`px-2.5 py-1.5 rounded-lg text-xs ${
                    m.role === 'user'
                      ? 'bg-blue-500/15 text-slate-200 ml-4'
                      : 'bg-slate-800/60 text-slate-200 mr-4'
                  }`}
                >
                  {m.text}
                </div>
              ))
            )}
            {aiError && (
              <div className="px-2.5 py-1.5 rounded-lg text-xs bg-rose-900/30 text-rose-200">
                {aiError}
              </div>
            )}
          </div>
          <div className="shrink-0 border-t border-slate-700/40 p-2 flex gap-2">
            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendAi();
                }
              }}
              rows={2}
              placeholder={da ? 'Skriv hvad AI\u2019en skal gøre…' : 'Write what the AI should do…'}
              className="flex-1 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs resize-none focus:border-blue-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={sendAi}
              disabled={!aiPrompt.trim() || aiBusy}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white text-xs font-medium transition-colors"
            >
              {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              {da ? 'Send' : 'Send'}
            </button>
          </div>
        </div>

        {/* Horizontal divider inside right column */}
        <div
          role="separator"
          aria-orientation="horizontal"
          onMouseDown={startHorizontalResize(
            () => rightColRef.current,
            setRightTopPct,
            STORAGE.rightTop
          )}
          className="group h-1.5 shrink-0 cursor-row-resize bg-slate-800/40 hover:bg-blue-500/40 relative transition-colors"
          title={da ? 'Træk op/ned' : 'Drag up/down'}
        >
          <GripHorizontal
            size={12}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
          />
        </div>

        {/* BOTTOM-RIGHT: Templates */}
        <div
          className="min-h-0 overflow-y-auto bg-slate-900/30"
          style={{ height: `${100 - rightTopPct}%` }}
        >
          <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 sticky top-0 z-10 flex items-center gap-2">
            <FileText size={13} className="text-emerald-400" />
            <p className="text-xs font-semibold text-slate-300">
              {da ? 'Skabeloner' : 'Templates'} · {templates.length}
            </p>
            {selectedTemplateId && (
              <button
                type="button"
                onClick={() => setSelectedTemplateId(null)}
                className="ml-auto text-[10px] text-slate-500 hover:text-white"
              >
                {da ? 'Fjern valg' : 'Clear'}
              </button>
            )}
          </div>
          <div className="p-2 space-y-1">
            {templatesLoading ? (
              <Loader2 size={14} className="animate-spin text-blue-400" />
            ) : templates.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">
                {da ? 'Ingen aktive skabeloner.' : 'No active templates.'}
              </p>
            ) : (
              templates.map((t) => {
                const sel = t.id === selectedTemplateId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(t.id)}
                    className={`w-full text-left flex items-start gap-2 px-2 py-1.5 rounded transition-colors ${
                      sel
                        ? 'bg-blue-500/15 border border-blue-400/40'
                        : 'bg-slate-900/40 border border-slate-700/40 hover:bg-slate-800/60'
                    }`}
                  >
                    <input type="radio" checked={sel} readOnly className="mt-1 shrink-0" />
                    <FileText size={12} className="mt-1 text-emerald-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-white truncate">{t.name}</p>
                      <p className="text-[10px] text-slate-500 uppercase">{t.file_type}</p>
                      {t.description && (
                        <p className="text-[10px] text-slate-400 truncate mt-0.5">
                          {t.description}
                        </p>
                      )}
                    </div>
                    {sel && <Sparkles size={11} className="text-blue-300 mt-1 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>
  );
}
