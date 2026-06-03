/**
 * VirksomhedshandelDetailModal — AI-forklaring for en beriget M&A-kandidat.
 *
 * BIZZ-1948: Åbnes ved klik på en beriget rækkes estimerede transaktionsværdi.
 * Viser HVAD estimatet bygger på i stedet for tilfældige artikel-links:
 *   1. Beregnings-breakdown (EBITDA × branche-multiple → enterprise value →
 *      × ejerandels-delta → transaktionsværdi).
 *   2. Datakilder (regnskab, branche-multiple, CVR-data).
 *   3. Confidence-begrundelse + caveats.
 *   4. Relevante artikler (Serper phase=raw, hentes asynkront) — kun som
 *      understøttende evidens, ikke som primær feature.
 *
 * @module app/dashboard/analyse/virksomhedshandler/VirksomhedshandelDetailModal
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink, Sparkles, TrendingUp, AlertTriangle } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Et lav/mid/høj-interval i DKK (matcher backend-response). */
interface Interval {
  lav: number;
  mid: number;
  hoej: number;
}

/** Beregnings-breakdown fra berig-API'en. */
export interface DetailBreakdown {
  ebitda_used: number;
  multiple: { lav: number; mid: number; hoej: number };
  ev_range: Interval;
  delta_pct: number;
  transaktionsvaerdi: Interval;
  branche_label: string;
  kilde: string;
}

/** Claude-genereret kvalitativ AI-vurdering oven på baseline-beregningen. */
export interface DetailAiVurdering {
  vurdering: string;
  vaerdidrivere: string[];
  risici: string[];
}

/** Beriget resultat (delmængde brugt af modalen). */
export interface DetailBerig {
  estimeret_transaktionsvaerdi: (Interval & { currency: 'DKK' }) | null;
  breakdown: DetailBreakdown | null;
  data_sources: string[];
  caveats: string[];
  confidence: 'low' | 'medium' | 'high';
  confidence_reason: string;
  ai_vurdering?: DetailAiVurdering | null;
  tokensUsed?: number;
  fromCache?: boolean;
}

interface ArtikelResultat {
  title: string;
  url: string;
  source: string;
  date?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  virksomhedNavn: string;
  virksomhedCvr: string;
  berig: DetailBerig | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Formaterer et DKK-beløb kompakt (mio./mia./t.).
 *
 * @param amount - Beløb i DKK
 */
function fmt(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000_000)
    return `${sign}${(abs / 1_000_000_000).toFixed(1).replace('.', ',')} mia. DKK`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace('.', ',')} mio. DKK`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)} t. DKK`;
  return `${sign}${amount} DKK`;
}

