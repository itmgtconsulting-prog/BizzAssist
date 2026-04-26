/**
 * TemplateDocumentsPanel — right-hand window inside the template editor
 * split-view.
 *
 * BIZZ-787: Documents for AI context live here — tightly coupled to a single
 * template. The panel lets the domain admin:
 *   * attach existing training docs from the knowledge base
 *   * upload NEW docs directly (uploaded to domain_training_doc and
 *     auto-attached to this template in one step)
 *   * write per-attachment guidelines telling the AI how to use each doc
 *   * reorder via up/down buttons + detach via trash
 *
 * The panel is fully self-contained — TemplateEditorClient knows nothing
 * about it. The parent page lays them out side-by-side with a resizable
 * divider.
 *
 * @module app/domain/[id]/admin/templates/[templateId]/TemplateDocumentsPanel
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FolderOpen,
  FileText,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Upload,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

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
    file_path: string | null;
  } | null;
}

/** BIZZ-799: Afled file-type fra file_path-endelsen. */
function extFromPath(path: string | null | undefined): string {
  if (!path) return '';
  return path.split('.').pop()?.toLowerCase() ?? '';
}

interface TrainingDocSummary {
  id: string;
  name: string;
  doc_type: string;
  parse_status: string;
}

interface Props {
  domainId: string;
  templateId: string;
}

