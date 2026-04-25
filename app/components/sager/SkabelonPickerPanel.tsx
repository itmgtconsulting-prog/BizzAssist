/**
 * SkabelonPickerPanel — Inline skabelon-vælger panel for 3-panel workspace.
 *
 * BIZZ-930: Erstatter modal med inline panel der vises som 3. kolonne
 * i workspace split-view. Genbruger samme multi-select logik som
 * SkabelonPickerModal men uden overlay/backdrop/focus-trap.
 *
 * @param domainId - Domain UUID
 * @param selectedIds - Aktuelt valgte skabelon-IDs (controlled)
 * @param onSelectionChange - Kaldes ved hver toggle (live update)
 * @param onClose - Lukker panelet (X-knap)
 */

'use client';

import { useEffect, useState } from 'react';
import { X, FileText, Loader2, CheckCircle2, Circle } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { logger } from '@/app/lib/logger';
import type { SkabelonOption } from './SkabelonPickerModal';

interface Props {
  /** Domain-UUID — skabeloner loaded fra /api/domain/[id]/templates. */
  domainId: string;
  /** Aktuelt valgte skabelon-IDs (controlled). */
  selectedIds: Set<string>;
  /** Kaldes ved hver toggle — parent opdaterer URL + state live. */
  onSelectionChange: (ids: Set<string>) => void;
  /** Lukker panelet. */
  onClose: () => void;
  /** BIZZ-936: Panel-bredde i pixels (styret af parent resize-handler). */
  width?: number;
}

/**
 * Inline skabelon-vælger panel. Vises som 3. flex-child i workspace.
 */
export default function SkabelonPickerPanel({
  domainId,
  selectedIds,
  onSelectionChange,
  onClose,
  width = 320,
}: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [templates, setTemplates] = useState<SkabelonOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Fetch skabeloner ved mount. */
  useEffect(() => {
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
        logger.error('[SkabelonPickerPanel] fetch error:', err);
        if (!cancelled) setError(da ? 'Netværksfejl' : 'Network error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domainId, da]);

  /**
   * Toggle en skabelon i selection. Kalder parent callback med ny Set.
   *
   * @param id - Skabelon-ID at toggle
   */
  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  }

  return (
    <div
      className="flex flex-col min-h-0 overflow-hidden bg-slate-900/30 shrink-0"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 shrink-0">
        <p className="text-xs font-semibold text-white flex items-center gap-1.5">
          <FileText size={12} className="text-blue-400" />
          {da ? 'Skabeloner' : 'Templates'}
          {selectedIds.size > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 text-[10px] leading-none">
              {selectedIds.size}
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={da ? 'Luk panel' : 'Close panel'}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      {/* Body: template-list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading && (
          <div className="flex items-center gap-2 justify-center py-8 text-slate-400 text-xs">
            <Loader2 size={14} className="animate-spin" />
            {da ? 'Henter skabeloner...' : 'Loading templates...'}
          </div>
        )}
        {error && <p className="text-rose-300 text-xs py-4 text-center">{error}</p>}
        {templates && templates.length === 0 && !loading && (
          <p className="text-slate-500 text-xs py-8 text-center">
            {da ? 'Ingen skabeloner oprettet endnu.' : 'No templates created yet.'}
          </p>
        )}
        {templates && templates.length > 0 && (
          <ul className="space-y-1">
            {templates.map((t) => {
              const checked = selectedIds.has(t.id);
              const placeholderCount = t.placeholders?.length ?? 0;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => toggleOne(t.id)}
                    aria-pressed={checked}
                    className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-lg border text-left transition-colors ${
                      checked
                        ? 'bg-blue-500/10 border-blue-400/40'
                        : 'bg-slate-800/40 border-slate-700/40 hover:bg-slate-800/70'
                    }`}
                  >
                    <div className="shrink-0 mt-0.5">
                      {checked ? (
                        <CheckCircle2 size={12} className="text-blue-400" />
                      ) : (
                        <Circle size={12} className="text-slate-600" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-xs font-medium truncate">{t.name}</p>
                      {t.description && (
                        <p className="text-slate-400 text-[10px] mt-0.5 line-clamp-2">
                          {t.description}
                        </p>
                      )}
                      <div className="flex items-center gap-1.5 mt-1 text-[9px] text-slate-500 uppercase tracking-wide">
                        <span>{t.file_type}</span>
                        <span>v{t.version}</span>
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

      {/* Footer: selection count */}
      <div className="px-3 py-2 border-t border-slate-700/40 shrink-0">
        <p className="text-[10px] text-slate-500 text-center">
          {selectedIds.size > 0
            ? da
              ? `${selectedIds.size} ${selectedIds.size === 1 ? 'skabelon' : 'skabeloner'} valgt`
              : `${selectedIds.size} ${selectedIds.size === 1 ? 'template' : 'templates'} selected`
            : da
              ? 'Klik for at vælge skabeloner'
              : 'Click to select templates'}
        </p>
      </div>
    </div>
  );
}