const CONFIDENCE_STYLES: Record<string, string> = {
  low: 'bg-slate-600/30 text-slate-300',
  medium: 'bg-amber-500/20 text-amber-300',
  high: 'bg-emerald-500/20 text-emerald-300',
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Modal med AI-forklaring + understøttende data for en beriget kandidat.
 *
 * @param props - open/onClose + virksomhedsdata + berig-resultat
 */
export default function VirksomhedshandelDetailModal({
  open,
  onClose,
  virksomhedNavn,
  virksomhedCvr,
  berig,
}: Props) {
  const { lang } = useLanguage();
  const t = (da: string, en: string) => (lang === 'da' ? da : en);
  const modalRef = useRef<HTMLDivElement>(null);
  const [artikler, setArtikler] = useState<ArtikelResultat[] | null>(null);
  const [artiklerLoading, setArtiklerLoading] = useState(false);

  // Focus-trap + Escape-luk (WCAG AA — matcher BugReportModal-mønster).
  useEffect(() => {
    if (!open) return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || focusable.length === 0) return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    first?.focus();
    return () => document.removeEventListener('keydown', trap);
  }, [open, onClose]);

  // Hent understøttende artikler asynkront (Serper phase=raw, ingen tokens).
  // Kun specifikke virksomheds-nævnelser — ikke generiske branche-nyheder.
  useEffect(() => {
    if (!open) {
      setArtikler(null);
      return;
    }
    let aktiv = true;
    setArtiklerLoading(true);
    (async () => {
      try {
        const res = await fetch('/api/ai/article-search/articles?phase=raw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entityType: 'company',
            companyName: virksomhedNavn,
            cvr: virksomhedCvr,
          }),
        });
        if (!aktiv) return;
        if (res.ok) {
          const data = await res.json();
          setArtikler(Array.isArray(data.articles) ? data.articles.slice(0, 5) : []);
        } else {
          setArtikler([]);
        }
      } catch {
        if (aktiv) setArtikler([]);
      } finally {
        if (aktiv) setArtiklerLoading(false);
      }
    })();
    return () => {
      aktiv = false;
    };
  }, [open, virksomhedNavn, virksomhedCvr]);

  if (!open) return null;

  // Vis breakdown kun når både berig-resultatet og dets breakdown findes;
  // TS narrower'er så `berig` til non-null inde i blokken nedenfor.
  const bd = berig && berig.breakdown ? berig.breakdown : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vh-detail-title"
        className="relative z-10 w-full max-w-2xl max-h-[85vh] overflow-y-auto thick-scroll rounded-2xl border border-slate-700/50 bg-[#0f172a] p-6 shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 id="vh-detail-title" className="text-lg font-semibold text-white">
              {virksomhedNavn}
            </h2>
            <p className="text-slate-400 text-xs font-mono mt-0.5">CVR {virksomhedCvr}</p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('Luk', 'Close')}
            className="text-slate-400 hover:text-white transition-colors shrink-0"
          >
            <X size={20} />
          </button>
        </div>

        {berig && bd ? (
          <>
            {/* Estimeret transaktionsværdi (hero) */}
            <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-4 mb-5">
              <p className="text-slate-400 text-xs uppercase tracking-wider mb-1">
                {t('Estimeret transaktionsværdi', 'Estimated transaction value')}
              </p>
              <p className="text-2xl font-bold text-emerald-300">
                {fmt(bd.transaktionsvaerdi.lav)} – {fmt(bd.transaktionsvaerdi.hoej)}
              </p>
              <p className="text-slate-400 text-xs mt-1">
                {t('Midtpunkt', 'Midpoint')}: {fmt(bd.transaktionsvaerdi.mid)}
              </p>
            </div>

            {/* AI-vurdering (Claude, forankret i baseline) */}
            {berig.ai_vurdering && berig.ai_vurdering.vurdering && (
              <section className="mb-5 rounded-xl bg-violet-500/5 border border-violet-500/20 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles size={15} className="text-violet-300 shrink-0" />
                  <h3 className="text-sm font-semibold text-white">
                    {t('AI-vurdering', 'AI assessment')}
                  </h3>
                  {/* Token-forbrug — vist når et nyt Claude-kald faktisk skete
                      (ikke på cache-hits), så det aligner med øvrige AI-handlinger. */}
                  {typeof berig.tokensUsed === 'number' &&
                    berig.tokensUsed > 0 &&
                    !berig.fromCache && (
                      <span className="text-slate-400 text-xs ml-auto">
                        ({berig.tokensUsed.toLocaleString()} tokens)
                      </span>
                    )}
                </div>
                <p className="text-slate-200 text-xs leading-relaxed mb-3">
                  {berig.ai_vurdering.vurdering}
                </p>
                {berig.ai_vurdering.vaerdidrivere.length > 0 && (
                  <div className="mb-3">
                    <p className="flex items-center gap-1.5 text-emerald-300 text-xs font-medium mb-1">
                      <TrendingUp size={12} className="shrink-0" />
                      {t('Værdidrivere', 'Value drivers')}
                    </p>
                    <ul className="space-y-1">
                      {berig.ai_vurdering.vaerdidrivere.map((d, i) => (
                        <li key={i} className="text-slate-400 text-xs flex gap-2">
                          <span className="text-emerald-400 shrink-0">•</span>
                          <span>{d}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {berig.ai_vurdering.risici.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1.5 text-amber-300 text-xs font-medium mb-1">
                      <AlertTriangle size={12} className="shrink-0" />
                      {t('Risici', 'Risks')}
                    </p>
                    <ul className="space-y-1">
                      {berig.ai_vurdering.risici.map((r, i) => (
                        <li key={i} className="text-slate-400 text-xs flex gap-2">
                          <span className="text-amber-400 shrink-0">•</span>
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}

            {/* Beregnings-breakdown */}
            <section className="mb-5">
              <h3 className="text-sm font-semibold text-white mb-2">
                {t('Sådan er det beregnet', 'How it is calculated')}
              </h3>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between gap-4">
                  <span className="text-slate-400">
                    {t('EBITDA-proxy (resultat før skat)', 'EBITDA proxy (profit before tax)')}
                  </span>
                  <span className="text-slate-200 tabular-nums">{fmt(bd.ebitda_used)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-slate-400">
                    {t('Branche-multiple', 'Industry multiple')} ({bd.branche_label})
                  </span>
                  <span className="text-slate-200 tabular-nums">
                    {bd.multiple.lav}–{bd.multiple.hoej}x ({t('mid', 'mid')} {bd.multiple.mid}x)
                  </span>
                </div>
                <div className="flex justify-between gap-4 border-t border-slate-700/40 pt-1.5">
                  <span className="text-slate-300">
                    {t('Enterprise value', 'Enterprise value')} = EBITDA × multiple
                  </span>
                  <span className="text-slate-100 tabular-nums">
                    {fmt(bd.ev_range.lav)} – {fmt(bd.ev_range.hoej)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-slate-300">
                    {t('Ejerandels-ændring', 'Ownership change')}
                  </span>
                  <span className="text-slate-100 tabular-nums">{bd.delta_pct} pp</span>
                </div>
                <div className="flex justify-between gap-4 border-t border-slate-700/40 pt-1.5">
                  <span className="text-emerald-300 font-medium">
                    {t('Transaktionsværdi', 'Transaction value')} = EV × delta%
                  </span>
                  <span className="text-emerald-300 font-medium tabular-nums">
                    {fmt(bd.transaktionsvaerdi.lav)} – {fmt(bd.transaktionsvaerdi.hoej)}
                  </span>
                </div>
              </div>
            </section>

            {/* Confidence */}
            <section className="mb-5">
              <div className="flex items-center gap-2 mb-1.5">
                <h3 className="text-sm font-semibold text-white">{t('Sikkerhed', 'Confidence')}</h3>
                <span
                  className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${CONFIDENCE_STYLES[berig.confidence]}`}
                >
                  {berig.confidence}
                </span>
              </div>
              <p className="text-slate-400 text-xs leading-relaxed">{berig.confidence_reason}</p>
            </section>

            {/* Datakilder */}
            <section className="mb-5">
              <h3 className="text-sm font-semibold text-white mb-2">
                {t('Datakilder', 'Data sources')}
              </h3>
              <ul className="space-y-1">
                {berig.data_sources.map((s, i) => (
                  <li key={i} className="text-slate-400 text-xs flex gap-2">
                    <span className="text-emerald-400 shrink-0">•</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Caveats */}
            {berig.caveats.length > 0 && (
              <section className="mb-5">
                <h3 className="text-sm font-semibold text-white mb-2">
                  {t('Forbehold', 'Caveats')}
                </h3>
                <ul className="space-y-1">
                  {berig.caveats.map((c, i) => (
                    <li key={i} className="text-slate-400 text-xs flex gap-2">
                      <span className="text-amber-400 shrink-0">⚠</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <p className="text-slate-400 text-sm mb-5">
            {t(
              'Transaktionsværdi kunne ikke estimeres — regnskab eller branche-multiple mangler.',
              'Transaction value could not be estimated — financials or industry multiple missing.'
            )}
          </p>
        )}

        {/* Understøttende artikler (Serper phase=raw) */}
        <section>
          <h3 className="text-sm font-semibold text-white mb-2">
            {t('Relevante artikler', 'Relevant articles')}
          </h3>
          {artiklerLoading ? (
            <p className="text-slate-400 text-xs">{t('Søger artikler…', 'Searching articles…')}</p>
          ) : artikler && artikler.length > 0 ? (
            <ul className="space-y-2">
              {artikler.map((a, i) => (
                <li key={i}>
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-start gap-2 text-xs"
                  >
                    <ExternalLink
                      size={12}
                      className="text-blue-400 mt-0.5 shrink-0 group-hover:text-blue-300"
                    />
                    <span>
                      <span className="text-blue-400 group-hover:text-blue-300 group-hover:underline">
                        {a.title}
                      </span>
                      <span className="text-slate-400 ml-1">
                        — {a.source}
                        {a.date ? ` · ${a.date}` : ''}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-400 text-xs">
              {t(
                'Ingen specifikke artikler fundet om denne virksomhed.',
                'No specific articles found for this company.'
              )}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