export function TemplateDocumentsPanel({ domainId, templateId }: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(true);
  const [availableDocs, setAvailableDocs] = useState<TrainingDocSummary[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [guidelineDrafts, setGuidelineDrafts] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAttachments = useCallback(async () => {
    setAttachmentsLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/domain/${domainId}/templates/${templateId}/documents`);
      if (!r.ok) {
        // BIZZ-793: Skjul GET-fejl og vis empty-state i stedet — fejl-banner
        // gav misvisende indtryk af at noget var gaaet galt naar skabelonen
        // bare ikke havde nogen dokumenter endnu. Reale errors (upload/attach)
        // bliver stadig vist via setError i action-handlers nedenfor.
        setAttachments([]);
        setGuidelineDrafts({});
        return;
      }
      const json = (await r.json()) as { attachments: AttachmentRow[] };
      const list = Array.isArray(json.attachments) ? json.attachments : [];
      setAttachments(list);
      const drafts: Record<string, string> = {};
      list.forEach((a) => {
        drafts[a.id] = a.guidelines ?? '';
      });
      setGuidelineDrafts(drafts);
    } catch {
      // BIZZ-793: Samme for netvaerksfejl — behandl som empty state.
      setAttachments([]);
      setGuidelineDrafts({});
    } finally {
      setAttachmentsLoading(false);
    }
  }, [domainId, templateId]);

  const loadAvailableDocs = useCallback(async () => {
    setAvailableLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/training-docs`);
      if (!r.ok) return;
      const json = (await r.json()) as { docs?: TrainingDocSummary[] } | TrainingDocSummary[];
      const list = Array.isArray(json) ? json : (json.docs ?? []);
      setAvailableDocs(list);
    } finally {
      setAvailableLoading(false);
    }
  }, [domainId]);

  useEffect(() => {
    void loadAttachments();
  }, [loadAttachments]);

  const attachDoc = async (documentId: string) => {
    setError(null);
    const nextOrder = attachments.reduce((m, a) => Math.max(m, a.sort_order + 1), 0);
    const r = await fetch(`/api/domain/${domainId}/templates/${templateId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, sortOrder: nextOrder }),
    });
    if (!r.ok) {
      if (r.status === 409) {
        setError(da ? 'Allerede tilknyttet' : 'Already attached');
      } else {
        setError(da ? 'Kunne ikke tilknytte' : 'Failed to attach');
      }
      return;
    }
    setPickerOpen(false);
    await loadAttachments();
  };

  const saveGuidelines = async (attachmentId: string) => {
    const text = guidelineDrafts[attachmentId] ?? '';
    const r = await fetch(`/api/domain/${domainId}/templates/${templateId}/documents`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachmentId, guidelines: text || null }),
    });
    if (r.ok) {
      setAttachments((prev) =>
        prev.map((a) => (a.id === attachmentId ? { ...a, guidelines: text || null } : a))
      );
    }
  };

  const detachDoc = async (attachmentId: string) => {
    if (
      !window.confirm(
        da
          ? 'Fjern tilknytning? Dokumentet bevares i videnbasen.'
          : 'Remove link? The document stays in the knowledge base.'
      )
    )
      return;
    const url = `/api/domain/${domainId}/templates/${templateId}/documents?attachmentId=${attachmentId}`;
    const r = await fetch(url, { method: 'DELETE' });
    if (r.ok) await loadAttachments();
  };

  const moveAttachment = async (attachmentId: string, direction: -1 | 1) => {
    const idx = attachments.findIndex((a) => a.id === attachmentId);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= attachments.length) return;
    const a = attachments[idx];
    const b = attachments[swapIdx];
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

  /** Upload a new training doc and auto-attach to this template in one flow. */
  const handleUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      // Step 1 — upload to the domain's training-doc store.
      const form = new FormData();
      form.append('file', file);
      form.append('name', file.name);
      // Default type "reference" — admin can later change via training-doc detail.
      form.append('doc_type', 'reference');
      const upRes = await fetch(`/api/domain/${domainId}/training-docs`, {
        method: 'POST',
        body: form,
      });
      if (!upRes.ok) {
        setError(da ? 'Upload fejlede' : 'Upload failed');
        return;
      }
      const uploaded = (await upRes.json()) as { id?: string; doc?: { id: string } };
      const newDocId = uploaded.id ?? uploaded.doc?.id;
      if (!newDocId) {
        setError(da ? 'Upload returnerede intet dokument-id' : 'Upload returned no doc id');
        return;
      }
      // Step 2 — attach the new doc to this template.
      await attachDoc(newDocId);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleUpload(f);
  };

  return (
    <div className="h-full flex flex-col bg-slate-900/30">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700/40 bg-slate-900/50 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <FolderOpen size={15} className="text-blue-400 shrink-0" />
            {da ? 'Tilknyttede dokumenter' : 'Linked documents'}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5 truncate">
            {da
              ? 'Baggrundsviden AI bruger til denne skabelon'
              : 'Background knowledge the AI uses for this template'}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            // BIZZ-788: accept alle Claude-readable formater.
            accept=".docx,.xlsx,.xlsm,.xls,.pptx,.rtf,.pdf,.txt,.md,.markdown,.html,.htm,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.log,.eml,.msg,.png,.jpg,.jpeg,.gif,.webp"
            className="hidden"
            onChange={onFileChange}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            {uploading ? (da ? 'Uploader…' : 'Uploading…') : da ? 'Upload' : 'Upload'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!pickerOpen) void loadAvailableDocs();
              setPickerOpen((v) => !v);
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <Plus size={12} />
            {da ? 'Tilføj' : 'Attach'}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-rose-900/20 border-b border-rose-800/40 text-rose-300 text-xs flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {/* Picker dropdown (inline, above the list) */}
      {pickerOpen && (
        <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/60">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-slate-300 font-medium">
              {da ? 'Vælg fra videnbasen' : 'Pick from knowledge base'}
            </p>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
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
                  <p className="text-xs text-slate-500 py-2">
                    {da
                      ? 'Alle dokumenter er allerede tilknyttet. Upload et nyt ovenfor.'
                      : 'All documents already attached. Upload a new one above.'}
                  </p>
                );
              }
              return (
                <ul className="space-y-1 max-h-48 overflow-y-auto">
                  {pickable.map((d) => (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => attachDoc(d.id)}
                        className="w-full text-left px-2 py-1.5 rounded-md bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700/40 transition-colors flex items-center gap-2"
                      >
                        <FileText size={12} className="text-slate-400 shrink-0" />
                        <span className="text-xs text-white truncate">{d.name}</span>
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
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {attachmentsLoading ? (
          <div className="py-8 flex items-center justify-center">
            <Loader2 size={18} className="animate-spin text-blue-400" />
          </div>
        ) : attachments.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500 space-y-2">
            <FolderOpen size={28} className="mx-auto text-slate-700" />
            <p>{da ? 'Ingen dokumenter tilknyttet endnu.' : 'No documents linked yet.'}</p>
            <p className="text-slate-600">
              {da
                ? 'Upload eller tilføj et dokument fra videnbasen for at give AI\u2019en baggrundsviden om skabelonen.'
                : 'Upload or attach a document from the knowledge base to give the AI background context for this template.'}
            </p>
          </div>
        ) : (
          attachments.map((a, idx) => {
            const draft = guidelineDrafts[a.id] ?? '';
            const savedVal = a.guidelines ?? '';
            const dirty = draft !== savedVal;
            return (
              <div
                key={a.id}
                className="bg-slate-900/40 border border-slate-700/40 rounded-lg p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <FileText size={13} className="text-blue-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white font-medium truncate">
                      {a.document?.name ?? (da ? '(ukendt)' : '(unknown)')}
                    </p>
                    {extFromPath(a.document?.file_path) && (
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide">
                        {extFromPath(a.document?.file_path)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => moveAttachment(a.id, -1)}
                      disabled={idx === 0}
                      className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      aria-label={da ? 'Flyt op' : 'Move up'}
                    >
                      <ArrowUp size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveAttachment(a.id, 1)}
                      disabled={idx === attachments.length - 1}
                      className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      aria-label={da ? 'Flyt ned' : 'Move down'}
                    >
                      <ArrowDown size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => detachDoc(a.id)}
                      className="p-1 rounded text-rose-400 hover:text-white hover:bg-rose-600/40 transition-colors"
                      aria-label={da ? 'Fjern' : 'Detach'}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                <label className="block">
                  <span className="text-[11px] text-slate-400 flex items-center justify-between">
                    <span>
                      {da
                        ? 'Guidelines — hvordan AI\u2019en skal bruge dokumentet'
                        : 'Guidelines — how the AI should use this doc'}
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
                        ? 'Fx: Brug afsnit 3 som reference. Citér ikke direkte — omformulér.'
                        : 'E.g.: Use section 3 as reference. Never cite verbatim — paraphrase.'
                    }
                    className="mt-1 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-white text-xs resize-vertical"
                  />
                </label>
                {dirty && (
                  <div className="flex items-center justify-end">
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
            );
          })
        )}
      </div>
    </div>
  );
}
