'use client';

/**
 * Videnbase — /dashboard/settings/knowledge
 *
 * Settings sub-page that lets tenant admins manage the AI knowledge base.
 * Each knowledge item is a titled text document that the AI assistant
 * automatically references when answering questions for this organisation.
 *
 * Features:
 *  - List of existing knowledge items (title, source type, date, char count)
 *  - "Tilføj viden" button → inline modal with title + textarea
 *  - Character counter (max 50 000 chars) enforced client- and server-side
 *  - Delete button per item (with confirmation)
 *  - Info banner explaining the AI injection behaviour
 *
 * Data: /api/knowledge (GET / POST / DELETE)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BookOpen,
  Plus,
  Trash2,
  Loader2,
  AlertTriangle,
  CheckCircle,
  X,
  Info,
  FileText,
  Clock,
} from 'lucide-react';
import type { KnowledgeItem } from '@/app/api/knowledge/route';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Max content characters — mirrors the server-side and DB constraint. */
const MAX_CONTENT_CHARS = 50_000;

/** Max title characters. */
const MAX_TITLE_CHARS = 200;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats an ISO timestamp to a short Danish locale date string.
 *
 * @param iso - ISO 8601 timestamp string
 * @returns Formatted date, e.g. "7. apr. 2026"
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('da-DK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Returns a human-readable label for a knowledge item source type.
 *
 * @param sourceType - 'manual' | 'upload' | 'url'
 * @returns Danish label string
 */
function sourceTypeLabel(sourceType: string): string {
  switch (sourceType) {
    case 'upload':
      return 'Upload';
    case 'url':
      return 'URL';
    default:
      return 'Manuel';
  }
}

// ─── Add modal ────────────────────────────────────────────────────────────────

interface AddModalProps {
  /** Called when the modal should close (cancelled or successfully submitted). */
  onClose: () => void;
  /** Called with the newly created item after a successful API call. */
  onCreated: (item: KnowledgeItem) => void;
}

/**
 * Modal dialog for adding a new knowledge item.
 * Handles form state, character counting, validation, and the POST request.
 *
 * @param onClose   - Close callback (no item created)
 * @param onCreated - Success callback, receives the created KnowledgeItem
 */
function AddModal({ onClose, onCreated }: AddModalProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  /** Focus the title field when the modal mounts. */
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  /** Closes the modal when Escape is pressed. */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  /**
   * Submits the form to POST /api/knowledge.
   * Validates length constraints before sending.
   */
  const handleSubmit = useCallback(async () => {
    setError(null);

    if (title.trim().length === 0) {
      setError('Titel er påkrævet.');
      return;
    }
    if (title.length > MAX_TITLE_CHARS) {
      setError(`Titel må maks være ${MAX_TITLE_CHARS} tegn.`);
      return;
    }
    if (content.trim().length === 0) {
      setError('Indhold er påkrævet.');
      return;
    }
    if (content.length > MAX_CONTENT_CHARS) {
      setError(`Indhold må maks være ${MAX_CONTENT_CHARS.toLocaleString('da-DK')} tegn.`);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
          source_type: 'manual',
        }),
      });

      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? 'Noget gik galt — prøv igen.');
        return;
      }

      const item = (await res.json()) as KnowledgeItem;
      onCreated(item);
    } catch {
      setError('Netværksfejl — prøv igen.');
    } finally {
      setSaving(false);
    }
  }, [title, content, onCreated]);

  const contentRemaining = MAX_CONTENT_CHARS - content.length;
  const contentNearLimit = contentRemaining < 5_000;
  const contentOverLimit = content.length > MAX_CONTENT_CHARS;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-knowledge-title"
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 id="add-knowledge-title" className="text-white font-semibold text-base">
            Tilføj viden
          </h2>
          <button
            onClick={onClose}
            aria-label="Luk dialog"
            className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* Title */}
          <div>
            <label
              htmlFor="knowledge-title"
              className="block text-slate-300 text-sm font-medium mb-1.5"
            >
              Titel <span className="text-red-400">*</span>
            </label>
            <input
              id="knowledge-title"
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_TITLE_CHARS}
              placeholder="F.eks. Vores investeringsstrategi"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
            />
            <p className="text-slate-500 text-xs mt-1 text-right">
              {title.length} / {MAX_TITLE_CHARS}
            </p>
          </div>

          {/* Content */}
          <div>
            <label
              htmlFor="knowledge-content"
              className="block text-slate-300 text-sm font-medium mb-1.5"
            >
              Indhold <span className="text-red-400">*</span>
            </label>
            <textarea
              id="knowledge-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              placeholder="Skriv den viden du vil give AI-assistenten…"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors resize-y font-mono leading-relaxed"
            />
            <p
              className={`text-xs mt-1 text-right ${
                contentOverLimit
                  ? 'text-red-400'
                  : contentNearLimit
                    ? 'text-amber-400'
                    : 'text-slate-500'
              }`}
            >
              {content.length.toLocaleString('da-DK')} / {MAX_CONTENT_CHARS.toLocaleString('da-DK')}{' '}
              tegn
              {contentNearLimit && !contentOverLimit && (
                <span className="ml-1">({contentRemaining.toLocaleString('da-DK')} tilbage)</span>
              )}
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-500/40 rounded-lg text-red-300 text-sm">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white transition-colors"
          >
            Annuller
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || contentOverLimit}
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Gemmer…
              </>
            ) : (
              <>
                <Plus size={14} />
                Gem viden
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

/**
 * KnowledgePage — Videnbase settings sub-page.
 *
 * Loads knowledge items for the current tenant and presents them in a list
 * with add/delete functionality. Designed to match the existing settings
 * page visual style (dark theme, card-based layout).
 *
 * @returns React component for the /dashboard/settings/knowledge route
 */
export default function KnowledgePage() {
  const router = useRouter();
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  /** Fetches all knowledge items from /api/knowledge. */
  const fetchItems = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/knowledge');
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setFetchError(json.error ?? 'Kunne ikke hente videnbase.');
        return;
      }
      setItems((await res.json()) as KnowledgeItem[]);
    } catch {
      setFetchError('Netværksfejl — prøv igen.');
    } finally {
      setLoading(false);
    }
  }, []);

  /** Initial load. */
  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  /**
   * Handles successful creation of a new knowledge item.
   * Prepends the item to the list without a full refetch.
   *
   * @param item - The newly created KnowledgeItem
   */
  const handleCreated = useCallback((item: KnowledgeItem) => {
    setItems((prev) => [item, ...prev]);
    setShowAddModal(false);
    setSuccessMsg('Viden gemt!');
    setTimeout(() => setSuccessMsg(null), 4000);
  }, []);

  /**
   * Deletes a knowledge item after user confirmation.
   *
   * @param id - Primary key of the item to delete
   */
  const handleDelete = useCallback(async (id: number) => {
    if (!confirm('Er du sikker på du vil slette dette videnbase-element?')) return;

    setDeletingId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/knowledge?id=${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setDeleteError(json.error ?? 'Sletning fejlede — prøv igen.');
        return;
      }
      setItems((prev) => prev.filter((item) => item.id !== id));
      setSuccessMsg('Element slettet.');
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch {
      setDeleteError('Netværksfejl — prøv igen.');
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Sticky header ─── */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-700/50 bg-slate-900/30">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.push('/dashboard/settings')}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> Indstillinger
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <BookOpen size={16} className="text-blue-400" />
            </div>
            <div>
              <h1 className="text-white text-xl font-bold">Videnbase</h1>
              <p className="text-slate-400 text-sm">
                Organisationsspecifik viden til AI-assistenten
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus size={14} />
            Tilføj viden
          </button>
        </div>
      </div>

      {/* ─── Scrollable content ─── */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {/* Info banner */}
        <div className="flex items-start gap-3 p-4 bg-blue-900/20 border border-blue-500/30 rounded-xl">
          <Info size={16} className="text-blue-400 mt-0.5 shrink-0" />
          <p className="text-blue-200 text-sm leading-relaxed">
            Elementer i videnbasen inkluderes automatisk i AI-assistentens kontekst for din
            organisation. Brug det til at give assistenten viden om jeres investeringsstrategi,
            porte­føljer, interne politikker eller andre virksomhedsspecifikke informationer.
          </p>
        </div>

        {/* Success feedback */}
        {successMsg && (
          <div className="flex items-center gap-2 p-3 bg-emerald-900/30 border border-emerald-500/40 rounded-lg text-emerald-300 text-sm">
            <CheckCircle size={14} />
            {successMsg}
          </div>
        )}

        {/* Delete error */}
        {deleteError && (
          <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-500/40 rounded-lg text-red-300 text-sm">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {deleteError}
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex items-center gap-3 py-12 justify-center text-slate-400">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">Henter videnbase…</span>
          </div>
        )}

        {/* Fetch error */}
        {!loading && fetchError && (
          <div className="flex items-start gap-2 p-4 bg-red-900/30 border border-red-500/40 rounded-xl text-red-300 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Kunne ikke hente videnbase</p>
              <p className="text-red-400 mt-0.5">{fetchError}</p>
              <button
                onClick={() => void fetchItems()}
                className="mt-2 text-red-300 underline underline-offset-2 hover:text-white"
              >
                Prøv igen
              </button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && !fetchError && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mb-4">
              <BookOpen size={20} className="text-slate-500" />
            </div>
            <p className="text-slate-300 font-medium mb-1">Ingen viden tilføjet endnu</p>
            <p className="text-slate-500 text-sm mb-5 max-w-xs">
              Klik på &quot;Tilføj viden&quot; for at give AI-assistenten organisationsspecifik
              kontekst.
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus size={14} />
              Tilføj viden
            </button>
          </div>
        )}

        {/* Knowledge items list */}
        {!loading && !fetchError && items.length > 0 && (
          <div className="space-y-3">
            <p className="text-slate-400 text-xs uppercase tracking-wider font-medium">
              {items.length} {items.length === 1 ? 'element' : 'elementer'}
            </p>
            {items.map((item) => (
              <div
                key={item.id}
                className="bg-white/5 border border-white/8 rounded-xl p-5 flex items-start gap-4 group"
              >
                {/* Icon */}
                <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center shrink-0 mt-0.5">
                  <FileText size={16} className="text-slate-400" />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-white font-medium text-sm leading-snug truncate">
                      {item.title}
                    </h3>
                    <button
                      onClick={() => void handleDelete(item.id)}
                      disabled={deletingId === item.id}
                      aria-label={`Slet "${item.title}"`}
                      className="shrink-0 text-slate-500 hover:text-red-400 transition-colors p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      {deletingId === item.id ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  </div>

                  {/* Preview */}
                  <p className="text-slate-400 text-xs mt-1.5 line-clamp-2 leading-relaxed">
                    {item.content.slice(0, 200)}
                    {item.content.length > 200 && '…'}
                  </p>

                  {/* Metadata */}
                  <div className="flex items-center gap-3 mt-3">
                    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-600 inline-block" />
                      {sourceTypeLabel(item.source_type)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                      <Clock size={10} />
                      {formatDate(item.created_at)}
                    </span>
                    <span className="text-xs text-slate-600">
                      {item.content.length.toLocaleString('da-DK')} tegn
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Add modal ─── */}
      {showAddModal && (
        <AddModal onClose={() => setShowAddModal(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
