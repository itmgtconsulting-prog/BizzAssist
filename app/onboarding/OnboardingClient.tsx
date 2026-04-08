'use client';

/**
 * Onboarding page — app/onboarding/page.tsx
 *
 * Full-page, multi-step setup flow shown to new users after signup,
 * before they reach the dashboard. Steps:
 *
 *   1. Velkomst      — welcome message with user's name
 *   2. Din virksomhed — company name (CVR autocomplete), industry, headcount
 *   3. Vælg plan     — pricing cards (Gratis / Pro / Enterprise)
 *   4. Kom i gang    — completion screen with quick-start links
 *
 * On completion:
 *   - Saves company name to `public.tenants` (name column) via /api/onboarding
 *   - Sets `user_metadata.onboarding_complete = true` via supabase.auth.updateUser
 *   - Redirects to /dashboard
 *
 * @returns Full-page onboarding wizard
 */

import { useState, useEffect, useCallback, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Building2,
  Briefcase,
  Check,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Search,
  Loader2,
  ChevronDown,
  Star,
  Zap,
  Shield,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/app/context/LanguageContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a CVR autocomplete suggestion */
interface CvrSuggestion {
  /** Company CVR number */
  cvr: string;
  /** Company name */
  name: string;
}

/** Industry option for the dropdown */
interface IndustryOption {
  value: string;
  labelDa: string;
  labelEn: string;
}

/** Headcount option for the dropdown */
interface HeadcountOption {
  value: string;
  labelDa: string;
  labelEn: string;
}

/** Pricing plan card definition */
interface PlanCard {
  id: 'free' | 'pro' | 'enterprise';
  icon: typeof Star;
  iconColor: string;
  iconBg: string;
  nameDa: string;
  nameEn: string;
  priceDa: string;
  priceEn: string;
  featuresDa: string[];
  featuresEn: string[];
  ctaDa: string;
  ctaEn: string;
  highlighted: boolean;
  comingSoon: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total number of wizard steps */
const TOTAL_STEPS = 4;

/** Industry options for step 2 */
const INDUSTRY_OPTIONS: IndustryOption[] = [
  { value: 'ejendomme', labelDa: 'Ejendomme & Investering', labelEn: 'Real Estate & Investment' },
  { value: 'advokat', labelDa: 'Juridisk / Advokatkontor', labelEn: 'Legal / Law Firm' },
  { value: 'bank', labelDa: 'Bank & Finans', labelEn: 'Banking & Finance' },
  { value: 'revision', labelDa: 'Revision & Regnskab', labelEn: 'Auditing & Accounting' },
  { value: 'konsulent', labelDa: 'Rådgivning & Konsulent', labelEn: 'Consulting & Advisory' },
  { value: 'forsikring', labelDa: 'Forsikring', labelEn: 'Insurance' },
  { value: 'it', labelDa: 'IT & Teknologi', labelEn: 'IT & Technology' },
  { value: 'offentlig', labelDa: 'Offentlig sektor', labelEn: 'Public Sector' },
  { value: 'andet', labelDa: 'Andet', labelEn: 'Other' },
];

/** Headcount options for step 2 */
const HEADCOUNT_OPTIONS: HeadcountOption[] = [
  { value: '1', labelDa: '1 person (solo)', labelEn: '1 person (solo)' },
  { value: '2-10', labelDa: '2–10 medarbejdere', labelEn: '2–10 employees' },
  { value: '11-50', labelDa: '11–50 medarbejdere', labelEn: '11–50 employees' },
  { value: '50+', labelDa: '50+ medarbejdere', labelEn: '50+ employees' },
];

/** Pricing plan definitions for step 3 */
const PLAN_CARDS: PlanCard[] = [
  {
    id: 'free',
    icon: Star,
    iconColor: 'text-slate-300',
    iconBg: 'bg-slate-700/60',
    nameDa: 'Gratis',
    nameEn: 'Free',
    priceDa: '0 kr/md',
    priceEn: '0 DKK/mo',
    featuresDa: [
      '10 søgninger/dag',
      'Ejendomsdata (BBR, vurdering)',
      'Virksomhedsdata (CVR)',
      'Begrænset AI-assistent',
    ],
    featuresEn: [
      '10 searches/day',
      'Property data (BBR, valuation)',
      'Company data (CVR)',
      'Limited AI assistant',
    ],
    ctaDa: 'Fortsæt gratis',
    ctaEn: 'Continue free',
    highlighted: false,
    comingSoon: false,
  },
  {
    id: 'pro',
    icon: Zap,
    iconColor: 'text-blue-400',
    iconBg: 'bg-blue-500/20',
    nameDa: 'Pro',
    nameEn: 'Pro',
    priceDa: '499 kr/md',
    priceEn: '499 DKK/mo',
    featuresDa: [
      'Ubegrænsede søgninger',
      'Fuld AI-assistent (Claude)',
      'Ejendomsrapporter (PDF)',
      'Følg ejendomme & notifikationer',
      'Tinglysningsdata',
    ],
    featuresEn: [
      'Unlimited searches',
      'Full AI assistant (Claude)',
      'Property reports (PDF)',
      'Follow properties & notifications',
      'Mortgage & encumbrance data',
    ],
    ctaDa: 'Kommer snart',
    ctaEn: 'Coming soon',
    highlighted: true,
    comingSoon: true,
  },
  {
    id: 'enterprise',
    icon: Shield,
    iconColor: 'text-purple-400',
    iconBg: 'bg-purple-500/20',
    nameDa: 'Enterprise',
    nameEn: 'Enterprise',
    priceDa: 'Kontakt os',
    priceEn: 'Contact us',
    featuresDa: [
      'Alt i Pro',
      'Systemintegration (API)',
      'Dedikeret support',
      'Tilpasset dataekstraktion',
      'SLA-garanti',
    ],
    featuresEn: [
      'Everything in Pro',
      'System integration (API)',
      'Dedicated support',
      'Custom data extraction',
      'SLA guarantee',
    ],
    ctaDa: 'Kommer snart',
    ctaEn: 'Coming soon',
    highlighted: false,
    comingSoon: true,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * OnboardingPage — multi-step new-user setup wizard.
 *
 * Reads user name from Supabase session for the welcome step.
 * Saves company info to the tenant record and marks onboarding complete
 * in user_metadata before redirecting to /dashboard.
 */
export default function OnboardingClient() {
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [userName, setUserName] = useState('');
  const [tenantId, setTenantId] = useState<string | null>(null);

  // ── Wizard state ───────────────────────────────────────────────────────────
  const [step, setStep] = useState(0);

  // ── Step 2: company fields ─────────────────────────────────────────────────
  const [companyName, setCompanyName] = useState('');
  const [companyCvr, setCompanyCvr] = useState('');
  const [industry, setIndustry] = useState('');
  const [headcount, setHeadcount] = useState('');

  // ── CVR autocomplete state ─────────────────────────────────────────────────
  const [cvrSuggestions, setCvrSuggestions] = useState<CvrSuggestion[]>([]);
  const [loadingCvr, setLoadingCvr] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // ── Step 3: selected plan ─────────────────────────────────────────────────
  const [selectedPlan] = useState<'free' | 'pro' | 'enterprise'>('free');

  // ── Submission state ───────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  /**
   * Load user name and tenant ID from Supabase session on mount.
   * Redirects unauthenticated users to /login.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace('/login');
        return;
      }
      // If onboarding is already complete, skip to dashboard
      if (user.user_metadata?.onboarding_complete === true) {
        router.replace('/dashboard');
        return;
      }
      if (!cancelled) {
        const full = (user.user_metadata?.full_name as string | undefined) ?? '';
        const first = full.split(' ')[0] || user.email?.split('@')[0] || '';
        setUserName(first);
      }
      // Fetch tenant ID for this user (to update the tenant name later)
      try {
        const res = await fetch('/api/onboarding/tenant-id');
        if (res.ok) {
          const json = (await res.json()) as { tenantId: string };
          if (!cancelled) setTenantId(json.tenantId);
        }
      } catch {
        // Non-fatal — tenant name update will be skipped
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  /**
   * Fetch CVR company suggestions from the internal CVR autocomplete endpoint.
   * Debounced via useEffect in the input handler.
   *
   * @param query - Partial company name typed by the user
   */
  const fetchCvrSuggestions = useCallback(async (query: string) => {
    if (query.trim().length < 2) {
      setCvrSuggestions([]);
      return;
    }
    setLoadingCvr(true);
    try {
      const res = await fetch(`/api/cvr-public?q=${encodeURIComponent(query)}&limit=5`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          hits?: Array<{
            _source?: {
              Vrvirksomhed?: {
                cvrNummer?: number;
                virksomhedMetadata?: { nyesteNavn?: { navn?: string } };
              };
            };
          }>;
        };
        const hits = data.hits ?? [];
        const suggestions: CvrSuggestion[] = hits
          .map((hit) => {
            const src = hit._source?.Vrvirksomhed;
            const cvr = String(src?.cvrNummer ?? '');
            const name = src?.virksomhedMetadata?.nyesteNavn?.navn ?? '';
            return { cvr, name };
          })
          .filter((s) => s.cvr && s.name);
        setCvrSuggestions(suggestions);
        setShowSuggestions(suggestions.length > 0);
      }
    } catch {
      // Silently ignore — CVR autocomplete is best-effort
    } finally {
      setLoadingCvr(false);
    }
  }, []);

  /** Handle company name input — triggers CVR autocomplete */
  const handleCompanyNameChange = useCallback(
    (value: string) => {
      setCompanyName(value);
      setCompanyCvr('');
      // Debounce: only fetch after 300 ms of inactivity
      const timer = setTimeout(() => fetchCvrSuggestions(value), 300);
      return () => clearTimeout(timer);
    },
    [fetchCvrSuggestions]
  );

  /**
   * Select a CVR suggestion — fills both company name and CVR fields.
   *
   * @param suggestion - The chosen autocomplete result
   */
  const selectSuggestion = useCallback((suggestion: CvrSuggestion) => {
    setCompanyName(suggestion.name);
    setCompanyCvr(suggestion.cvr);
    setCvrSuggestions([]);
    setShowSuggestions(false);
  }, []);

  /** Navigate to the next wizard step */
  const goNext = useCallback(() => {
    setStep((s) => Math.min(s + 1, TOTAL_STEPS - 1));
  }, []);

  /** Navigate to the previous wizard step */
  const goBack = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  /**
   * Complete onboarding — saves company data and marks user as onboarded.
   * Called on final step submission.
   *
   * @param e - Form submit event (prevents default)
   */
  const handleComplete = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setSaveError('');

      const supabaseClient = createClient();

      try {
        // 1. Save company name to tenant record (via API route — avoids RLS issues)
        if (tenantId && companyName.trim()) {
          const saveRes = await fetch('/api/onboarding/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenantId,
              companyName: companyName.trim(),
              companyCvr: companyCvr || null,
              industry: industry || null,
              headcount: headcount || null,
              plan: selectedPlan,
            }),
          });
          if (!saveRes.ok) {
            // Non-fatal — log but continue
            console.warn('[onboarding] save API failed:', saveRes.status);
          }
        }

        // 2. Mark onboarding complete in Supabase user_metadata
        const { error: updateErr } = await supabaseClient.auth.updateUser({
          data: { onboarding_complete: true },
        });
        if (updateErr) {
          console.warn('[onboarding] updateUser failed:', updateErr.message);
          // Non-fatal — proceed to dashboard anyway
        }

        // 3. Navigate to dashboard
        router.replace('/dashboard');
      } catch (err) {
        console.error('[onboarding] Unexpected error:', err);
        setSaveError(da ? 'Noget gik galt. Prøv igen.' : 'Something went wrong. Please try again.');
      } finally {
        setSaving(false);
      }
    },
    [tenantId, companyName, companyCvr, industry, headcount, selectedPlan, da, router]
  );

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  /** Progress dot indicator */
  const ProgressDots = () => (
    <div
      className="flex items-center justify-center gap-2 mb-8"
      role="progressbar"
      aria-valuenow={step + 1}
      aria-valuemin={1}
      aria-valuemax={TOTAL_STEPS}
      aria-label={da ? `Trin ${step + 1} af ${TOTAL_STEPS}` : `Step ${step + 1} of ${TOTAL_STEPS}`}
    >
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-300 ${
            i === step
              ? 'w-6 h-2 bg-blue-500'
              : i < step
                ? 'w-2 h-2 bg-blue-400/70'
                : 'w-2 h-2 bg-slate-700'
          }`}
        />
      ))}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Step renderers
  // ---------------------------------------------------------------------------

  /** Step 0: Welcome */
  const renderWelcome = () => (
    <div className="text-center">
      <div className="w-16 h-16 bg-blue-500/20 rounded-2xl flex items-center justify-center mx-auto mb-6">
        <Building2 size={30} className="text-blue-400" />
      </div>
      <h1 className="text-2xl font-bold text-white mb-3">
        {da
          ? `Velkommen til BizzAssist${userName ? `, ${userName}` : ''}!`
          : `Welcome to BizzAssist${userName ? `, ${userName}` : ''}!`}
      </h1>
      <p className="text-slate-400 text-sm leading-relaxed mb-8 max-w-sm mx-auto">
        {da
          ? 'BizzAssist samler data om ejendomme, virksomheder og ejere fra alle offentlige danske datakilder — ét sted, med AI-analyse. Lad os sætte din konto op på 2 minutter.'
          : 'BizzAssist aggregates data on properties, companies, and owners from all public Danish data sources — one place, with AI analysis. Let\u2019s set up your account in 2 minutes.'}
      </p>
      <button
        onClick={goNext}
        className="w-full inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm px-6 py-3 rounded-xl transition-colors"
      >
        {da ? 'Kom i gang' : 'Get started'}
        <ArrowRight size={16} />
      </button>
    </div>
  );

  /** Step 1: Company info */
  const renderCompany = () => (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-emerald-500/20 rounded-xl flex items-center justify-center shrink-0">
          <Briefcase size={20} className="text-emerald-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">{da ? 'Din virksomhed' : 'Your company'}</h2>
          <p className="text-xs text-slate-500">
            {da
              ? 'Hjælper os med at tilpasse din oplevelse'
              : 'Helps us personalise your experience'}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Company name + CVR autocomplete */}
        <div className="relative">
          <label
            htmlFor="onboarding-company-name"
            className="block text-xs font-medium text-slate-400 mb-1.5"
          >
            {da ? 'Virksomhedsnavn' : 'Company name'}
          </label>
          <div className="relative">
            <input
              id="onboarding-company-name"
              type="text"
              value={companyName}
              onChange={(e) => handleCompanyNameChange(e.target.value)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onFocus={() => cvrSuggestions.length > 0 && setShowSuggestions(true)}
              placeholder={
                da ? 'Søg virksomhedsnavn eller CVR-nummer…' : 'Search company name or CVR number…'
              }
              autoComplete="off"
              className="w-full bg-slate-800/60 border border-slate-700/60 text-white placeholder-slate-500 text-sm rounded-xl px-4 py-2.5 pr-10 focus:outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/30 transition-colors"
            />
            {loadingCvr && (
              <Loader2
                size={15}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 animate-spin"
              />
            )}
          </div>
          {/* CVR autocomplete dropdown */}
          {showSuggestions && cvrSuggestions.length > 0 && (
            <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-[#1e293b] border border-slate-700/60 rounded-xl shadow-xl overflow-hidden">
              {cvrSuggestions.map((s) => (
                <button
                  key={s.cvr}
                  type="button"
                  onMouseDown={() => selectSuggestion(s)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-left hover:bg-slate-700/50 transition-colors"
                >
                  <span className="text-white font-medium truncate">{s.name}</span>
                  <span className="text-slate-500 text-xs ml-2 shrink-0">CVR {s.cvr}</span>
                </button>
              ))}
            </div>
          )}
          {/* Show selected CVR */}
          {companyCvr && (
            <p className="text-xs text-emerald-400 mt-1">
              {da ? 'CVR-nummer:' : 'CVR number:'} {companyCvr}
            </p>
          )}
        </div>

        {/* Industry */}
        <div>
          <label
            htmlFor="onboarding-industry"
            className="block text-xs font-medium text-slate-400 mb-1.5"
          >
            {da ? 'Branche' : 'Industry'}
          </label>
          <div className="relative">
            <select
              id="onboarding-industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className="w-full appearance-none bg-slate-800/60 border border-slate-700/60 text-sm rounded-xl px-4 py-2.5 pr-9 focus:outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/30 transition-colors text-white"
            >
              <option value="" className="text-slate-500 bg-[#1e293b]">
                {da ? 'Vælg branche…' : 'Select industry…'}
              </option>
              {INDUSTRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-[#1e293b]">
                  {da ? opt.labelDa : opt.labelEn}
                </option>
              ))}
            </select>
            <ChevronDown
              size={15}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
            />
          </div>
        </div>

        {/* Headcount */}
        <div>
          <label
            htmlFor="onboarding-headcount"
            className="block text-xs font-medium text-slate-400 mb-1.5"
          >
            {da ? 'Antal ansatte' : 'Number of employees'}
          </label>
          <div className="relative">
            <select
              id="onboarding-headcount"
              value={headcount}
              onChange={(e) => setHeadcount(e.target.value)}
              className="w-full appearance-none bg-slate-800/60 border border-slate-700/60 text-sm rounded-xl px-4 py-2.5 pr-9 focus:outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/30 transition-colors text-white"
            >
              <option value="" className="text-slate-500 bg-[#1e293b]">
                {da ? 'Vælg størrelse…' : 'Select size…'}
              </option>
              {HEADCOUNT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-[#1e293b]">
                  {da ? opt.labelDa : opt.labelEn}
                </option>
              ))}
            </select>
            <ChevronDown
              size={15}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mt-8">
        <button
          onClick={goBack}
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={15} />
          {da ? 'Tilbage' : 'Back'}
        </button>
        <button
          onClick={goNext}
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-colors"
        >
          {da ? 'Næste' : 'Next'}
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );

  /** Step 2: Plan selection */
  const renderPlan = () => (
    <div>
      <div className="text-center mb-6">
        <h2 className="text-lg font-bold text-white mb-1">
          {da ? 'Vælg en plan' : 'Choose a plan'}
        </h2>
        <p className="text-xs text-slate-500">
          {da ? 'Du kan opgradere når som helst' : 'You can upgrade at any time'}
        </p>
      </div>

      <div className="space-y-3">
        {PLAN_CARDS.map((plan) => {
          const PlanIcon = plan.icon;
          const isSelected = selectedPlan === plan.id;
          return (
            <div
              key={plan.id}
              className={`relative rounded-xl border p-4 transition-all ${
                plan.highlighted
                  ? 'border-blue-500/50 bg-blue-500/5'
                  : 'border-slate-700/60 bg-slate-800/30'
              } ${isSelected ? 'ring-2 ring-blue-500/60' : ''}`}
            >
              {plan.highlighted && (
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-bold px-3 py-0.5 rounded-full uppercase tracking-wide">
                  {da ? 'Mest populær' : 'Most popular'}
                </span>
              )}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 ${plan.iconBg} rounded-lg flex items-center justify-center shrink-0`}
                  >
                    <PlanIcon size={17} className={plan.iconColor} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white">{da ? plan.nameDa : plan.nameEn}</p>
                    <p className="text-xs text-slate-500">{da ? plan.priceDa : plan.priceEn}</p>
                  </div>
                </div>
                {plan.comingSoon ? (
                  <span className="shrink-0 text-[10px] font-semibold text-slate-500 bg-slate-700/60 px-2 py-0.5 rounded-full">
                    {da ? 'Snart' : 'Soon'}
                  </span>
                ) : (
                  <span className="shrink-0 text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                    {da ? 'Aktiv' : 'Active'}
                  </span>
                )}
              </div>
              <ul className="mt-3 space-y-1">
                {(da ? plan.featuresDa : plan.featuresEn).map((feat) => (
                  <li key={feat} className="flex items-center gap-2 text-xs text-slate-400">
                    <Check size={11} className="text-blue-400 shrink-0" />
                    {feat}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-6">
        <button
          onClick={goBack}
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={15} />
          {da ? 'Tilbage' : 'Back'}
        </button>
        <button
          onClick={goNext}
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-colors"
        >
          {da ? 'Fortsæt gratis' : 'Continue free'}
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );

  /** Step 3: Completion — "Du er klar!" with quick-start links */
  const renderDone = () => (
    <form onSubmit={handleComplete}>
      <div className="text-center mb-6">
        <div className="w-16 h-16 bg-emerald-500/20 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <Sparkles size={28} className="text-emerald-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2">
          {da ? 'Du er klar!' : "You're all set!"}
        </h2>
        <p className="text-sm text-slate-400 max-w-xs mx-auto">
          {da
            ? 'Din konto er sat op. Hvad vil du gøre først?'
            : 'Your account is set up. What would you like to do first?'}
        </p>
      </div>

      {/* Quick-start links */}
      <div className="space-y-2 mb-6">
        <Link
          href="/dashboard/ejendomme"
          className="flex items-center gap-3 p-3.5 bg-slate-800/40 border border-slate-700/50 rounded-xl hover:border-blue-500/40 hover:bg-slate-700/40 transition-all group"
        >
          <div className="w-9 h-9 bg-blue-500/15 rounded-lg flex items-center justify-center shrink-0">
            <Building2 size={18} className="text-blue-400" />
          </div>
          <div className="text-left">
            <p className="text-sm font-semibold text-white group-hover:text-blue-300 transition-colors">
              {da ? 'Søg en ejendom' : 'Search a property'}
            </p>
            <p className="text-xs text-slate-500">
              {da
                ? 'Find BBR-data, vurdering, ejerskab m.m.'
                : 'Find BBR data, valuation, ownership etc.'}
            </p>
          </div>
          <ArrowRight
            size={15}
            className="ml-auto text-slate-600 group-hover:text-slate-400 transition-colors shrink-0"
          />
        </Link>

        <Link
          href="/dashboard/companies"
          className="flex items-center gap-3 p-3.5 bg-slate-800/40 border border-slate-700/50 rounded-xl hover:border-emerald-500/40 hover:bg-slate-700/40 transition-all group"
        >
          <div className="w-9 h-9 bg-emerald-500/15 rounded-lg flex items-center justify-center shrink-0">
            <Briefcase size={18} className="text-emerald-400" />
          </div>
          <div className="text-left">
            <p className="text-sm font-semibold text-white group-hover:text-emerald-300 transition-colors">
              {da ? 'Søg en virksomhed' : 'Search a company'}
            </p>
            <p className="text-xs text-slate-500">
              {da ? 'CVR-data, regnskaber, ejere og mere' : 'CVR data, financials, owners and more'}
            </p>
          </div>
          <ArrowRight
            size={15}
            className="ml-auto text-slate-600 group-hover:text-slate-400 transition-colors shrink-0"
          />
        </Link>

        <Link
          href="/dashboard"
          className="flex items-center gap-3 p-3.5 bg-slate-800/40 border border-slate-700/50 rounded-xl hover:border-purple-500/40 hover:bg-slate-700/40 transition-all group"
        >
          <div className="w-9 h-9 bg-purple-500/15 rounded-lg flex items-center justify-center shrink-0">
            <Search size={18} className="text-purple-400" />
          </div>
          <div className="text-left">
            <p className="text-sm font-semibold text-white group-hover:text-purple-300 transition-colors">
              {da ? 'Prøv AI-assistenten' : 'Try the AI assistant'}
            </p>
            <p className="text-xs text-slate-500">
              {da
                ? 'Stil spørgsmål om ejendomme og virksomheder'
                : 'Ask questions about properties and companies'}
            </p>
          </div>
          <ArrowRight
            size={15}
            className="ml-auto text-slate-600 group-hover:text-slate-400 transition-colors shrink-0"
          />
        </Link>
      </div>

      {saveError && <p className="text-xs text-red-400 text-center mb-4">{saveError}</p>}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={goBack}
          disabled={saving}
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-50"
        >
          <ArrowLeft size={15} />
          {da ? 'Tilbage' : 'Back'}
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm px-6 py-2.5 rounded-xl transition-colors disabled:opacity-60"
        >
          {saving ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              {da ? 'Gemmer…' : 'Saving…'}
            </>
          ) : (
            <>
              {da ? 'Gå til dashboard' : 'Go to dashboard'}
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </form>
  );

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  const stepRenderers = [renderWelcome, renderCompany, renderPlan, renderDone];

  return (
    <div className="min-h-screen bg-[#0a1020] flex items-center justify-center p-4">
      {/* Background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-blue-600/5 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-lg">
        {/* Logo / brand */}
        <div className="text-center mb-6">
          <span className="text-lg font-bold text-white tracking-tight">
            Bizz<span className="text-blue-400">Assist</span>
          </span>
        </div>

        {/* Card */}
        <div className="bg-[#0f172a] border border-slate-700/50 rounded-2xl p-8 shadow-2xl">
          <ProgressDots />
          {stepRenderers[step]()}
        </div>

        {/* Skip link */}
        <div className="text-center mt-4">
          <button
            onClick={async () => {
              const supabase = createClient();
              await supabase.auth
                .updateUser({ data: { onboarding_complete: true } })
                .catch(() => {});
              router.replace('/dashboard');
            }}
            className="text-xs text-slate-600 hover:text-slate-400 transition-colors"
          >
            {da ? 'Spring over — gå direkte til dashboard' : 'Skip — go directly to dashboard'}
          </button>
        </div>
      </div>
    </div>
  );
}
