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
  Pencil,
  Save,
  Building2,
  User,
  Upload,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { DomainCaseSummary } from './DomainCaseList';
import { CustomerSearchPicker, type CustomerLink } from './CustomerSearchPicker';

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

interface CaseDetail {
  id: string;
  name: string;
  client_ref: string | null;
  status: 'open' | 'closed' | 'archived';
  notes: string | null;
  tags: string[];
  client_kind: 'company' | 'person' | null;
  client_cvr: string | null;
  client_person_id: string | null;
  client_name: string | null;
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
  // BIZZ-799 + BIZZ-800 + BIZZ-802: Fetch full case detail (incl. customer
  // link) from /cases/:caseId — same endpoint serves docs, so we can drop
  // the separate /docs call.
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [caseDocs, setCaseDocs] = useState<CaseDocSummary[]>([]);
  const [caseLoading, setCaseLoading] = useState(false);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());

  // BIZZ-799: edit-mode for case metadata. editing=true swaps display
  // widgets for input widgets; Save POSTs a PATCH.
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editClientRef, setEditClientRef] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editStatus, setEditStatus] = useState<'open' | 'closed' | 'archived'>('open');
  const [editTagsInput, setEditTagsInput] = useState('');
  const [editCustomer, setEditCustomer] = useState<CustomerLink | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // BIZZ-800: doc upload state
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const loadCaseDetail = useCallback(async () => {
    if (!selectedCaseId) return;
    setCaseLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}`);
      if (r.ok) {
        const json = (await r.json()) as CaseDetail & { docs?: CaseDocSummary[] };
        setCaseDetail({
          id: json.id,
          name: json.name,
          client_ref: json.client_ref,
          status: json.status,
          notes: json.notes,
          tags: json.tags ?? [],
          client_kind: json.client_kind ?? null,
          client_cvr: json.client_cvr ?? null,
          client_person_id: json.client_person_id ?? null,
          client_name: json.client_name ?? null,
        });
        setCaseDocs(json.docs ?? []);
      } else {
        setCaseDetail(null);
        setCaseDocs([]);
      }
    } catch {
      setCaseDetail(null);
      setCaseDocs([]);
    } finally {
      setCaseLoading(false);
    }
  }, [domainId, selectedCaseId]);

  useEffect(() => {
    void loadCaseDetail();
    setSelectedDocIds(new Set());
    setEditing(false);
  }, [loadCaseDetail]);

  // Seed edit-form when caseDetail loads or user enters edit mode
  useEffect(() => {
    if (!caseDetail) return;
    setEditName(caseDetail.name);
    setEditClientRef(caseDetail.client_ref ?? '');
    setEditNotes(caseDetail.notes ?? '');
    setEditStatus(caseDetail.status);
    setEditTagsInput(caseDetail.tags.join(', '));
    setEditCustomer(
      caseDetail.client_kind
        ? {
            kind: caseDetail.client_kind,
            cvr: caseDetail.client_cvr,
            person_id: caseDetail.client_person_id,
            name: caseDetail.client_name ?? '',
          }
        : null
    );
  }, [caseDetail]);

  // BIZZ-799: PATCH handler
  const saveCase = async () => {
    if (!caseDetail) return;
    if (!editName.trim() || editName.length > 200) {
      setSaveError(da ? 'Sagsnavn skal være 1-200 tegn' : 'Name must be 1-200 chars');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const tags = editTagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        name: editName.trim(),
        client_ref: editClientRef.trim() || null,
        notes: editNotes.trim() || null,
        status: editStatus,
        tags,
        client_kind: editCustomer?.kind ?? null,
        client_cvr: editCustomer?.cvr ?? null,
        client_person_id: editCustomer?.person_id ?? null,
        client_name: editCustomer?.name ?? null,
      };
      const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({ error: 'Ukendt' }));
        setSaveError(j.error ?? (da ? 'Kunne ikke gemme' : 'Save failed'));
        return;
      }
      setEditing(false);
      await loadCaseDetail();
    } finally {
      setSaving(false);
    }
  };

  // BIZZ-800: upload one or more files to the case
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!selectedCaseId || files.length === 0) return;
      setUploadBusy(true);
      setUploadError(null);
      try {
        const newIds: string[] = [];
        for (const f of Array.from(files)) {
          if (f.size > 50 * 1024 * 1024) {
            setUploadError(
              da ? `${f.name} er for stor (max 50 MB)` : `${f.name} is too large (max 50 MB)`
            );
            continue;
          }
          const fd = new FormData();
          fd.append('file', f);
          const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}/docs`, {
            method: 'POST',
            body: fd,
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({ error: 'Ukendt' }));
            setUploadError(j.error ?? (da ? 'Upload fejlede' : 'Upload failed'));
            continue;
          }
          const j = (await r.json()) as { id?: string };
          if (j.id) newIds.push(j.id);
        }
        await loadCaseDetail();
        // Auto-select newly uploaded docs so AI uses them as context
        if (newIds.length > 0) {
          setSelectedDocIds((prev) => {
            const next = new Set(prev);
            for (const id of newIds) next.add(id);
            return next;
          });
        }
      } finally {
        setUploadBusy(false);
      }
    },
    [domainId, selectedCaseId, loadCaseDetail, da]
  );

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

        {/* BOTTOM-LEFT: selected case detail (+ edit + upload) */}
        <div
          className="min-h-0 overflow-y-auto bg-slate-900/20"
          style={{ height: `${100 - leftTopPct}%` }}
        >
          <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 sticky top-0 z-10 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-slate-300 truncate">
              {caseDetail?.name ?? selectedCase?.name ?? (da ? 'Vælg en sag' : 'Select a case')}
            </p>
            {caseDetail && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={da ? 'Rediger sag' : 'Edit case'}
                className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                title={da ? 'Rediger sag' : 'Edit case'}
              >
                <Pencil size={12} />
              </button>
            )}
          </div>
          <div className="p-3 space-y-3">
            {caseLoading && !caseDetail && (
              <Loader2 size={14} className="animate-spin text-blue-400" />
            )}
            {caseDetail && !editing && (
              <>
                {/* BIZZ-802: Customer link badge */}
                {caseDetail.client_kind && caseDetail.client_name && (
                  <div className="flex items-center gap-2 bg-slate-900/60 border border-slate-700/40 rounded-md px-2.5 py-1.5">
                    {caseDetail.client_kind === 'company' ? (
                      <Building2 size={13} className="text-emerald-400 shrink-0" />
                    ) : (
                      <User size={13} className="text-sky-400 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-white truncate">{caseDetail.client_name}</p>
                      <p className="text-[10px] text-slate-500 uppercase">
                        {caseDetail.client_kind === 'company'
                          ? `CVR ${caseDetail.client_cvr}`
                          : `Person · ${caseDetail.client_person_id}`}
                      </p>
                    </div>
                    {caseDetail.client_kind === 'company' && caseDetail.client_cvr && (
                      <Link
                        href={`/dashboard/companies/${caseDetail.client_cvr}`}
                        className="text-[10px] text-blue-300 hover:text-blue-200 shrink-0"
                      >
                        {da ? 'Åbn →' : 'Open →'}
                      </Link>
                    )}
                  </div>
                )}
                <div className="text-xs space-y-1">
                  {caseDetail.client_ref && (
                    <p>
                      <span className="text-slate-500">
                        {da ? 'Klient-reference: ' : 'Client ref: '}
                      </span>
                      <span className="text-slate-200">{caseDetail.client_ref}</span>
                    </p>
                  )}
                  <p>
                    <span className="text-slate-500">{da ? 'Status: ' : 'Status: '}</span>
                    <span className="text-slate-200 capitalize">{caseDetail.status}</span>
                  </p>
                  {caseDetail.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {caseDetail.tags.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 bg-slate-700/40 text-slate-300 text-[10px] rounded"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {caseDetail.notes && (
                    <p className="text-slate-300 whitespace-pre-wrap pt-1.5 text-[11px]">
                      {caseDetail.notes}
                    </p>
                  )}
                </div>

                {/* BIZZ-800: Documents + upload */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">
                      {da ? 'Dokumenter' : 'Documents'} · {caseDocs.length}
                    </p>
                    <label className="cursor-pointer inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors">
                      {uploadBusy ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Upload size={10} />
                      )}
                      {da ? 'Upload' : 'Upload'}
                      <input
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => {
                          if (e.target.files) void uploadFiles(e.target.files);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                  {uploadError && <p className="text-[10px] text-rose-300 mb-1">{uploadError}</p>}
                  {caseDocs.length === 0 ? (
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

            {/* BIZZ-799: Inline edit mode */}
            {caseDetail && editing && (
              <div className="space-y-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {da ? 'Sagsnavn' : 'Case name'}
                  </span>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={200}
                    className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {da ? 'Kunde (valgfri)' : 'Customer (optional)'}
                  </span>
                  <div className="mt-0.5">
                    <CustomerSearchPicker value={editCustomer} onChange={setEditCustomer} compact />
                  </div>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {da ? 'Klient-ref' : 'Client ref'}
                  </span>
                  <input
                    type="text"
                    value={editClientRef}
                    onChange={(e) => setEditClientRef(e.target.value)}
                    className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {da ? 'Status' : 'Status'}
                  </span>
                  <select
                    value={editStatus}
                    onChange={(e) =>
                      setEditStatus(e.target.value as 'open' | 'closed' | 'archived')
                    }
                    className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                  >
                    <option value="open">{da ? 'Åben' : 'Open'}</option>
                    <option value="closed">{da ? 'Lukket' : 'Closed'}</option>
                    <option value="archived">{da ? 'Arkiveret' : 'Archived'}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {da ? 'Tags (komma)' : 'Tags (comma)'}
                  </span>
                  <input
                    type="text"
                    value={editTagsInput}
                    onChange={(e) => setEditTagsInput(e.target.value)}
                    className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {da ? 'Noter' : 'Notes'}
                  </span>
                  <textarea
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    rows={3}
                    className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs resize-y"
                  />
                </label>
                {saveError && <p className="text-[10px] text-rose-300">{saveError}</p>}
                <div className="flex items-center justify-end gap-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setSaveError(null);
                    }}
                    disabled={saving}
                    className="px-2 py-1 text-[11px] text-slate-400 hover:text-white"
                  >
                    {da ? 'Annuller' : 'Cancel'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveCase()}
                    disabled={saving}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white text-[11px] font-medium"
                  >
                    {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                    {da ? 'Gem' : 'Save'}
                  </button>
                </div>
              </div>
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
