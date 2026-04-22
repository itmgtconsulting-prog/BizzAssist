/**
 * TemplatesListClient — admin list of domain templates with upload CTA.
 *
 * BIZZ-721: Clicking a row opens the per-template editor
 * (/domain/[id]/admin/templates/[tplId]).
 *
 * @module app/domain/[id]/admin/templates/TemplatesListClient
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, Upload, Loader2, Search } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  file_type: string;
  placeholders: Array<{ name: string }>;
  status: 'active' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

const MAX_MB = 20;

export default function TemplatesListClient({ domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const router = useRouter();

  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // BIZZ-747: search — list becomes unusable at 100+ templates without it
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('all');

  const filteredTemplates = templates.filter((t) => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!t.name.toLowerCase().includes(q) && !(t.description ?? '').toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/templates`);
      if (r.ok) setTemplates((await r.json()) as TemplateSummary[]);
    } finally {
      setLoading(false);
    }
  }, [domainId]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    if (file.size > MAX_MB * 1024 * 1024) {
      setNotice({ kind: 'err', text: `max ${MAX_MB} MB` });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/domain/${domainId}/templates`, { method: 'POST', body: fd });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: 'Unknown' }));
        setNotice({ kind: 'err', text: d.error || 'Fejl' });
      } else {
        const { id } = (await r.json()) as { id: string };
        router.push(`/domain/${domainId}/admin/templates/${id}`);
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* BIZZ-752: Back-nav i DomainAdminTabs (layout.tsx) */}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <FileText size={22} className="text-emerald-400" />
            {da ? 'Skabeloner' : 'Templates'}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {templates.length} {da ? 'skabeloner' : 'templates'}
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-sm font-medium"
        >
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {da ? 'Upload skabelon' : 'Upload template'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".docx,.pdf,.txt"
          onChange={(e) => {
            if (e.target.files?.[0]) void upload(e.target.files[0]);
            e.target.value = '';
          }}
          className="hidden"
        />
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

      {/* BIZZ-747: Search + status filter */}
      {!loading && templates.length > 0 && (
        <div className="flex gap-3 items-center">
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={da ? 'Søg skabelon…' : 'Search templates…'}
              className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg pl-9 pr-3 py-2 text-white text-xs placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'archived')}
            className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-xs focus:border-blue-500 focus:outline-none"
          >
            <option value="all">{da ? 'Alle statusser' : 'All statuses'}</option>
            <option value="active">{da ? 'Aktive' : 'Active'}</option>
            <option value="archived">{da ? 'Arkiveret' : 'Archived'}</option>
          </select>
        </div>
      )}

      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-10 text-slate-500 text-sm">
            {da
              ? 'Ingen skabeloner endnu. Upload en skabelon for at starte.'
              : 'No templates yet. Upload one to get started.'}
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-center py-10 text-slate-500 text-sm">
            {da ? 'Ingen skabeloner matcher filteret.' : 'No templates match the filter.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-700/30">
            {filteredTemplates.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/domain/${domainId}/admin/templates/${t.id}`}
                  className="px-4 py-3 flex items-center gap-3 hover:bg-slate-800/60 transition-colors"
                >
                  <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-emerald-900/40 text-emerald-300 uppercase">
                    {t.file_type}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-slate-200 text-sm truncate">{t.name}</p>
                      {t.status === 'archived' && (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-900/40 text-amber-300">
                          {da ? 'Arkiveret' : 'Archived'}
                        </span>
                      )}
                    </div>
                    {t.description && (
                      <p className="text-slate-500 text-xs truncate mt-0.5">{t.description}</p>
                    )}
                  </div>
                  <span className="text-slate-500 text-xs whitespace-nowrap">
                    {t.placeholders?.length ?? 0} {da ? 'felter' : 'fields'}
                  </span>
                  <span className="text-slate-600 text-xs">v{t.version}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
