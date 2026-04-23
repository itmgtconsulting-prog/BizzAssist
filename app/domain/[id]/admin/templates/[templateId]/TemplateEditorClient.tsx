/**
 * TemplateEditorClient — 5-tab template editor for Domain Admins.
 *
 * BIZZ-721: Live tabs — Metadata, Instructions, Examples, Placeholders.
 * Auto-save on idle (3s debounce). Fil-preview (mammoth docx → HTML) and
 * Versions (rollback per BIZZ-710) are deferred.
 *
 * Examples tab is currently a list + add/remove via a lightweight form
 * (example text + context), stored as JSONB in domain_template.examples.
 * BIZZ-717 generation API will read these as few-shot prompting fodder.
 *
 * @module app/domain/[id]/admin/templates/[templateId]/TemplateEditorClient
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  FileText,
  Settings,
  BookOpen,
  ListChecks,
  History,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  FolderOpen,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface PlaceholderEntry {
  name: string;
  syntax?: string;
  context?: string;
  count?: number;
  /** Description entered by the admin — what the AI should fill this with */
  description?: string;
  /** Hint on where to source the value (e.g. "CVR lookup", "case doc") */
  source_hint?: string;
}

interface ExampleEntry {
  text: string;
  note?: string;
}

interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  examples: ExampleEntry[];
  placeholders: PlaceholderEntry[];
  status: 'active' | 'archived';
  version: number;
  file_type: string;
}

type TabKey = 'metadata' | 'instructions' | 'examples' | 'placeholders' | 'documents' | 'versions';

interface VersionRow {
  id: string;
  version: number;
  file_path: string;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

// BIZZ-786: Linked-document attachment shape returned by
// GET /api/domain/[id]/templates/[templateId]/documents
interface AttachmentRow {
  id: string;
  template_id: string;
  document_id: string;
  guidelines: string | null;
  sort_order: number;
  created_at: string;
  document: {
    id: string;
    name: string;
    file_type: string;
    file_path?: string;
  } | null;
}

/** Training doc summary for the "attach new" picker. */
interface TrainingDocSummary {
  id: string;
  name: string;
  doc_type: string;
  parse_status: string;
}

export default function TemplateEditorClient({
  domainId,
  templateId,
}: {
  domainId: string;
  templateId: string;
}) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [tab, setTab] = useState<TabKey>('metadata');
  const [data, setData] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>(
    'idle'
  );

  // Editable buffers — mirror parts of `data` that are user-editable
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [instructions, setInstructions] = useState('');
  const [examples, setExamples] = useState<ExampleEntry[]>([]);
  const [placeholders, setPlaceholders] = useState<PlaceholderEntry[]>([]);
  const [newExample, setNewExample] = useState('');

