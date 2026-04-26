'use client';

/**
 * Onboarding modal shown to first-time users.
 *
 * Guides users through a 4-step introduction:
 *   0. Beta disclaimer — acceptance of beta status + feedback instructions
 *   1. Welcome — what BizzAssist does
 *   2. Search — how to find properties and companies
 *   3. AI — how to use the AI assistant
 *
 * Completion is stored in localStorage so it only shows once.
 *
 * @returns Modal component or null if already completed
 */

import { useState, useEffect, useRef } from 'react';
import {
  Building2,
  Search,
  Sparkles,
  ArrowRight,
  X,
  Check,
  FlaskConical,
  MessageSquare,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { createClient } from '@/lib/supabase/client';
import { companyInfo } from '@/app/lib/companyInfo';

/** localStorage key to track onboarding completion */
const ONBOARDING_KEY = 'ba-onboarding-done';

/** Step definition for standard steps */
interface OnboardingStep {
  icon: typeof Building2;
  iconColor: string;
  iconBg: string;
  titleDa: string;
  titleEn: string;
  descriptionDa: string;
  descriptionEn: string;
}

/** Standard onboarding steps (shown after the beta step) */
const STEPS: OnboardingStep[] = [
  {
    icon: Building2,
    iconColor: 'text-emerald-400',
    iconBg: 'bg-emerald-500/20',
    titleDa: 'Velkommen til BizzAssist',
    titleEn: 'Welcome to BizzAssist',
    descriptionDa:
      'BizzAssist samler data om ejendomme, virksomheder og ejere fra alle offentlige danske datakilder — ét sted, med AI-analyse.',
    descriptionEn:
      'BizzAssist aggregates data about properties, companies, and owners from all public Danish data sources — one place, with AI analysis.',
  },
  {
    icon: Search,
    iconColor: 'text-blue-400',
    iconBg: 'bg-blue-500/20',
    titleDa: 'Søg efter alt',
    titleEn: 'Search for anything',
    descriptionDa:
      'Brug søgefeltet i topmenuen til at finde ejendomme, virksomheder og ejere. Start med en adresse, et CVR-nummer eller et firmanavn.',
    descriptionEn:
      'Use the search bar at the top to find properties, companies, and owners. Start with an address, CVR number, or company name.',
  },
  {
    icon: Sparkles,
    iconColor: 'text-purple-400',
    iconBg: 'bg-purple-500/20',
    titleDa: 'AI Chat',
    titleEn: 'AI Chat',
    descriptionDa:
      'Stil spørgsmål til AI-assistenten i sidepanelet — den har adgang til alle de datakilder, som BizzAssist bruger, og kan svare med kontekst fra den side du er på.',
    descriptionEn:
      'Ask the AI assistant in the side panel — it has access to all the data sources BizzAssist uses, and can answer with context from the page you are viewing.',
  },
];

/** Total step count including the beta disclaimer step */
const TOTAL_STEPS = STEPS.length + 1;

/** Onboarding modal component — no props, reads language from context. */
export default function OnboardingModal() {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  const modalRef = useRef<HTMLDivElement>(null);

  /**
   * Check if onboarding has been completed.
   * Checks Supabase user_metadata first (cross-device), falls back to localStorage.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Check localStorage immediately (fast path)
      try {
        if (localStorage.getItem(ONBOARDING_KEY)) return;
      } catch {
        /* ignore */
      }

      // 2. Check Supabase user_metadata (cross-device source of truth)
      // BIZZ-340: Also check onboarding_complete (set by onboarding page flow)
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user?.user_metadata?.onboarding_done || user?.user_metadata?.onboarding_complete) {
          // Sync to localStorage so we skip the async check next time
          try {
            localStorage.setItem(
              ONBOARDING_KEY,
              String(user.user_metadata.onboarding_done ?? Date.now())
            );
          } catch {
            /* ignore */
          }
          return;
        }
      } catch {
        /* Supabase unavailable — fall through to show onboarding */
      }

      if (cancelled) return;
      // Small delay so the dashboard loads first
      const timer = setTimeout(() => setShow(true), 800);
      return () => clearTimeout(timer);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Mark onboarding as complete — saves to both Supabase user_metadata and localStorage. */
  const complete = () => {
    const ts = Date.now();
    // Persist to localStorage (sync, immediate)
    try {
      localStorage.setItem(ONBOARDING_KEY, String(ts));
    } catch {
      /* ignore */
    }
    // Persist to Supabase user_metadata (async, cross-device)
    createClient()
      .auth.updateUser({ data: { onboarding_done: ts } })
      .catch(() => {
        /* non-fatal — localStorage already set */
      });
    setShow(false);
  };

  /** Advance to next step or complete */
  const next = () => {
    if (step < TOTAL_STEPS - 1) {
      setStep(step + 1);
    } else {
      complete();
    }
  };

  /**
   * Focus trap: keeps keyboard focus inside the modal while it is open.
   * Focuses the first focusable element on mount.
   */
  useEffect(() => {
    if (!show) return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const trap = (e: KeyboardEvent) => {
      // BIZZ-212: Escape key closes the modal (keyboard equivalent of clicking backdrop)
      if (e.key === 'Escape') {
        complete();
        return;
      }
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', trap);
    first?.focus();
    return () => document.removeEventListener('keydown', trap);
  }, [show]);

  if (!show) return null;

  const isLast = step === TOTAL_STEPS - 1;
  /** Step 0 is the beta disclaimer, steps 1+ map to STEPS[step - 1] */
  const isBetaStep = step === 0;
  const current = isBetaStep ? null : STEPS[step - 1];
  const Icon = current?.icon ?? FlaskConical;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={complete}
        role="presentation"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-modal-title"
        className="relative bg-[#1e293b] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
      >
        {/* Close button */}
        <button
          onClick={complete}
          aria-label="Luk"
          className="absolute top-4 right-4 text-slate-500 hover:text-white transition-colors z-10"
        >
          <X size={18} />
        </button>

        {/* Step indicators */}
        <div
          className="flex items-center gap-2 px-6 pt-6"
          aria-label={`${da ? 'Trin' : 'Step'} ${step + 1} ${da ? 'af' : 'of'} ${TOTAL_STEPS}`}
          role="progressbar"
          aria-valuenow={step + 1}
          aria-valuemin={1}
          aria-valuemax={TOTAL_STEPS}
        >
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= step ? 'bg-blue-500' : 'bg-slate-700'
              }`}
            />
          ))}
        </div>

        {/* Beta disclaimer step */}
        {isBetaStep ? (
          <div className="px-6 py-7">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-12 h-12 bg-amber-500/20 rounded-xl flex items-center justify-center shrink-0">
                <FlaskConical size={22} className="text-amber-400" />
              </div>
              <div>
                <h2
                  id="onboarding-modal-title"
                  className="text-lg font-bold text-white leading-tight"
                >
                  BizzAssist Beta
                </h2>
                <span className="text-xs font-medium text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
                  {da ? 'Beta-version' : 'Beta version'}
                </span>
              </div>
            </div>

            <p className="text-slate-300 text-sm leading-relaxed mb-4">
              {da
                ? 'Velkommen til BizzAssist beta-version. Da produktet er under aktiv udvikling, kan der forekomme fejl og mangler. Vi arbejder løbende på at forbedre platformen og sætter stor pris på din feedback.'
                : 'Welcome to the BizzAssist beta version. As the product is under active development, errors and limitations may occur. We continuously work to improve the platform and greatly value your feedback.'}
            </p>

            <div className="bg-slate-800/60 border border-white/5 rounded-xl p-4 mb-5">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                {da ? 'Ved at fortsætte accepterer du at:' : 'By continuing you accept that:'}
              </p>
              <ul className="space-y-1.5">
                {(da
                  ? [
                      'Produktet er i beta og kan indeholde fejl',
                      'Data og funktionalitet kan ændre sig uden varsel',
                      'Vi indsamler anonymiseret brugsdata for at forbedre produktet',
                    ]
                  : [
                      'The product is in beta and may contain errors',
                      'Data and functionality may change without notice',
                      'We collect anonymised usage data to improve the product',
                    ]
                ).map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-slate-300">
                    <span className="text-blue-400 mt-0.5 shrink-0">•</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Feedback section */}
            <div className="bg-blue-900/20 border border-blue-500/20 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <MessageSquare size={14} className="text-blue-400" />
                <p className="text-xs font-semibold text-blue-400">
                  {da ? 'Fandt du en fejl?' : 'Found a bug?'}
                </p>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-2">
                {da
                  ? 'Som beta-bruger er din feedback uvurderlig. Klik på 💬-ikonet i nederste højre hjørne, beskriv fejlen kort — hvad skete der og hvad forventede du? Du kan også sende feedback direkte til '
                  : 'As a beta user your feedback is invaluable. Click the 💬 icon in the bottom-right corner, briefly describe the issue — what happened and what did you expect? You can also send feedback directly to '}
                <a
                  href={`mailto:${companyInfo.supportEmail}`}
                  className="text-blue-400 hover:underline"
                >
                  {companyInfo.supportEmail}
                </a>
              </p>
            </div>
          </div>
        ) : (
          /* Standard step content */
          <div className="px-6 py-8 text-center">
            <div
              className={`w-14 h-14 ${current!.iconBg} rounded-xl flex items-center justify-center mx-auto mb-5`}
            >
              <Icon size={26} className={current!.iconColor} />
            </div>

            <h2 id="onboarding-modal-title" className="text-xl font-bold text-white mb-3">
              {da ? current!.titleDa : current!.titleEn}
            </h2>

            <p className="text-slate-400 text-sm leading-relaxed max-w-sm mx-auto">
              {da ? current!.descriptionDa : current!.descriptionEn}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="px-6 pb-6 flex items-center justify-between">
          <button
            onClick={complete}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            {da ? 'Spring over' : 'Skip'}
          </button>

          <button
            onClick={next}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm px-5 py-2.5 rounded-xl transition-colors"
          >
            {isLast ? (
              <>
                {da ? 'Kom i gang' : 'Get started'}
                <Check size={16} />
              </>
            ) : isBetaStep ? (
              <>
                {da ? 'Forstået — fortsæt' : 'Understood — continue'}
                <ArrowRight size={16} />
              </>
            ) : (
              <>
                {da ? 'Næste' : 'Next'}
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
