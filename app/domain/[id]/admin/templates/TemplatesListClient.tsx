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
import { FileText, Upload, Loader2, Search, GripHorizontal, Trash2, Pencil } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { TemplateDocumentsPanel } from './[templateId]/TemplateDocumentsPanel';
import TemplateEditorClient from './[templateId]/TemplateEditorClient';

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

  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // BIZZ-747: search — list becomes unusable at 100+ templates without it
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('all');
  // BIZZ-756: sort dropdown (name/date/status)
  const [sortBy, setSortBy] = useState<'name-asc' | 'date-desc' | 'status'>('date-desc');
  // BIZZ-789: Åbn skabelon inline i panelet i stedet for at navigere væk.
  // URL-param 't=<id>' beholdes for deep-linkable state.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  // BIZZ-792: Bund-panelet kan enten vise tilknyttede dokumenter eller
  // skabelon-editoren. Pencil-ikon skifter til 'editor', ✕ skifter tilbage.
  const [bottomMode, setBottomMode] = useState<'docs' | 'editor'>('docs');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get('t');
    if (t) setSelectedTemplateId(t);
  }, []);

  const setSelectionWithUrl = useCallback((id: string | null) => {
    setSelectedTemplateId(id);
    // BIZZ-792: fald altid tilbage til docs-mode når valget ændres/ryddes
    setBottomMode('docs');
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('t', id);
    else url.searchParams.delete('t');
    window.history.replaceState(null, '', url.toString());
  }, []);

  // BIZZ-789: Horizontal resizable divider imellem skabeloner-listen (top)
  // og tilknyttede dokumenter (bund). Position persistes i localStorage.
  const [topPct, setTopPct] = useState(55);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = Number(window.localStorage.getItem('bizz-templates-split-pct'));
    if (saved >= 25 && saved <= 85) setTopPct(saved);
  }, []);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = splitContainerRef.current;
      if (!container) return;
      const onMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const pct = ((ev.clientY - rect.top) / rect.height) * 100;
        setTopPct(Math.max(25, Math.min(85, pct)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.localStorage.setItem('bizz-templates-split-pct', String(Math.round(topPct)));
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [topPct]
  );

  /** BIZZ-790: Hard-delete skabelon (confirm-dialog + reload). */
  const deleteTemplate = async (id: string, name: string) => {
    if (
      !window.confirm(
        da
          ? `ADVARSEL: Slet skabelon "${name}" permanent? Alle versioner og tilknyttede dokumenter mister deres reference. Sager som allerede har brugt skabelonen beholder deres genererede output.`
          : `WARNING: Permanently delete template "${name}"? All versions and linked documents lose their reference. Cases that already used the template keep their generated output.`
      )
    ) {
      return;
    }
    const r = await fetch(`/api/domain/${domainId}/templates/${id}`, { method: 'DELETE' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({ error: 'Unknown' }));
      setNotice({ kind: 'err', text: d.error || 'Kunne ikke slette' });
      return;
    }
    if (id === selectedTemplateId) setSelectionWithUrl(null);
    await load();
    setNotice({
      kind: 'ok',
      text: da ? `Skabelon "${name}" slettet` : `Template "${name}" deleted`,
    });
  };

  const filteredTemplates = templates
    .filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (!t.name.toLowerCase().includes(q) && !(t.description ?? '').toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'name-asc') return a.name.localeCompare(b.name, 'da');
      if (sortBy === 'status') return a.status.localeCompare(b.status);
      // date-desc (default)
      return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
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
        // BIZZ-789: åbn nyuploadet skabelon inline i stedet for at navigere
        await load();
        setSelectionWithUrl(id);
      }
    } finally {
      setUploading(false);
    }
  };

  // BIZZ-789 v2: Panelet er altid et top/bund split. Top = skabeloner-listen
  // (altid synlig), Bund = dokumenter for valgt skabelon (eller placeholder
  // hvis ingen valgt). Ingen swap til detalje-view mere.
  return (
    <div ref={splitContainerRef} className="flex flex-col h-full min-h-[calc(100vh-240px)]">
      {/* TOP: skabeloner-listen — altid synlig */}
      <div
        className="min-h-0 overflow-y-auto px-4 py-6 space-y-4"
        style={{ height: selectedTemplateId ? `${topPct}%` : '100%' }}
      >
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
            accept=".docx,.xlsx,.xlsm,.xls,.pptx,.rtf,.pdf,.txt,.md,.markdown,.html,.htm,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.log"
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
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
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
            {/* BIZZ-756: sort dropdown */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'name-asc' | 'date-desc' | 'status')}
              className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-xs focus:border-blue-500 focus:outline-none"
            >
              <option value="date-desc">{da ? 'Nyeste først' : 'Newest first'}</option>
              <option value="name-asc">{da ? 'Navn A–Å' : 'Name A–Z'}</option>
              <option value="status">Status</option>
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
              {filteredTemplates.map((t) => {
                const isSelected = t.id === selectedTemplateId;
                return (
                  <li
                    key={t.id}
                    className={`flex items-center gap-3 px-4 py-3 transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-blue-500/10 border-l-2 border-blue-400'
                        : 'hover:bg-slate-800/60 border-l-2 border-transparent'
                    }`}
                    onClick={() => setSelectionWithUrl(t.id)}
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
                    {/* BIZZ-790: Action-ikoner per row — rediger + slet */}
                    <div
                      className="flex items-center gap-1 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectionWithUrl(t.id);
                          setBottomMode('editor');
                        }}
                        className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700/60 transition-colors"
                        title={da ? 'Rediger skabelon' : 'Edit template'}
                        aria-label={da ? 'Rediger skabelon' : 'Edit template'}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteTemplate(t.id, t.name)}
                        className="p-1.5 rounded text-rose-400 hover:text-white hover:bg-rose-600/40 transition-colors"
                        title={da ? 'Slet skabelon' : 'Delete template'}
                        aria-label={da ? 'Slet skabelon' : 'Delete template'}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* BIZZ-789 v2: Resizable horizontal divider — kun når en skabelon er valgt */}
      {selectedTemplateId && (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-valuenow={Math.round(topPct)}
            aria-valuemin={25}
            aria-valuemax={85}
            onMouseDown={startResize}
            className="group relative h-1.5 shrink-0 cursor-row-resize bg-slate-800/40 hover:bg-blue-500/40 transition-colors"
            title={da ? 'Træk for at justere opdelingen' : 'Drag to resize split'}
          >
            <GripHorizontal
              size={14}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300"
            />
          </div>

          {/* BUND: dokumenter for valgt skabelon */}
          <div
            className="min-h-0 overflow-hidden border-t border-slate-700/40"
            style={{ height: `${100 - topPct}%` }}
          >
            <div className="h-full flex flex-col">
              {/* BIZZ-791/792: Header med ✕-knap. I editor-mode lukker ✕
                  editoren og bringer dokumenter tilbage; i docs-mode rydder
                  ✕ valget af skabelon. */}
              <div className="shrink-0 px-2 py-1 border-b border-slate-700/40 bg-slate-900/50 flex items-center justify-between">
                <span className="text-[11px] text-slate-500 pl-2">
                  {bottomMode === 'editor'
                    ? da
                      ? 'Rediger skabelon'
                      : 'Edit template'
                    : da
                      ? 'Tilknyttede dokumenter'
                      : 'Linked documents'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (bottomMode === 'editor') {
                      // BIZZ-792: Luk editor → dokumenter kommer tilbage
                      setBottomMode('docs');
                    } else {
                      setSelectionWithUrl(null);
                    }
                  }}
                  className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  title={
                    bottomMode === 'editor'
                      ? da
                        ? 'Luk editor'
                        : 'Close editor'
                      : da
                        ? 'Fjern valg'
                        : 'Clear selection'
                  }
                  aria-label={
                    bottomMode === 'editor'
                      ? da
                        ? 'Luk editor'
                        : 'Close editor'
                      : da
                        ? 'Fjern valg'
                        : 'Clear selection'
                  }
                >
                  ✕
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto bizz-inline-editor">
                {bottomMode === 'editor' ? (
                  <TemplateEditorClient domainId={domainId} templateId={selectedTemplateId} />
                ) : (
                  <TemplateDocumentsPanel domainId={domainId} templateId={selectedTemplateId} />
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* BIZZ-792: Compact-overrides for editor-komponenten naar den
          rendres inde i bottom-panelet (smallere/kortere plads). */}
      <style jsx global>{`
        .bizz-inline-editor > div {
          max-width: 100% !important;
          padding-top: 0.5rem !important;
          padding-bottom: 0.75rem !important;
          padding-left: 0.75rem !important;
          padding-right: 0.75rem !important;
        }
        .bizz-inline-editor .max-w-4xl {
          max-width: 100% !important;
        }
        .bizz-inline-editor h1 {
          font-size: 0.95rem !important;
        }
        .bizz-inline-editor [role='tablist'] {
          font-size: 0.75rem;
        }
      `}</style>
    </div>
  );
}
