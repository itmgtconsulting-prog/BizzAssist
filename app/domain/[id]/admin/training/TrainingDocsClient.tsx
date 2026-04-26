/**
 * TrainingDocsClient — admin UI for domain training documents.
 *
 * BIZZ-709: Upload form + filter by doc_type + list with parse-status badge
 * + delete. Edit is limited to doc_type + tags via inline select (full
 * rename flow deferred — covered by PATCH endpoint when needed).
 *
 * @module app/domain/[id]/admin/training/TrainingDocsClient
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, Upload, Trash2, Loader2 } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface TrainingDoc {
  id: string;
  name: string;
  description: string | null;
  doc_type: 'guide' | 'policy' | 'reference' | 'example';
  tags: string[];
  parse_status: 'pending' | 'ok' | 'failed' | 'truncated';
  parse_error: string | null;
  created_at: string;
}

const MAX_MB = 20;
const DOC_TYPES: Array<{
  key: 'guide' | 'policy' | 'reference' | 'example';
  labelDa: string;
  labelEn: string;
}> = [
  { key: 'guide', labelDa: 'Guide', labelEn: 'Guide' },
  { key: 'policy', labelDa: 'Politik', labelEn: 'Policy' },
  { key: 'reference', labelDa: 'Reference', labelEn: 'Reference' },
  { key: 'example', labelDa: 'Eksempel', labelEn: 'Example' },
];

export default function TrainingDocsClient({ domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [docs, setDocs] = useState<TrainingDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState<'guide' | 'policy' | 'reference' | 'example'>(
    'guide'
  );
  const [uploadTags, setUploadTags] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = filter === 'all' ? '' : `?doc_type=${filter}`;
      const r = await fetch(`/api/domain/${domainId}/training-docs${q}`);
      if (r.ok) setDocs((await r.json()) as TrainingDoc[]);
    } finally {
      setLoading(false);
    }
  }, [domainId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    if (file.size > MAX_MB * 1024 * 1024) {
      setNotice({ kind: 'err', text: `${file.name}: max ${MAX_MB} MB` });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', uploadType);
      if (uploadTags.trim()) fd.append('tags', uploadTags.trim());
      const r = await fetch(`/api/domain/${domainId}/training-docs`, {
        method: 'POST',
        body: fd,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: 'Unknown' }));
        setNotice({ kind: 'err', text: d.error || 'Fejl' });
      } else {
        setNotice({ kind: 'ok', text: da ? 'Uploadet' : 'Uploaded' });
        setUploadTags('');
        await load();
      }
    } finally {
      setUploading(false);
    }
  };

  const remove = async (doc: TrainingDoc) => {
    if (!window.confirm(da ? `Slet "${doc.name}"?` : `Delete "${doc.name}"?`)) return;
    const r = await fetch(`/api/domain/${domainId}/training-docs/${doc.id}`, {
      method: 'DELETE',
    });
    if (!r.ok) {
      setNotice({ kind: 'err', text: da ? 'Kunne ikke slette' : 'Delete failed' });
    } else {
      await load();
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* BIZZ-752: Back-nav i DomainAdminTabs (layout.tsx) */}

      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <FileText size={22} className="text-cyan-400" />
          {da ? 'Dokumenter' : 'Documents'}
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          {da
            ? 'Kontekst-materiale som AI\u2019en bruger til hver generation i dette domain.'
            : 'Context material the AI consumes on every generation in this domain.'}
        </p>
      </div>

      {notice && (
        <div
          className={`px-4 py-2 rounded-md border text-sm ${
            notice.kind === 'ok'
              ? 'bg-emerald-900/20 border-emerald-700/40 text-emerald-300'
              : 'bg-rose-900/20 border-rose-700/40 text-rose-300'
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Upload row */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5 space-y-3">
        <h2 className="text-white font-medium text-sm">
          {da ? 'Upload nyt dokument' : 'Upload new document'}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-slate-300 text-xs">{da ? 'Dokumenttype' : 'Document type'}</span>
            <select
              value={uploadType}
              onChange={(e) =>
                setUploadType(e.target.value as 'guide' | 'policy' | 'reference' | 'example')
              }
              className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
            >
              {DOC_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {da ? t.labelDa : t.labelEn}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-slate-300 text-xs">
              {da ? 'Tags (komma-separeret)' : 'Tags (comma-separated)'}
            </span>
            <input
              type="text"
              value={uploadTags}
              onChange={(e) => setUploadTags(e.target.value)}
              placeholder={da ? 'fx: juridisk, skøde' : 'e.g. legal, deed'}
              className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-sm font-medium"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {da ? 'Vælg fil' : 'Choose file'}
          </button>
          <span className="text-slate-500 text-xs">
            {da
              ? `docx, xlsx, pptx, pdf, txt, md, csv m.fl. · max ${MAX_MB} MB`
              : `docx, xlsx, pptx, pdf, txt, md, csv et al. · max ${MAX_MB} MB`}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,.xlsx,.xlsm,.xls,.pptx,.rtf,.pdf,.txt,.md,.markdown,.html,.htm,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.log,.eml,.msg,.png,.jpg,.jpeg,.gif,.webp"
            onChange={(e) => {
              if (e.target.files?.[0]) void upload(e.target.files[0]);
              e.target.value = '';
            }}
            className="hidden"
          />
        </div>
      </div>

      {/* Filter + list */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1 rounded text-xs font-medium ${
            filter === 'all'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-800/40 border border-slate-700/40 text-slate-400 hover:text-white'
          }`}
        >
          {da ? 'Alle' : 'All'}
        </button>
        {DOC_TYPES.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`px-3 py-1 rounded text-xs font-medium ${
              filter === t.key
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800/40 border border-slate-700/40 text-slate-400 hover:text-white'
            }`}
          >
            {da ? t.labelDa : t.labelEn}
          </button>
        ))}
      </div>

      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : docs.length === 0 ? (
          <div className="text-center py-10 text-slate-500 text-sm">
            {da ? 'Ingen træningsdokumenter endnu' : 'No training documents yet'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-700/30">
            {docs.map((doc) => (
              <li key={doc.id} className="px-4 py-3 flex items-center gap-3">
                <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-cyan-900/40 text-cyan-300 uppercase">
                  {doc.doc_type}
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
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-900/40 text-amber-300 shrink-0">
                        {da ? 'Trunkeret' : 'Truncated'}
                      </span>
                    )}
                  </div>
                  {doc.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {doc.tags.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 bg-slate-700/40 text-slate-300 text-[10px] rounded"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => remove(doc)}
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
