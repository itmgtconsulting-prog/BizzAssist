'use client';

/**
 * Onboarding modal shown to first-time users.
 *
 * Guides users through a 3-step introduction:
 *   1. Welcome — what BizzAssist does
 *   2. Search — how to find properties and companies
 *   3. AI — how to use the AI assistant
 *
 * Completion is stored in localStorage so it only shows once.
 *
 * @returns Modal component or null if already completed
 */

import { useState, useEffect } from 'react';
import { Building2, Search, Sparkles, ArrowRight, X, Check } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

/** localStorage key to track onboarding completion */
const ONBOARDING_KEY = 'ba-onboarding-done';

/** Step definition */
interface OnboardingStep {
  icon: typeof Building2;
  iconColor: string;
  iconBg: string;
  titleDa: string;
  titleEn: string;
  descriptionDa: string;
  descriptionEn: string;
}

/** All onboarding steps */
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
    titleDa: 'AI Assistent',
    titleEn: 'AI Assistant',
    descriptionDa:
      'Stil spørgsmål til AI-assistenten i sidepanelet — den har adgang til alle de datakilder, som BizzAssist bruger, og kan svare med kontekst fra den side du er på.',
    descriptionEn:
      'Ask the AI assistant in the side panel — it has access to all the data sources BizzAssist uses, and can answer with context from the page you are viewing.',
  },
];

export default function OnboardingModal() {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);

  /** Check if onboarding has been completed */
  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARDING_KEY)) {
        // Small delay so the dashboard loads first
        const timer = setTimeout(() => setShow(true), 800);
        return () => clearTimeout(timer);
      }
    } catch {
      // localStorage not available
    }
  }, []);

  /** Mark onboarding as complete and close */
  const complete = () => {
    try {
      localStorage.setItem(ONBOARDING_KEY, Date.now().toString());
    } catch {
      // ignore
    }
    setShow(false);
  };

  /** Advance to next step or complete */
  const next = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      complete();
    }
  };

  if (!show) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={complete} />

      {/* Modal */}
      <div className="relative bg-[#1e293b] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Close button */}
        <button
          onClick={complete}
          className="absolute top-4 right-4 text-slate-500 hover:text-white transition-colors z-10"
        >
          <X size={18} />
        </button>

        {/* Step indicators */}
        <div className="flex items-center gap-2 px-6 pt-6">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= step ? 'bg-blue-500' : 'bg-slate-700'
              }`}
            />
          ))}
        </div>

        {/* Content */}
        <div className="px-6 py-8 text-center">
          <div
            className={`w-14 h-14 ${current.iconBg} rounded-xl flex items-center justify-center mx-auto mb-5`}
          >
            <Icon size={26} className={current.iconColor} />
          </div>

          <h2 className="text-xl font-bold text-white mb-3">
            {da ? current.titleDa : current.titleEn}
          </h2>

          <p className="text-slate-400 text-sm leading-relaxed max-w-sm mx-auto">
            {da ? current.descriptionDa : current.descriptionEn}
          </p>
        </div>

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
