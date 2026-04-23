'use client';

/**
 * BIZZ-808: CreateCaseModal — modal-dialog til at oprette en ny sag i
 * et domain. Kan pre-populere den entitet brugeren står på (virksomhed,
 * person eller ejendom) som kunde på sagen.
 *
 * Iter 1 (denne) scope:
 *   - Name (required) + pre-populated entity-chip (read-only display)
 *   - Domain-dropdown hvis bruger er medlem af flere domains
 *   - Gem + Annuller, ESC lukker
 *   - Success → router.push(/domain/[id]?sag={caseId})
 *
 * Iter 2 parkeret (BIZZ-808b):
 *   - Multi-entity personer[], virksomheder[], ejendomme[] arrays
 *   - Fuld field parity (status, tags, noter) i modal
 *   - Ejendom-as-kunde kræver schema-extension (client_ejendom_bfe)
 *   - Proper focus-trap med aria-hidden på baggrund
 *
 * @module app/components/sager/CreateCaseModal
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, X, Building2, User, Home } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { useDomainMemberships, type DomainMembership } from '@/app/hooks/useDomainMemberships';

export interface PrePopulatedEntity {
  /**
   * Entitetstype. 'ejendom' er supported i UI, men skrives kun som ren
   * tekstreference i client_name indtil schema udvides (iter 2).
   */
  kind: 'virksomhed' | 'person' | 'ejendom';
  /** CVR (virksomhed), enhedsNummer (person), BFE (ejendom) */
  id: string;
  /** Display-label (navn eller adresse) */
  label: string;
}

interface Props {
  /** Entitet brugeren står på — pre-populeres som kunde på sagen. */
  initialEntity?: PrePopulatedEntity;
  /** Kaldes når modal lukkes (Annuller, ESC, backdrop) uden save. */
  onClose: () => void;
}

/**
 * Modal-dialog. Renderer portal-lignende fixed overlay. Krav til
 * consumer: render kun når modal skal være åben.
 */
