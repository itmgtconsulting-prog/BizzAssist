/**
 * BetingelserAdminClient — CRUD for domain's standard forsikringsbetingelser.
 *
 * BIZZ-1921: Viser alle standard betingelser i domain'et med mulighed for
 * at redigere titel/selskab/gyldig_fra, slette, og uploade nye.
 *
 * @module app/domain/[id]/admin/betingelser/BetingelserAdminClient
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { useLanguage } from '@/app/context/LanguageContext';
import { Trash2, Pencil, Check, X, Loader2, ExternalLink, AlertTriangle } from 'lucide-react';

interface StdDoc {
  id: string;
  selskab: string;
  kategori: string;
  titel: string;
  source_url: string;
  added_via: string;
  created_at: string;
  added_by_user: string | null;
  has_content: boolean;
  omraade?: string | null;
  gyldig_fra?: string | null;
  is_valid_standard?: boolean;
}

/**
 * Domain admin betingelser-CRUD.
 *
 * @param domainId - Domain UUID
 */
export default function BetingelserAdminClient({ domainId: _domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [docs, setDocs] = useState<StdDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ titel: '', selskab: '', gyldig_fra: '' });
  const [deleting, setDeleting] = useState<string | null>(null);

  /** Hent alle standard betingelser for domain */
  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/forsikring/standard-docs');
      if (r.ok) {
        const data = await r.json();
        setDocs(data);
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  /** Slet et dokument */
  const handleDelete = async (id: string) => {
    if (!confirm(da ? 'Slet denne betingelse?' : 'Delete this term?')) return;
    setDeleting(id);
    try {
      await fetch(`/api/forsikring/standard-docs?id=${id}`, { method: 'DELETE' });
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch {
      /* non-fatal */
    } finally {
      setDeleting(null);
    }
  };

  /** Start redigering */
  const startEdit = (doc: StdDoc) => {
    setEditingId(doc.id);
    setEditForm({
      titel: doc.titel,
      selskab: doc.selskab,
      gyldig_fra: doc.gyldig_fra ?? '',
    });
  };

  /** Gem redigering */
  const saveEdit = async () => {
    if (!editingId) return;
    try {
      await fetch(`/api/forsikring/standard-docs?id=${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      setDocs((prev) =>
        prev.map((d) =>
          d.id === editingId
            ? {
                ...d,
                titel: editForm.titel,
                selskab: editForm.selskab,
                gyldig_fra: editForm.gyldig_fra || null,
              }
            : d
        )
      );
    } catch {
      /* non-fatal */
    } finally {
      setEditingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold text-lg">
            {da ? 'Standard forsikringsbetingelser' : 'Standard insurance terms'}
          </h2>
          <p className="text-slate-400 text-xs mt-0.5">
            {da
              ? "Vedligehold betingelser der deles med alle brugere i domain'et. Upload nye via forsikringssiden."
              : 'Manage terms shared with all domain users. Upload new terms via the insurance page.'}
          </p>
        </div>
        <span className="text-slate-500 text-xs">
          {docs.length} {da ? 'betingelser' : 'terms'}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-slate-500" />
        </div>
      ) : docs.length === 0 ? (
        <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-8 text-center">
          <p className="text-slate-400 text-sm">
            {da
              ? 'Ingen standard betingelser endnu. Upload PDF-filer via forsikringssiden.'
              : 'No standard terms yet. Upload PDF files via the insurance page.'}
          </p>
        </div>
      ) : (
        <div className="bg-slate-800/20 border border-slate-700/30 rounded-xl overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[1fr_180px_100px_100px_80px] gap-2 px-4 py-2 text-slate-500 text-[10px] uppercase tracking-wide border-b border-slate-700/30">
            <div>{da ? 'Titel' : 'Title'}</div>
            <div>{da ? 'Selskab' : 'Company'}</div>
            <div>{da ? 'Område' : 'Area'}</div>
            <div>{da ? 'Gyldig fra' : 'Valid from'}</div>
            <div></div>
          </div>

          {/* Rows */}
          {docs.map((doc) => (
            <div
              key={doc.id}
              className="grid grid-cols-[1fr_180px_100px_100px_80px] gap-2 px-4 py-2.5 border-b border-slate-800/50 hover:bg-slate-800/20 items-center text-xs"
            >
              {editingId === doc.id ? (
                <>
                  <input
                    value={editForm.titel}
                    onChange={(e) => setEditForm((f) => ({ ...f, titel: e.target.value }))}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs w-full"
                  />
                  <input
                    value={editForm.selskab}
                    onChange={(e) => setEditForm((f) => ({ ...f, selskab: e.target.value }))}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs w-full"
                  />
                  <span className="text-slate-400">{doc.omraade ?? '–'}</span>
                  <input
                    type="date"
                    value={editForm.gyldig_fra}
                    onChange={(e) => setEditForm((f) => ({ ...f, gyldig_fra: e.target.value }))}
                    className="bg-slate-900 border border-slate-700 rounded px-1 py-1 text-white text-[10px] w-full"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={saveEdit}
                      className="text-emerald-400 hover:text-emerald-300 p-1"
                      aria-label={da ? 'Gem' : 'Save'}
                    >
                      <Check size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="text-slate-500 hover:text-white p-1"
                      aria-label={da ? 'Annuller' : 'Cancel'}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-white truncate">{doc.titel}</span>
                    {doc.is_valid_standard === false && (
                      <AlertTriangle size={12} className="text-amber-400 shrink-0" />
                    )}
                    <a
                      href={doc.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-500 hover:text-blue-400 shrink-0"
                    >
                      <ExternalLink size={11} />
                    </a>
                  </div>
                  <span className="text-slate-400 truncate">{doc.selskab}</span>
                  <span className="text-slate-500">
                    {doc.omraade ? (
                      <span className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded text-[9px]">
                        {doc.omraade}
                      </span>
                    ) : (
                      '–'
                    )}
                  </span>
                  <span className="text-slate-500">{doc.gyldig_fra ?? '–'}</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(doc)}
                      className="text-slate-500 hover:text-white p-1"
                      aria-label={da ? 'Rediger' : 'Edit'}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(doc.id)}
                      disabled={deleting === doc.id}
                      className="text-slate-500 hover:text-red-400 p-1 disabled:opacity-40"
                      aria-label={da ? 'Slet' : 'Delete'}
                    >
                      {deleting === doc.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
