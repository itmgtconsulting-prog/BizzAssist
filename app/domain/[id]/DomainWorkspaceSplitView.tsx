/**
 * DomainWorkspaceSplitView — to-panels arbejdsområde inden i Domain/Sager-tab.
 *
 * Efter pivot til global AI Chat (BIZZ-805): Dette panel hoster nu KUN
 * venstre-siden — sager-liste + valgt sag-detail med dokumenter, kunde-link
 * og inline edit. Den tidligere embedded AI-agent og skabelon-vælger er
 * fjernet; brugeren åbner i stedet topbar "AI Chat" for at generere
 * dokumenter. Den globale chat accepterer filer og viser preview i et
 * højre-side panel der skubber resten af skærmen til venstre.
 *
 * Layout:
 *   * TOP: sager-listen (filter: åbne/lukkede/arkiverede osv. styres af parent)
 *   * Resizable horizontal bar
 *   * BOTTOM: valgt sag — metadata, kunde-link, dokumenter (upload + select),
 *     inline edit-mode (blyant-ikon).
 *
 * @module app/domain/[id]/DomainWorkspaceSplitView
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  GripHorizontal,
  Briefcase,
  X,
  Loader2,
  Paperclip,
  Pencil,
  Save,
  Building2,
  User,
  Upload,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { DomainCaseSummary } from './DomainCaseList';
import { CustomerSearchPicker, type CustomerLink } from './CustomerSearchPicker';

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
  /** BIZZ-809: Kort beskrivelse vist som preview på sagskort + editable i detail */
  short_description: string | null;
}

interface Props {
  domainId: string;
  selectedCaseId: string;
  cases: DomainCaseSummary[];
  onSelectCase: (id: string) => void;
  onCloseWorkspace: () => void;
  /**
   * BIZZ-807: Valgfri callback som kaldes når sag ændres (fx via inline-edit
   * af sagsnavn). Parent bruger den til at reloade cases-listen så venstre
   * kolonne afspejler navneændringen øjeblikkeligt.
   */
  onCaseUpdated?: () => void;
}

const STORAGE = {
  topPct: 'bizz-domain-ws-topPct',
};