export default function CreateCaseModal({ initialEntity, onClose }: Props) {
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';
  const { memberships, loading: loadingMemberships } = useDomainMemberships();

  const [selectedDomainId, setSelectedDomainId] = useState<string>('');
  const [name, setName] = useState('');
  const [clientRef, setClientRef] = useState('');
  // BIZZ-809: Kort beskrivelse (max 200 tegn) — vises på sagskort
  const [shortDescription, setShortDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Auto-vælg domain når der kun er ét, eller når brugeren lander med præferret
  useEffect(() => {
    if (memberships.length === 1 && !selectedDomainId) {
      setSelectedDomainId(memberships[0].id);
    }
  }, [memberships, selectedDomainId]);

  // Auto-fokus på navn-input når modal åbnes
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // ESC lukker
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(da ? 'Sagsnavn er påkrævet' : 'Case name is required');
      return;
    }
    if (trimmed.length > 200) {
      setError(da ? 'Sagsnavn max 200 tegn' : 'Case name max 200 chars');
      return;
    }
    if (!selectedDomainId) {
      setError(da ? 'Vælg et domain' : 'Select a domain');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Map entity til client_kind/client_cvr/client_person_id felter.
      // Ejendom persisteres kun som ren tekst i client_name indtil iter 2
      // tilføjer dedikeret ejendoms-kolonne.
      const body: Record<string, unknown> = {
        name: trimmed,
        client_ref: clientRef.trim() || null,
        short_description: shortDescription.trim() || null,
      };
      if (initialEntity) {
        if (initialEntity.kind === 'virksomhed') {
          body.client_kind = 'company';
          body.client_cvr = initialEntity.id;
          body.client_name = initialEntity.label;
        } else if (initialEntity.kind === 'person') {
          body.client_kind = 'person';
          body.client_person_id = initialEntity.id;
          body.client_name = initialEntity.label;
        }
        // Ejendom: ingen client_kind-mapping endnu — inkluder som reference
        // i name-feltet via brugerens indtastning + dokumenteres i iter 2.
      }
      const r = await fetch(`/api/domain/${selectedDomainId}/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error || (da ? 'Kunne ikke oprette sag' : 'Could not create case'));
        return;
      }
      const data = (await r.json()) as { id: string };
      // Success → naviger til domain-menuen med sagen åben i split-view
      router.push(`/domain/${selectedDomainId}?sag=${data.id}`);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const entityChip = (() => {
    if (!initialEntity) return null;
    const iconMap = {
      virksomhed: {
        Icon: Building2,
        color: 'text-blue-400',
        bg: 'bg-blue-500/10 border-blue-500/20',
      },
      person: { Icon: User, color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20' },
      ejendom: {
        Icon: Home,
        color: 'text-emerald-400',
        bg: 'bg-emerald-500/10 border-emerald-500/20',
      },
    } as const;
    const { Icon, color, bg } = iconMap[initialEntity.kind];
    return (
      <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border ${bg}`}>
        <Icon size={14} className={`${color} shrink-0`} />
        <span className="text-xs text-white truncate flex-1">{initialEntity.label}</span>
      </div>
    );
  })();

  return (
    <div
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-case-modal-title"
    >
      <div
        ref={dialogRef}
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
            <h2 id="create-case-modal-title" className="text-sm font-semibold text-white">
              {da ? 'Opret ny sag' : 'Create new case'}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={da ? 'Luk' : 'Close'}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="p-5 space-y-4">
            {/* Domain picker / read-only display */}
            {loadingMemberships ? (
              <div className="text-xs text-slate-500 flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" />
                {da ? 'Henter domains…' : 'Loading domains…'}
              </div>
            ) : memberships.length === 0 ? (
              <div className="text-xs text-red-400">
                {da
                  ? 'Du er ikke medlem af nogen domains. Kontakt en administrator.'
                  : 'You are not a member of any domain. Contact an administrator.'}
              </div>
            ) : memberships.length === 1 ? (
              <div>
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Domain</span>
                <p className="mt-0.5 text-sm text-white">{memberships[0].name}</p>
              </div>
            ) : (
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Domain</span>
                <select
                  value={selectedDomainId}
                  onChange={(e) => setSelectedDomainId(e.target.value)}
                  className="mt-0.5 w-full bg-slate-800 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
                  required
                >
                  <option value="">{da ? 'Vælg domain' : 'Select domain'}</option>
                  {memberships.map((d: DomainMembership) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Pre-populated entity */}
            {entityChip && (
              <div>
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {da ? 'Kunde (pre-populeret)' : 'Customer (pre-populated)'}
                </span>
                <div className="mt-0.5">{entityChip}</div>
                {initialEntity?.kind === 'ejendom' && (
                  <p className="mt-1 text-[10px] text-amber-400/80">
                    {da
                      ? 'Ejendom gemmes som tekst-reference indtil iter 2 tilføjer ejendoms-kolonne.'
                      : 'Property stored as text reference until iter 2 adds property column.'}
                  </p>
                )}
              </div>
            )}

            {/* Name (required) */}
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                {da ? 'Sagsnavn' : 'Case name'} *
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                placeholder={da ? 'Fx Due diligence - Acme ApS' : 'e.g. Due diligence - Acme ApS'}
                className="mt-0.5 w-full bg-slate-800 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-white placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
                required
              />
            </label>

            {/* Client ref (optional) */}
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                {da ? 'Klient-reference (valgfri)' : 'Client reference (optional)'}
              </span>
              <input
                type="text"
                value={clientRef}
                onChange={(e) => setClientRef(e.target.value)}
                className="mt-0.5 w-full bg-slate-800 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-white focus:border-blue-500 focus:outline-none"
              />
            </label>

            {/* BIZZ-809: Kort beskrivelse (max 200 tegn) — vises som
                preview på sagskort i listen. Textarea for plads til 2-3
                linjer, counter viser tegn-antal. */}
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center justify-between">
                <span>{da ? 'Kort beskrivelse (valgfri)' : 'Short description (optional)'}</span>
                <span className="text-slate-600 tabular-nums">{shortDescription.length}/200</span>
              </span>
              <textarea
                value={shortDescription}
                onChange={(e) => setShortDescription(e.target.value.slice(0, 200))}
                rows={2}
                maxLength={200}
                placeholder={
                  da
                    ? '2-3 linjer om hvad sagen handler om…'
                    : '2-3 lines about what the case is about…'
                }
                className="mt-0.5 w-full bg-slate-800 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-white placeholder:text-slate-600 focus:border-blue-500 focus:outline-none resize-none"
              />
            </label>

            {/* Iter 2 note */}
            <p className="text-[10px] text-slate-600 italic">
              {da
                ? 'Status, tags, noter og multi-entity-kobling kommer i iter 2 (BIZZ-808b).'
                : 'Status, tags, notes and multi-entity linking come in iter 2 (BIZZ-808b).'}
            </p>

            {/* Error */}
            {error && (
              <div className="text-xs text-red-400 px-2 py-1.5 bg-red-500/10 border border-red-500/20 rounded">
                {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-700 bg-slate-900/50">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-xs text-slate-300 hover:text-white transition-colors"
            >
              {da ? 'Annuller' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={saving || memberships.length === 0}
              className="inline-flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-md text-xs font-medium text-white transition-colors"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              {da ? 'Opret sag' : 'Create case'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
