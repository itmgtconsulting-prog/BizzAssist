/**
 * CaseDetailClient — case detail UI with inline-edit metadata, drag-drop
 * upload zone, and doc list with download/delete.
 *
 * BIZZ-713: Preview rendering (mammoth for .docx, PDF embed, eml/msg parser)
 * is explicitly out of scope — tracked separately in BIZZ-714. Download via
 * signed URL is the minimum viable here.
 *
 * @module app/domain/[id]/case/[caseId]/CaseDetailClient
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Upload,
  FileText,
  Download,
  Trash2,
  Loader2,
  Briefcase,
  Save,
  X,
  Sparkles,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface CaseDoc {
  id: string;
  name: string;
  file_path: string;
  file_type: string;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
  /** BIZZ-714: text-extraction outcome */
  parse_status?: 'pending' | 'ok' | 'failed' | 'truncated';
  parse_error?: string | null;
}

interface CaseDetail {
  id: string;
  name: string;
  client_ref: string | null;
  status: 'open' | 'closed' | 'archived';
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
  docs: CaseDoc[];
}

/** Hard cap matching the API (file size). */
const MAX_FILE_SIZE_MB = 50;

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Case detail page.
 *
 * @param domainId - Domain UUID
 * @param caseId - Case UUID
 */
export default function CaseDetailClient({
  domainId,
  caseId,
}: {
  domainId: string;
  caseId: string;
}) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const router = useRouter();

  const [data, setData] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Inline-edit buffers
  const [editName, setEditName] = useState('');
  const [editClientRef, setEditClientRef] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editStatus, setEditStatus] = useState<'open' | 'closed' | 'archived'>('open');

  // Drag-drop state
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // BIZZ-717: Generation modal state
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [templates, setTemplates] = useState<
    Array<{ id: string; name: string; file_type: string }>
  >([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [genInstructions, setGenInstructions] = useState('');
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/cases/${caseId}`);
      if (!r.ok) {
        if (r.status === 404) {
          setNotice({ kind: 'err', text: da ? 'Sag ikke fundet' : 'Case not found' });
          return;
        }
        setNotice({ kind: 'err', text: da ? 'Fejl ved hentning' : 'Load error' });
        return;
      }
      const d = (await r.json()) as CaseDetail;
      setData(d);
      setEditName(d.name);
      setEditClientRef(d.client_ref ?? '');
      setEditNotes(d.notes ?? '');
      setEditStatus(d.status);
    } finally {
      setLoading(false);
    }
  }, [domainId, caseId, da]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/domain/${domainId}/cases/${caseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName,
          client_ref: editClientRef,
          notes: editNotes,
          status: editStatus,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: 'Unknown' }));
        setNotice({ kind: 'err', text: d.error || 'Fejl' });
      } else {
        setNotice({ kind: 'ok', text: da ? 'Gemt' : 'Saved' });
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  const uploadFiles = async (files: FileList) => {
    const list = Array.from(files);
    for (const file of list) {
      if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        setNotice({
          kind: 'err',
          text: `${file.name}: ${da ? `max ${MAX_FILE_SIZE_MB} MB` : `max ${MAX_FILE_SIZE_MB} MB`}`,
        });
        continue;
      }
      setUploadingCount((n) => n + 1);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch(`/api/domain/${domainId}/cases/${caseId}/docs`, {
          method: 'POST',
          body: fd,
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({ error: 'Unknown' }));
          setNotice({ kind: 'err', text: `${file.name}: ${d.error || 'Fejl'}` });
        }
      } finally {
        setUploadingCount((n) => n - 1);
      }
    }
    await load();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
  };

  const deleteDoc = async (doc: CaseDoc) => {
    if (!window.confirm(da ? `Slet "${doc.name}"?` : `Delete "${doc.name}"?`)) return;
    const r = await fetch(`/api/domain/${domainId}/cases/${caseId}/docs/${doc.id}`, {
      method: 'DELETE',
    });
    if (!r.ok) {
      setNotice({ kind: 'err', text: da ? 'Kunne ikke slette' : 'Delete failed' });
    } else {
      await load();
    }
  };

  const downloadDoc = async (doc: CaseDoc) => {
    const r = await fetch(`/api/domain/${domainId}/cases/${caseId}/docs/${doc.id}`);
    if (!r.ok) {
      setNotice({ kind: 'err', text: da ? 'Kunne ikke hente link' : 'Link error' });
      return;
    }
    const { url } = (await r.json()) as { url: string };
    window.open(url, '_blank', 'noopener');
  };

  const openGenerateModal = async () => {
    setShowGenerateModal(true);
    const r = await fetch(`/api/domain/${domainId}/templates`);
    if (r.ok) {
      const list = (await r.json()) as Array<{
        id: string;
        name: string;
        file_type: string;
        status: string;
      }>;
      setTemplates(list.filter((t) => t.status === 'active'));
    }
  };

  const generateDocument = async () => {
    if (!selectedTemplateId) return;
    setGenerating(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/domain/${domainId}/case/${caseId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: selectedTemplateId,
          user_instructions: genInstructions.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: 'Unknown' }));
        setNotice({ kind: 'err', text: d.error || 'Generation fejlede' });
      } else {
        const { generation_id } = (await r.json()) as { generation_id: string };
        router.push(`/domain/${domainId}/generation/${generation_id}`);
      }
    } finally {
      setGenerating(false);
    }
  };

  const deleteCase = async () => {
    if (
      !window.confirm(
        da
          ? `Slet sagen "${data?.name}" og alle tilknyttede dokumenter? Handlingen kan ikke fortrydes.`
          : `Delete case "${data?.name}" and all associated documents? This cannot be undone.`
      )
    )
      return;
    const r = await fetch(`/api/domain/${domainId}/cases/${caseId}`, { method: 'DELETE' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({ error: 'Unknown' }));
      setNotice({ kind: 'err', text: d.error || 'Fejl' });
    } else {
      router.push(`/domain/${domainId}`);
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
        {da ? 'Sag ikke fundet' : 'Case not found'}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <Link
        href={`/domain/${domainId}`}
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage til sager' : 'Back to cases'}
      </Link>

      {notice && (
        <div
          className={`px-4 py-2 rounded-md border text-sm flex items-center justify-between ${
            notice.kind === 'ok'
              ? 'bg-emerald-900/20 border-emerald-700/40 text-emerald-300'
              : 'bg-rose-900/20 border-rose-700/40 text-rose-300'
          }`}
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Luk">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Metadata panel */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Briefcase size={20} className="text-blue-400" />
          <h1 className="text-lg font-bold text-white">{da ? 'Sagsdetaljer' : 'Case details'}</h1>
        </div>

        <label className="block">
          <span className="text-slate-300 text-xs">{da ? 'Sagsnavn' : 'Case name'}</span>
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            maxLength={200}
            className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
          />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-slate-300 text-xs">{da ? 'Klient-reference' : 'Client ref'}</span>
            <input
              type="text"
              value={editClientRef}
              onChange={(e) => setEditClientRef(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
            />
          </label>
          <label className="block">
            <span className="text-slate-300 text-xs">Status</span>
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value as 'open' | 'closed' | 'archived')}
              className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
            >
              <option value="open">{da ? 'Åben' : 'Open'}</option>
              <option value="closed">{da ? 'Lukket' : 'Closed'}</option>
              <option value="archived">{da ? 'Arkiveret' : 'Archived'}</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-slate-300 text-xs">{da ? 'Noter' : 'Notes'}</span>
          <textarea
            value={editNotes}
            onChange={(e) => setEditNotes(e.target.value)}
            rows={4}
            className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm font-mono"
          />
        </label>

        <div className="flex items-center justify-between pt-2">
          <button
            onClick={deleteCase}
            className="text-rose-400 hover:text-rose-300 text-xs flex items-center gap-1"
          >
            <Trash2 size={12} />
            {da ? 'Slet sag' : 'Delete case'}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void openGenerateModal()}
              disabled={data.docs.length === 0}
              className="flex items-center gap-2 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded-md text-white text-sm font-medium"
              title={
                data.docs.length === 0
                  ? da
                    ? 'Upload mindst 1 dokument først'
                    : 'Upload at least 1 document first'
                  : undefined
              }
            >
              <Sparkles size={14} />
              {da ? 'Generér dokument' : 'Generate document'}
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-sm font-medium"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {da ? 'Gem ændringer' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Generate-document modal */}
      {showGenerateModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="generate-title"
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => !generating && setShowGenerateModal(false)}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-lg w-full space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="generate-title"
              className="text-lg font-bold text-white flex items-center gap-2"
            >
              <Sparkles size={18} className="text-purple-400" />
              {da ? 'Generér dokument' : 'Generate document'}
            </h2>
            <label className="block">
              <span className="text-slate-300 text-sm">{da ? 'Skabelon' : 'Template'}</span>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="mt-1 w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white text-sm"
              >
                <option value="">{da ? 'Vælg skabelon…' : 'Select template…'}</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.file_type})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-slate-300 text-sm">
                {da ? 'Ekstra instruktioner (valgfri)' : 'Extra instructions (optional)'}
              </span>
              <textarea
                value={genInstructions}
                onChange={(e) => setGenInstructions(e.target.value)}
                rows={4}
                placeholder={
                  da
                    ? 'fx: Fokusér på boligværdien fra 2023. Brug formel tone.'
                    : 'e.g. Focus on the 2023 valuation. Use formal tone.'
                }
                className="mt-1 w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white text-sm"
              />
            </label>
            <p className="text-slate-500 text-xs">
              {da
                ? `Genererer baseret på ${data.docs.length} dokument${data.docs.length === 1 ? '' : 'er'} i sagen.`
                : `Generates using ${data.docs.length} case document${data.docs.length === 1 ? '' : 's'}.`}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowGenerateModal(false)}
                disabled={generating}
                className="px-3 py-2 text-slate-400 hover:text-white text-sm disabled:opacity-50"
              >
                {da ? 'Annuller' : 'Cancel'}
              </button>
              <button
                onClick={() => void generateDocument()}
                disabled={!selectedTemplateId || generating}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded-md text-white text-sm font-medium"
              >
                {generating && <Loader2 size={14} className="animate-spin" />}
                {da ? 'Start generering' : 'Start generation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          isDragging
            ? 'border-blue-400 bg-blue-900/20'
            : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800/40'
        }`}
      >
        <Upload size={24} className="mx-auto text-slate-500 mb-2" />
        <p className="text-slate-300 text-sm font-medium">
          {da ? 'Træk filer herhen eller klik for at vælge' : 'Drop files here or click to select'}
        </p>
        <p className="text-slate-500 text-xs mt-1">
          {da
            ? `docx, pdf, txt, eml, msg · max ${MAX_FILE_SIZE_MB} MB pr. fil`
            : `docx, pdf, txt, eml, msg · max ${MAX_FILE_SIZE_MB} MB per file`}
        </p>
        {uploadingCount > 0 && (
          <div className="mt-3 flex items-center justify-center gap-2 text-blue-300 text-xs">
            <Loader2 size={12} className="animate-spin" />
            {da ? `Uploader ${uploadingCount}…` : `Uploading ${uploadingCount}…`}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".docx,.pdf,.txt,.eml,.msg,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/plain,message/rfc822,application/vnd.ms-outlook"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
          className="hidden"
        />
      </div>

      {/* Doc list */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
          <h2 className="text-white font-medium text-sm flex items-center gap-2">
            <FileText size={16} className="text-slate-400" />
            {da ? 'Dokumenter' : 'Documents'} ({data.docs.length})
          </h2>
        </div>
        {data.docs.length === 0 ? (
          <div className="py-8 text-center text-slate-500 text-sm">
            {da ? 'Ingen dokumenter endnu' : 'No documents yet'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-700/30">
            {data.docs.map((doc) => (
              <li key={doc.id} className="px-4 py-3 flex items-center gap-3">
                <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-slate-700/60 text-slate-300 uppercase">
                  {doc.file_type}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-slate-200 text-sm truncate">{doc.name}</p>
                    {doc.parse_status === 'failed' && (
                      <span
                        title={doc.parse_error ?? undefined}
                        className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-rose-900/40 text-rose-300 shrink-0"
                      >
                        {da ? 'Parse-fejl' : 'Parse failed'}
                      </span>
                    )}
                    {doc.parse_status === 'truncated' && (
                      <span
                        title={da ? 'Kun første 500k tegn bevaret' : 'Only first 500k chars kept'}
                        className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-900/40 text-amber-300 shrink-0"
                      >
                        {da ? 'Trunkeret' : 'Truncated'}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-500 text-xs">
                    {formatSize(doc.size_bytes)} ·{' '}
                    {new Date(doc.created_at).toLocaleDateString(da ? 'da-DK' : 'en-GB')}
                  </p>
                </div>
                <button
                  onClick={() => downloadDoc(doc)}
                  aria-label={da ? 'Download' : 'Download'}
                  className="text-slate-400 hover:text-white"
                >
                  <Download size={14} />
                </button>
                <button
                  onClick={() => deleteDoc(doc)}
                  aria-label={da ? 'Slet' : 'Delete'}
                  className="text-rose-400 hover:text-rose-300"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
