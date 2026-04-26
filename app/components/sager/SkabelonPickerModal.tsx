/**
 * SkabelonPickerModal — Multi-select skabelon-picker for workspace.
 *
 * BIZZ-900 (parent BIZZ-896): Bruger kan vælge en eller flere skabeloner
 * fra domainets bibliotek til den aktuelle sag. Valgte skabeloner
 * synkroniseres til URL som ?skabelon=tmpl1,tmpl2 og vises som chips i
 * workspace-panelet.
 *
 * Integration: parent (DomainWorkspaceSplitView) ejer state og
 * åbner/lukker modal. Modal fetcher skabelon-listen fra
 * /api/domain/[id]/templates ved open.
 *
 * WCAG AA: role="dialog" + aria-modal + aria-labelledby + focus-trap
 * via initial-focus + Escape-key-close.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { X, FileText, Loader2, CheckCircle2, Circle } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { logger } from '@/app/lib/logger';

/**
 * Skabelon-shape som returneret fra /api/domain/[id]/templates.
 * Subset af fulde domain_template-rowen — vi bruger kun de felter der
 * er relevante for picker-visning.
 */
export interface SkabelonOption {
  id: string;
  name: string;
  description: string | null;
  file_type: string;
  /** Antal placeholders — surface'es så bruger ved skabelon-kompleksitet. */
  placeholders: string[] | null;
  version: number;
}

interface Props {
  /** Domain-UUID — skabeloner loaded fra /api/domain/[id]/templates. */
  domainId: string;
  /** Åben-state (parent-ejet). */
  open: boolean;
  /** Luk-callback (X-knap, Escape, klik-outside). */
  onClose: () => void;
  /** Aktuelt valgte skabelon-IDs (controlled). */
  selectedIds: Set<string>;
  /** Commit-callback — kaldes kun når bruger klikker "Gem valg". */
  onConfirm: (ids: Set<string>) => void;
}

/**
 * Focus-trap-styret modal der lister domainets skabeloner og lader
 * brugeren multi-select'e dem.
 */
export default function SkabelonPickerModal({
  domainId,
  open,
  onClose,
  selectedIds,
  onConfirm,
}: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [templates, setTemplates] = useState<SkabelonOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<Set<string>>(new Set());

  const dialogRef = useRef<HTMLDivElement>(null);

  // Sync controlled selectedIds ind i local-state ved open
  useEffect(() => {
    if (open) {
      setLocalSelection(new Set(selectedIds));
    }
  }, [open, selectedIds]);

  // Fetch skabeloner ved open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/domain/${domainId}/templates`);
        if (!r.ok) {
          if (!cancelled) setError(da ? 'Kunne ikke hente skabeloner' : 'Failed to load templates');
          return;
        }
        const data = (await r.json()) as SkabelonOption[];
        if (!cancelled) setTemplates(data ?? []);
      } catch (err) {
        logger.error('[SkabelonPickerModal] fetch error:', err);
        if (!cancelled) setError(da ? 'Netværksfejl' : 'Network error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, domainId, da]);

  // Escape-key-close + focus-trap (simpel variant: initial focus på dialog).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    // Flyt fokus ind i modal ved open for accessibility.
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggleOne = (id: string) => {
    setLocalSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    onConfirm(localSelection);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skabelon-picker-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl max-h-[80vh] flex flex-col bg-[#0f172a] border border-slate-700 rounded-xl shadow-2xl focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/50 shrink-0">
          <h2 id="skabelon-picker-title" className="text-white text-sm font-semibold">
            {da ? 'Vælg skabeloner' : 'Select templates'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={da ? 'Luk dialog' : 'Close dialog'}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: template-list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <div className="flex items-center gap-2 justify-center py-12 text-slate-400 text-xs">
              <Loader2 size={14} className="animate-spin" />
              {da ? 'Henter skabeloner…' : 'Loading templates…'}
            </div>
          )}
          {error && <p className="text-rose-300 text-xs py-4 text-center">{error}</p>}
          {templates && templates.length === 0 && !loading && (
            <p className="text-slate-500 text-xs py-12 text-center">
              {da
                ? 'Ingen skabeloner er oprettet for dette domæne endnu.'
                : 'No templates have been created for this domain yet.'}
            </p>
          )}
          {templates && templates.length > 0 && (
            <ul className="space-y-1.5">
              {templates.map((t) => {
                const checked = localSelection.has(t.id);
                const placeholderCount = t.placeholders?.length ?? 0;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => toggleOne(t.id)}
                      aria-pressed={checked}
                      className={`w-full flex items-start gap-2 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                        checked
                          ? 'bg-blue-500/10 border-blue-400/40'
                          : 'bg-slate-800/40 border-slate-700/40 hover:bg-slate-800/70'
                      }`}
                    >
                      <div className="shrink-0 mt-0.5">
                        {checked ? (
                          <CheckCircle2 size={14} className="text-blue-400" />
                        ) : (
                          <Circle size={14} className="text-slate-600" />
                        )}
                      </div>
                      <FileText size={14} className="text-slate-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium truncate">{t.name}</p>
                        {t.description && (
                          <p className="text-slate-400 text-xs mt-0.5 line-clamp-2">
                            {t.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500 uppercase tracking-wide">
                          <span>{t.file_type}</span>
                          <span>·</span>
                          <span>v{t.version}</span>
                          <span>·</span>
                          <span>
                            {placeholderCount}{' '}
                            {da
                              ? placeholderCount === 1
                                ? 'felt'
                                : 'felter'
                              : placeholderCount === 1
                                ? 'field'
                                : 'fields'}
                          </span>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer: selection-count + cancel/confirm */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700/50 shrink-0">
          <p className="text-xs text-slate-400">
            {localSelection.size > 0
              ? da
                ? `${localSelection.size} ${localSelection.size === 1 ? 'skabelon' : 'skabeloner'} valgt`
                : `${localSelection.size} ${localSelection.size === 1 ? 'template' : 'templates'} selected`
              : da
                ? 'Ingen valgt'
                : 'None selected'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
            >
              {da ? 'Annullér' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              {da ? 'Gem valg' : 'Save selection'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