export function DomainWorkspaceSplitView({
  domainId,
  selectedCaseId,
  cases,
  onSelectCase,
  onCloseWorkspace,
  onCaseUpdated,
}: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [topPct, setTopPct] = useState(40);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const v = Number(window.localStorage.getItem(STORAGE.topPct));
    if (v >= 20 && v <= 80) setTopPct(v);
  }, []);

  const colRef = useRef<HTMLDivElement>(null);

  const startHorizontalResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = colRef.current;
    if (!el) return;
    const onMove = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      const clamped = Math.max(20, Math.min(80, pct));
      setTopPct(clamped);
      window.localStorage.setItem(STORAGE.topPct, String(Math.round(clamped)));
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
  }, []);

  const selectedCase = cases.find((c) => c.id === selectedCaseId) ?? null;

  // ─── Case detail state ──────────────────────────────────────────────────
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [caseDocs, setCaseDocs] = useState<CaseDocSummary[]>([]);
  const [caseLoading, setCaseLoading] = useState(false);

  const [editing, setEditing] = useState(false);
  // BIZZ-807: inline edit-mode for selve sagsnavn — klik på header-titel
  // åbner input uden at skulle ind i fuld edit-form.
  const [inlineEditingName, setInlineEditingName] = useState(false);
  const [inlineNameValue, setInlineNameValue] = useState('');
  const [savingInlineName, setSavingInlineName] = useState(false);
  const [editName, setEditName] = useState('');
  const [editClientRef, setEditClientRef] = useState('');
  const [editNotes, setEditNotes] = useState('');
  // BIZZ-809: kort beskrivelse editable i detail-form
  const [editShortDescription, setEditShortDescription] = useState('');
  const [editStatus, setEditStatus] = useState<'open' | 'closed' | 'archived'>('open');
  const [editTagsInput, setEditTagsInput] = useState('');
  const [editCustomer, setEditCustomer] = useState<CustomerLink | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
          short_description: json.short_description ?? null,
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
    setEditing(false);
  }, [loadCaseDetail]);

  useEffect(() => {
    if (!caseDetail) return;
    setEditName(caseDetail.name);
    setEditClientRef(caseDetail.client_ref ?? '');
    setEditNotes(caseDetail.notes ?? '');
    setEditShortDescription(caseDetail.short_description ?? '');
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
        short_description: editShortDescription.trim() || null,
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
      // BIZZ-807: notify parent så sagsliste afspejler navn/status-ændring
      onCaseUpdated?.();
    } finally {
      setSaving(false);
    }
  };

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!selectedCaseId || files.length === 0) return;
      setUploadBusy(true);
      setUploadError(null);
      try {
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
        }
        await loadCaseDetail();
      } finally {
        setUploadBusy(false);
      }
    },
    [domainId, selectedCaseId, loadCaseDetail, da]
  );

  return (
    <div
      ref={colRef}
      className="flex flex-col border border-slate-700/40 rounded-xl overflow-hidden"
      style={{ height: 'calc(100vh - 280px)', minHeight: 480 }}
    >
      {/* TOP: cases list */}
      <div className="min-h-0 overflow-y-auto bg-slate-900/30" style={{ height: `${topPct}%` }}>
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

      {/* Horizontal divider */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={startHorizontalResize}
        className="group h-1.5 shrink-0 cursor-row-resize bg-slate-800/40 hover:bg-blue-500/40 relative transition-colors"
        title={da ? 'Træk op/ned' : 'Drag up/down'}
      >
        <GripHorizontal
          size={12}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
        />
      </div>

      {/* BOTTOM: selected case detail */}
      <div
        className="min-h-0 overflow-y-auto bg-slate-900/20"
        style={{ height: `${100 - topPct}%` }}
      >
        <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 sticky top-0 z-10 flex items-center justify-between gap-2">
          {/* BIZZ-807: Sagsnavn er klik-til-edit. Klik på tekst eller Pencil
              starter inline-edit; Enter/Blur gemmer; Escape cancel. */}
          {caseDetail && inlineEditingName ? (
            <input
              type="text"
              autoFocus
              value={inlineNameValue}
              onChange={(e) => setInlineNameValue(e.target.value)}
              maxLength={200}
              disabled={savingInlineName}
              onKeyDown={async (e) => {
                if (e.key === 'Escape') {
                  setInlineEditingName(false);
                  setInlineNameValue(caseDetail.name);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              onBlur={async () => {
                const next = inlineNameValue.trim();
                if (!next || next.length > 200 || next === caseDetail.name) {
                  setInlineEditingName(false);
                  setInlineNameValue(caseDetail.name);
                  return;
                }
                setSavingInlineName(true);
                try {
                  const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: next }),
                  });
                  if (r.ok) {
                    // Reload så sagsliste + detail synker
                    await loadCaseDetail();
                    onCaseUpdated?.();
                  }
                } finally {
                  setSavingInlineName(false);
                  setInlineEditingName(false);
                }
              }}
              className="flex-1 min-w-0 text-xs font-semibold bg-slate-900 border border-blue-500/40 rounded px-2 py-1 text-white focus:outline-none focus:border-blue-400"
              aria-label={da ? 'Sagsnavn' : 'Case name'}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!caseDetail) return;
                setInlineNameValue(caseDetail.name);
                setInlineEditingName(true);
              }}
              disabled={!caseDetail}
              className="flex-1 min-w-0 text-xs font-semibold text-slate-300 hover:text-white text-left truncate disabled:cursor-default disabled:hover:text-slate-300"
              title={
                caseDetail
                  ? da
                    ? 'Klik for at redigere sagsnavn'
                    : 'Click to edit case name'
                  : undefined
              }
            >
              {caseDetail?.name ?? selectedCase?.name ?? (da ? 'Vælg en sag' : 'Select a case')}
            </button>
          )}
          {caseDetail && !editing && !inlineEditingName && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={da ? 'Rediger sag (alle felter)' : 'Edit case (all fields)'}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
              title={da ? 'Rediger alle felter' : 'Edit all fields'}
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
                    {caseDocs.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800/40"
                      >
                        <Paperclip size={11} className="text-slate-400 shrink-0" />
                        <span className="text-xs text-slate-200 truncate">{d.name}</span>
                      </li>
                    ))}
                  </ul>
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
                  onChange={(e) => setEditStatus(e.target.value as 'open' | 'closed' | 'archived')}
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
              {/* BIZZ-809: Kort beskrivelse (max 200 tegn). Vises på
                  sagskort i listen. Char-counter i label. */}
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center justify-between">
                  <span>{da ? 'Kort beskrivelse' : 'Short description'}</span>
                  <span className="text-slate-600 tabular-nums">
                    {editShortDescription.length}/200
                  </span>
                </span>
                <textarea
                  value={editShortDescription}
                  onChange={(e) => setEditShortDescription(e.target.value.slice(0, 200))}
                  rows={2}
                  maxLength={200}
                  placeholder={
                    da
                      ? '2-3 linjer preview vist på sagskort'
                      : '2-3 lines preview shown on case cards'
                  }
                  className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs resize-none"
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
  );
}