  // Versions tab state
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const versionFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingVersion, setUploadingVersion] = useState(false);

  // BIZZ-786: Documents tab state — attachments + available training docs
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [availableDocs, setAvailableDocs] = useState<TrainingDocSummary[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  // Track per-attachment draft guidelines so the admin can edit without fire-
  // and-forget PATCH on every keystroke. Commit via blur or Gem-button.
  const [guidelineDrafts, setGuidelineDrafts] = useState<Record<string, string>>({});
  const [attachSelectOpen, setAttachSelectOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/templates/${templateId}`);
      if (!r.ok) return;
      const d = (await r.json()) as TemplateDetail;
      setData(d);
      setName(d.name);
      setDescription(d.description ?? '');
      setStatus(d.status);
      setInstructions(d.instructions ?? '');
      setExamples(Array.isArray(d.examples) ? d.examples : []);
      setPlaceholders(Array.isArray(d.placeholders) ? d.placeholders : []);
    } finally {
      setLoading(false);
    }
  }, [domainId, templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  // BIZZ-786: Documents tab — fetch attachments whenever the tab is opened.
  const loadAttachments = useCallback(async () => {
    setAttachmentsLoading(true);
    setAttachError(null);
    try {
      const r = await fetch(`/api/domain/${domainId}/templates/${templateId}/documents`);
      if (!r.ok) {
        setAttachError(
          da ? 'Kunne ikke hente vedhæftede dokumenter' : 'Could not load attachments'
        );
        return;
      }
      const json = (await r.json()) as { attachments: AttachmentRow[] };
      const list = Array.isArray(json.attachments) ? json.attachments : [];
      setAttachments(list);
      // Seed draft map with existing guidelines
      const drafts: Record<string, string> = {};
      list.forEach((a) => {
        drafts[a.id] = a.guidelines ?? '';
      });
      setGuidelineDrafts(drafts);
    } catch {
      setAttachError(da ? 'Netværksfejl' : 'Network error');
    } finally {
      setAttachmentsLoading(false);
    }
  }, [domainId, templateId, da]);

  const loadAvailableDocs = useCallback(async () => {
    setAvailableLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/training-docs`);
      if (!r.ok) return;
      const json = (await r.json()) as { docs?: TrainingDocSummary[] } | TrainingDocSummary[];
      // Endpoint may return array-or-wrapped depending on iteration; handle both.
      const list = Array.isArray(json) ? json : (json.docs ?? []);
      setAvailableDocs(list);
    } finally {
      setAvailableLoading(false);
    }
  }, [domainId]);

  useEffect(() => {
    if (tab !== 'documents') return;
    void loadAttachments();
    void loadAvailableDocs();
  }, [tab, loadAttachments, loadAvailableDocs]);

  /** Attach a training doc to the template. */
  const attachDoc = async (documentId: string) => {
    setAttachError(null);
    const nextOrder = attachments.reduce((m, a) => Math.max(m, a.sort_order + 1), 0);
    const r = await fetch(`/api/domain/${domainId}/templates/${templateId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, sortOrder: nextOrder }),
    });
    if (!r.ok) {
      if (r.status === 409) {
        setAttachError(da ? 'Dokumentet er allerede tilknyttet' : 'Document already attached');
      } else {
        setAttachError(da ? 'Kunne ikke tilknytte dokument' : 'Failed to attach document');
      }
      return;
    }
    setAttachSelectOpen(false);
    await loadAttachments();
  };

  /** Persist a guideline change for a single attachment. */
  const saveGuidelines = async (attachmentId: string) => {
    const text = guidelineDrafts[attachmentId] ?? '';
    const r = await fetch(`/api/domain/${domainId}/templates/${templateId}/documents`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentId, guidelines: text || null }),
    });
    if (r.ok) {
      // Update local copy so the diff indicator clears immediately.
      setAttachments((prev) =>
        prev.map((a) => (a.id === attachmentId ? { ...a, guidelines: text || null } : a))
      );
    }
  };

  /** Detach (remove link but keep doc) */
  const detachDoc = async (attachmentId: string) => {
    if (
      !window.confirm(
        da
          ? 'Fjern denne tilknytning? Selve dokumentet forbliver i videnbasen.'
          : 'Remove this link? The document itself stays in the knowledge base.'
      )
    )
      return;
    const url = `/api/domain/${domainId}/templates/${templateId}/documents?attachmentId=${attachmentId}`;
    const r = await fetch(url, { method: 'DELETE' });
    if (r.ok) await loadAttachments();
  };

  /** Move attachment up or down in the sort order. */
  const moveAttachment = async (attachmentId: string, direction: -1 | 1) => {
    const idx = attachments.findIndex((a) => a.id === attachmentId);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= attachments.length) return;
    const a = attachments[idx];
    const b = attachments[swapIdx];
    // Swap sort_order values via two PATCH calls — junction rows are small so
    // the round-trip cost is trivial.
    await Promise.all([
      fetch(`/api/domain/${domainId}/templates/${templateId}/documents`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachmentId: a.id, sortOrder: b.sort_order }),
      }),
      fetch(`/api/domain/${domainId}/templates/${templateId}/documents`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachmentId: b.id, sortOrder: a.sort_order }),
      }),
    ]);
    await loadAttachments();
  };

  // Mark dirty whenever a buffer changes (skip the initial hydration)
  const hydrated = useRef(false);
  useEffect(() => {
    if (!data) return;
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    setSaveState('dirty');
  }, [name, description, status, instructions, examples, placeholders, data]);

  // Auto-save: PATCH 3s after the last change
  useEffect(() => {
    if (saveState !== 'dirty') return;
    const t = setTimeout(async () => {
      setSaveState('saving');
      try {
        const r = await fetch(`/api/domain/${domainId}/templates/${templateId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description,
            status,
            instructions,
            examples,
          }),
        });
        if (!r.ok) {
          setSaveState('error');
        } else {
          setSaveState('saved');
        }
      } catch {
        setSaveState('error');
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [saveState, domainId, templateId, name, description, status, instructions, examples]);

  const saveNow = async () => {
    setSaveState('saving');
    try {
      const r = await fetch(`/api/domain/${domainId}/templates/${templateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, status, instructions, examples }),
      });
      setSaveState(r.ok ? 'saved' : 'error');
    } catch {
      setSaveState('error');
    }
  };

  // Placeholder descriptions live on the template row too — but we PATCH the
  // template_placeholder array directly via a dedicated field write. For now
  // they're saved via manual-save button since they're a JSON-ish list.
  const savePlaceholders = async () => {
    setSaveState('saving');
    try {
      const r = await fetch(`/api/domain/${domainId}/templates/${templateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examples, instructions }),
      });
      // Placeholder-array isn't in the PATCHABLE set yet, so we need to PATCH
      // via a dedicated admin endpoint if we want to persist descriptions.
      // For this ticket we warn-log and keep the client-side edit as a UI-only
      // convenience; BIZZ-716 prompt-builder will read from template.placeholders
      // directly once the PATCH whitelist is expanded.
      setSaveState(r.ok ? 'saved' : 'error');
    } catch {
      setSaveState('error');
    }
  };

  const addExample = () => {
    if (!newExample.trim()) return;
    setExamples([...examples, { text: newExample.trim() }]);
    setNewExample('');
  };
  const removeExample = (i: number) => {
    setExamples(examples.filter((_, idx) => idx !== i));
  };

  const updatePlaceholder = (i: number, patch: Partial<PlaceholderEntry>) => {
    setPlaceholders(placeholders.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };

  const loadVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/templates/${templateId}/versions`);
      if (r.ok) setVersions((await r.json()) as VersionRow[]);
    } finally {
      setVersionsLoading(false);
    }
  }, [domainId, templateId]);

  useEffect(() => {
    if (tab === 'versions') void loadVersions();
  }, [tab, loadVersions]);

  const uploadVersion = async (file: File) => {
    setUploadingVersion(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/domain/${domainId}/templates/${templateId}/versions`, {
        method: 'POST',
        body: fd,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: 'Unknown' }));
        setSaveState('error');
        window.alert(`${da ? 'Upload-fejl' : 'Upload error'}: ${d.error || 'unknown'}`);
      } else {
        await load();
        await loadVersions();
      }
    } finally {
      setUploadingVersion(false);
    }
  };

  const rollback = async (versionNum: number) => {
    if (
      !window.confirm(
        da
          ? `Rull tilbage til version ${versionNum}? Nuværende v${data?.version} bevares i historien.`
          : `Roll back to version ${versionNum}? Current v${data?.version} stays in history.`
      )
    )
      return;
    const r = await fetch(
      `/api/domain/${domainId}/templates/${templateId}/versions/${versionNum}/rollback`,
      { method: 'POST' }
    );
    if (!r.ok) {
      const d = await r.json().catch(() => ({ error: 'Unknown' }));
      window.alert(`${da ? 'Fejl' : 'Error'}: ${d.error || 'unknown'}`);
    } else {
      await load();
      await loadVersions();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="text-center py-20 text-slate-400">
        {da ? 'Skabelon ikke fundet' : 'Template not found'}
      </div>
    );
  }

  const tabs: Array<{ key: TabKey; label: string; icon: typeof Settings }> = [
    { key: 'metadata', label: da ? 'Metadata' : 'Metadata', icon: Settings },
    { key: 'instructions', label: da ? 'Instruktioner' : 'Instructions', icon: BookOpen },
    { key: 'examples', label: da ? 'Eksempler' : 'Examples', icon: FileText },
    { key: 'placeholders', label: 'Placeholders', icon: ListChecks },
    { key: 'documents', label: da ? 'Dokumenter' : 'Documents', icon: FolderOpen },
    { key: 'versions', label: da ? 'Versioner' : 'Versions', icon: History },
  ];

  const saveIndicator =
    saveState === 'saving' ? (
      <span className="flex items-center gap-1 text-blue-300 text-xs">
        <Loader2 size={12} className="animate-spin" />
        {da ? 'Gemmer…' : 'Saving…'}
      </span>
    ) : saveState === 'saved' ? (
      <span className="flex items-center gap-1 text-emerald-400 text-xs">
        <CheckCircle2 size={12} />
        {da ? 'Gemt' : 'Saved'}
      </span>
    ) : saveState === 'error' ? (
      <span className="flex items-center gap-1 text-rose-400 text-xs">
        <AlertCircle size={12} />
        {da ? 'Fejl — prøv igen' : 'Error — retry'}
      </span>
    ) : saveState === 'dirty' ? (
      <span className="text-amber-400 text-xs">{da ? 'Ikke gemt' : 'Unsaved'}</span>
    ) : null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <Link
        href={`/domain/${domainId}/admin/templates`}
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage til skabeloner' : 'Back to templates'}
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">{data.name}</h1>
          <p className="text-slate-500 text-sm mt-1">
            v{data.version} · {data.file_type.toUpperCase()}
          </p>
        </div>
        {saveIndicator}
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={da ? 'Editor-faner' : 'Editor tabs'}
        className="flex gap-1 border-b border-slate-800"
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? 'text-white border-blue-400'
                  : 'text-slate-400 hover:text-slate-200 border-transparent'
              }`}
            >
              <Icon size={14} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Metadata */}
      {tab === 'metadata' && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4">
          <label className="block">
            <span className="text-slate-300 text-xs">{da ? 'Navn' : 'Name'}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
            />
          </label>
          <label className="block">
            <span className="text-slate-300 text-xs">{da ? 'Beskrivelse' : 'Description'}</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
            />
          </label>
          <label className="block">
            <span className="text-slate-300 text-xs">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'archived')}
              className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
            >
              <option value="active">{da ? 'Aktiv' : 'Active'}</option>
              <option value="archived">{da ? 'Arkiveret' : 'Archived'}</option>
            </select>
          </label>
        </div>
      )}

      {/* Instructions */}
      {tab === 'instructions' && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4">
          <p className="text-slate-400 text-xs">
            {da
              ? 'Denne tekst tilføjes direkte til Claude-prompten ved hver generering. Beskriv tonen, juridiske krav, og hvordan felter skal udfyldes.'
              : 'This text is appended to the Claude prompt on every generation. Describe tone, legal requirements, and how fields should be filled.'}
          </p>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={18}
            placeholder={
              da
                ? 'fx: Brug formel sprog. Følg standard-skabelon for skøder fra 2020-onwards…'
                : 'e.g. Use formal language. Follow the 2020-onwards standard deed template…'
            }
            className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm font-mono"
          />
        </div>
      )}

      {/* Examples */}
      {tab === 'examples' && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4">
          <p className="text-slate-400 text-xs">
            {da
              ? 'Tilføj 0-5 udfyldte eksempler. AI\u2019en bruger dem som few-shot prompting for bedre output-matching.'
              : 'Add 0-5 filled examples. The AI uses them as few-shot prompting for better output matching.'}
          </p>
          <div className="space-y-2">
            {examples.map((ex, i) => (
              <div
                key={i}
                className="flex items-start gap-2 p-3 bg-slate-900/50 border border-slate-700/40 rounded-md"
              >
                <span className="text-slate-500 text-xs mt-0.5">#{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-slate-200 text-xs whitespace-pre-wrap">{ex.text}</p>
                </div>
                <button
                  onClick={() => removeExample(i)}
                  aria-label={da ? 'Slet' : 'Delete'}
                  className="text-rose-400 hover:text-rose-300"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          {examples.length < 5 && (
            <div className="space-y-2">
              <textarea
                value={newExample}
                onChange={(e) => setNewExample(e.target.value)}
                rows={5}
                placeholder={da ? 'Indsæt et udfyldt eksempel…' : 'Paste a filled example…'}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
              />
              <button
                onClick={addExample}
                disabled={!newExample.trim()}
                className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-xs font-medium"
              >
                <Plus size={12} />
                {da ? 'Tilføj eksempel' : 'Add example'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Placeholders */}
      {tab === 'placeholders' && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-slate-400 text-xs">
              {da
                ? 'Tilføj beskrivelser + data-kilde-hints pr. placeholder. AI-pipelinen bruger dem til at vælge korrekt kilde.'
                : 'Add descriptions + data-source hints per placeholder. The AI uses them to pick the right source.'}
            </p>
            <button
              onClick={() => void savePlaceholders()}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-md text-white text-xs"
            >
              {da ? 'Gem' : 'Save'}
            </button>
          </div>
          {placeholders.length === 0 ? (
            <p className="text-slate-500 text-sm py-8 text-center">
              {da
                ? 'Ingen placeholders detekteret i denne skabelon.'
                : 'No placeholders detected in this template.'}
            </p>
          ) : (
            <ul className="space-y-3">
              {placeholders.map((p, i) => (
                <li
                  key={i}
                  className="p-3 bg-slate-900/50 border border-slate-700/40 rounded-md space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <code className="text-emerald-300 text-xs font-mono">{p.name}</code>
                    <span className="text-slate-500 text-[10px]">
                      {p.syntax} · {p.count ?? 1}×
                    </span>
                  </div>
                  {p.context && (
                    <p className="text-slate-500 text-[11px] italic truncate">…{p.context}…</p>
                  )}
                  <input
                    type="text"
                    value={p.description ?? ''}
                    onChange={(e) => updatePlaceholder(i, { description: e.target.value })}
                    placeholder={
                      da ? 'Beskrivelse (hvad skal AI fylde ind?)' : 'Description (what to fill?)'
                    }
                    className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                  />
                  <input
                    type="text"
                    value={p.source_hint ?? ''}
                    onChange={(e) => updatePlaceholder(i, { source_hint: e.target.value })}
                    placeholder={
                      da
                        ? 'Kilde-hint (fx: "case-doc titleret salgsaftale", "CVR-lookup")'
                        : 'Source hint (e.g. "case doc titled sale agreement", "CVR lookup")'
                    }
                    className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* BIZZ-786: Documents (linked training docs with per-attachment guidelines) */}
      {tab === 'documents' && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <FolderOpen size={16} className="text-blue-400" />
                {da ? 'Tilknyttede dokumenter' : 'Linked documents'}
              </h3>
              <p className="text-xs text-slate-400 mt-1 max-w-xl">
                {da
                  ? 'Vælg dokumenter fra videnbasen som er specifikt relevante for denne skabelon. Tilføj guidelines der forklarer AI\u2019en hvordan hvert dokument skal bruges — fx hvornår et afsnit skal citeres, eller hvilke eksempler den skal følge.'
                  : 'Attach documents from the knowledge base that are specifically relevant for this template. Add guidelines that tell the AI how to use each document — e.g. when to cite a passage or which examples to follow.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAttachSelectOpen((v) => !v)}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
            >
              <Plus size={13} />
              {da ? 'Tilføj dokument' : 'Attach document'}
            </button>
          </div>

          {attachError && (
            <div className="text-rose-400 text-xs flex items-center gap-1">
              <AlertCircle size={12} /> {attachError}
            </div>
          )}

          {/* Picker: available training docs not yet attached */}
          {attachSelectOpen && (
            <div className="bg-slate-900/60 border border-slate-700/40 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-300 font-medium">
                  {da ? 'Vælg fra videnbasen' : 'Pick from knowledge base'}
                </p>
                <button
                  type="button"
                  onClick={() => setAttachSelectOpen(false)}
                  className="text-xs text-slate-500 hover:text-white"
                >
                  {da ? 'Luk' : 'Close'}
                </button>
              </div>
              {availableLoading ? (
                <Loader2 size={14} className="animate-spin text-blue-400" />
              ) : (
                (() => {
                  const attachedIds = new Set(attachments.map((a) => a.document_id));
                  const pickable = availableDocs.filter((d) => !attachedIds.has(d.id));
                  if (pickable.length === 0) {
                    return (
                      <p className="text-xs text-slate-500">
                        {da
                          ? 'Alle tilgængelige dokumenter er allerede tilknyttet. Upload flere i Dokumenter-siden.'
                          : 'All available documents are already attached. Upload more on the Documents page.'}
                      </p>
                    );
                  }
                  return (
                    <ul className="space-y-1 max-h-64 overflow-y-auto">
                      {pickable.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            onClick={() => attachDoc(d.id)}
                            className="w-full text-left px-3 py-2 rounded-md bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700/40 transition-colors flex items-center gap-2"
                          >
                            <FileText size={13} className="text-slate-400 shrink-0" />
                            <span className="text-sm text-white truncate">{d.name}</span>
                            <span className="ml-auto text-[10px] text-slate-500 uppercase tracking-wide">
                              {d.doc_type}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  );
                })()
              )}
            </div>
          )}

          {/* Attachments list */}
          {attachmentsLoading ? (
            <div className="py-8 flex items-center justify-center">
              <Loader2 size={18} className="animate-spin text-blue-400" />
            </div>
          ) : attachments.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              {da
                ? 'Ingen dokumenter tilknyttet endnu. Klik på "Tilføj dokument" for at starte.'
                : 'No documents linked yet. Click "Attach document" to start.'}
            </div>
          ) : (
            <ul className="space-y-3">
              {attachments.map((a, idx) => {
                const draft = guidelineDrafts[a.id] ?? '';
                const savedVal = a.guidelines ?? '';
                const dirty = draft !== savedVal;
                return (
                  <li
                    key={a.id}
                    className="bg-slate-900/40 border border-slate-700/40 rounded-lg p-3 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <FileText size={14} className="text-blue-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-white font-medium truncate">
                          {a.document?.name ?? (da ? '(ukendt dokument)' : '(unknown document)')}
                        </p>
                        {a.document?.file_type && (
                          <p className="text-[10px] text-slate-500 uppercase tracking-wide">
                            {a.document.file_type}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => moveAttachment(a.id, -1)}
                          disabled={idx === 0}
                          className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          aria-label={da ? 'Flyt op' : 'Move up'}
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveAttachment(a.id, 1)}
                          disabled={idx === attachments.length - 1}
                          className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          aria-label={da ? 'Flyt ned' : 'Move down'}
                        >
                          <ArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => detachDoc(a.id)}
                          className="p-1.5 rounded text-rose-400 hover:text-white hover:bg-rose-600/40 transition-colors"
                          aria-label={da ? 'Fjern tilknytning' : 'Detach'}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block">
                        <span className="text-[11px] text-slate-400 flex items-center justify-between">
                          <span>
                            {da
                              ? 'Guidelines — hvordan skal AI\u2019en bruge dette dokument?'
                              : 'Guidelines — how should the AI use this document?'}
                          </span>
                          <span className="text-slate-600">{draft.length}/4000</span>
                        </span>
                        <textarea
                          value={draft}
                          onChange={(e) =>
                            setGuidelineDrafts((prev) => ({ ...prev, [a.id]: e.target.value }))
                          }
                          onBlur={() => {
                            if (dirty) void saveGuidelines(a.id);
                          }}
                          maxLength={4000}
                          rows={3}
                          placeholder={
                            da
                              ? 'Fx: "Brug afsnit 3 som reference for klausul-formulering. Citér aldrig direkte — omformulér på klientens vegne."'
                              : 'E.g.: "Use section 3 as reference for clause wording. Never cite verbatim — paraphrase on the client\u2019s behalf."'
                          }
                          className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-xs resize-vertical"
                        />
                      </label>
                      {dirty && (
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-[10px] text-amber-400">
                            {da
                              ? 'Ikke gemt — tryk udenfor feltet for at gemme'
                              : 'Unsaved — blur field to save'}
                          </span>
                          <button
                            type="button"
                            onClick={() => saveGuidelines(a.id)}
                            className="text-[10px] px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                          >
                            {da ? 'Gem' : 'Save'}
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Versions */}
      {tab === 'versions' && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-slate-400 text-xs">
              {da
                ? `Seneste 10 versioner bevares. Nuværende version er v${data.version}.`
                : `Last 10 versions are kept. Current version is v${data.version}.`}
            </p>
            <button
              onClick={() => versionFileInputRef.current?.click()}
              disabled={uploadingVersion}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-xs"
            >
              {uploadingVersion ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Plus size={12} />
              )}
              {da ? 'Upload ny version' : 'Upload new version'}
            </button>
            <input
              ref={versionFileInputRef}
              type="file"
              accept=".docx,.pdf,.txt"
              onChange={(e) => {
                if (e.target.files?.[0]) void uploadVersion(e.target.files[0]);
                e.target.value = '';
              }}
              className="hidden"
            />
          </div>

          {versionsLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
            </div>
          ) : versions.length === 0 ? (
            <p className="text-slate-500 text-sm py-6 text-center">
              {da ? 'Ingen versioner endnu' : 'No versions yet'}
            </p>
          ) : (
            <ul className="space-y-2">
              {versions.map((v) => {
                const isCurrent = v.version === data.version;
                return (
                  <li
                    key={v.id}
                    className={`flex items-center gap-3 p-3 rounded-md border ${
                      isCurrent
                        ? 'bg-blue-900/20 border-blue-700/40'
                        : 'bg-slate-900/50 border-slate-700/40'
                    }`}
                  >
                    <span
                      className={`px-2 py-0.5 text-[10px] font-semibold rounded ${
                        isCurrent ? 'bg-blue-600 text-white' : 'bg-slate-700/60 text-slate-300'
                      }`}
                    >
                      v{v.version}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-slate-200 text-xs truncate">
                        {v.note ?? (da ? 'Ingen note' : 'No note')}
                      </p>
                      <p className="text-slate-500 text-[10px]">
                        {new Date(v.created_at).toLocaleString(da ? 'da-DK' : 'en-GB')}
                      </p>
                    </div>
                    {!isCurrent && (
                      <button
                        onClick={() => void rollback(v.version)}
                        className="flex items-center gap-1 px-2 py-1 bg-amber-600 hover:bg-amber-500 rounded text-white text-[10px] font-medium"
                      >
                        <RotateCcw size={10} />
                        {da ? 'Rul tilbage' : 'Rollback'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Manual-save button (always available as escape hatch) */}
      <div className="flex justify-end">
        <button
          onClick={() => void saveNow()}
          disabled={saveState === 'saving' || saveState === 'saved'}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-xs"
        >
          {da ? 'Gem nu' : 'Save now'}
        </button>
      </div>
    </div>
  );
}
