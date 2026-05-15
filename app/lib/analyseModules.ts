/**
 * Analyse-modul registry med feature flags og plan-gating.
 *
 * BIZZ-1240: Alle analyse-moduler bag feature flags — kun synlige
 * i prod når eksplicit enabled. Dev/preview har altid adgang.
 *
 * @module app/lib/analyseModules
 */

/** Environment targets for feature flags */
type EnvTarget = 'dev' | 'preview' | 'prod';

/** Modul-registrering med feature flag og plan-krav */
export interface AnalyseModuleConfig {
  /** Unik ID — matcher path /dashboard/analyse/[id] */
  id: string;
  /** Dansk label */
  label: string;
  /** Engelsk label */
  labelEn: string;
  /** Lucide ikon-navn */
  icon: string;
  /** Full route path */
  path: string;
  /** Feature flag — per miljø */
  enabled: Record<EnvTarget, boolean>;
  /** Krævet abonnementsplan (null = gratis) */
  requiredPlan: 'professionel' | 'enterprise' | null;
  /** Kort beskrivelse (DA) */
  description: string;
  /** BIZZ-1249: Default target-type for søgefeltet */
  defaultTarget: 'person' | 'virksomhed' | 'ejendom';
  /** BIZZ-1249: Kort hjælpetekst der forklarer hvad brugeren får */
  hint: string;
}

/** Registrerede analyse-moduler */
export const ANALYSE_MODULES: AnalyseModuleConfig[] = [
  {
    id: 'annonce',
    label: 'Boligannonce',
    labelEn: 'Property listing',
    icon: 'Sparkles',
    path: '/dashboard/analyse/annonce',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: null,
    description: 'AI-genereret boligannonce med tone-vælger og BBR-data',
    defaultTarget: 'ejendom',
    hint: 'Søg en ejendom og vælg annonce-tone. AI henter BBR-data, vurdering og energimærke automatisk.',
  },
  {
    id: 'forsikring',
    label: 'Forsikrings-gap',
    labelEn: 'Insurance gap',
    icon: 'ShieldCheck',
    path: '/dashboard/forsikring',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'professionel',
    description:
      'Upload police-filer (PDF/Excel/Word/billeder), find dækningsgaps og prioritér risici',
    defaultTarget: 'virksomhed',
    hint: 'Upload én eller flere police-filer. AI parser indhold, normaliserer dækninger og finder kritiske gaps (insekt/svamp, glas, restværdi etc.).',
  },
  {
    id: 'kreditvurdering',
    label: 'Kreditvurdering',
    labelEn: 'Credit assessment',
    icon: 'CreditCard',
    path: '/dashboard/analyse/kreditvurdering',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'professionel',
    description: 'Virksomheds-kreditpakke med nøgletal og risiko-scoring',
    defaultTarget: 'virksomhed',
    hint: 'Søg en virksomhed. AI henter regnskab, ejerskab, ejendomme med hæftelser og beregner kreditværdighed.',
  },
  {
    id: 'due-diligence',
    label: 'Due Diligence',
    labelEn: 'Due Diligence',
    icon: 'FileSearch',
    path: '/dashboard/analyse/due-diligence',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'enterprise',
    description: 'Automatisk DD-rapport med virksomheds-, ejendoms- og persondata',
    defaultTarget: 'virksomhed',
    hint: 'Vælg virksomhed (transaktions-DD) eller ejendom (ejendoms-DD). AI genererer fuld juridisk rapport.',
  },
  {
    id: 'aml-kyc',
    label: 'AML/KYC',
    labelEn: 'AML/KYC',
    icon: 'ShieldCheck',
    path: '/dashboard/analyse/aml-kyc',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'enterprise',
    description: 'KYC-rapport med beneficial ownership, struktur-kompleksitet og risikoscoring',
    defaultTarget: 'virksomhed',
    hint: 'Søg en virksomhed. AI kortlægger ejerskabskæde, identificerer beneficial owners og scorer risiko.',
  },
  {
    id: 'ejendomsinvestor',
    label: 'Ejendomsinvestor',
    labelEn: 'Property investor',
    icon: 'TrendingUp',
    path: '/dashboard/analyse/ejendomsinvestor',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'professionel',
    description: 'Portefølje-analyse og deal-screening for ejendomsinvestorer',
    defaultTarget: 'virksomhed',
    hint: 'Vælg virksomhed (portefølje-analyse) eller ejendom (deal-screening). AI beregner yield, belåning og friværdi.',
  },
  {
    id: 'revisor-benchmark',
    label: 'Revisor-benchmark',
    labelEn: 'Auditor benchmark',
    icon: 'BarChart3',
    path: '/dashboard/analyse/revisor-benchmark',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'professionel',
    description: 'Nøgletalsbenchmark og koncern-analyse for revisorer',
    defaultTarget: 'virksomhed',
    hint: 'Søg en virksomhed. AI sammenligner nøgletal med branche-gennemsnit og analyserer koncernstruktur.',
  },
  {
    id: 'inkasso-aktivsoegning',
    label: 'Inkasso aktivsøgning',
    labelEn: 'Debt collection asset search',
    icon: 'Search',
    path: '/dashboard/analyse/inkasso-aktivsoegning',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'professionel',
    description: 'Find debitors aktiver for inkassosager',
    defaultTarget: 'person',
    hint: 'Søg en person (debitor). AI finder ejendomme, virksomheder, køretøjer og vurderer udlægspotentiale.',
  },
  {
    id: 'kommune-energi',
    label: 'Kommune energi',
    labelEn: 'Municipal energy',
    icon: 'Building2',
    path: '/dashboard/analyse/kommune-energi',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'enterprise',
    description: 'Bygningsmasse-analyse og energirenoverings-potentiale',
    defaultTarget: 'ejendom',
    hint: 'Vælg en kommune eller ejendom. AI analyserer bygningsmasse, energimærker og renoveringspotentiale.',
  },
];

/**
 * Bestem nuværende miljø.
 *
 * @returns 'prod' | 'preview' | 'dev'
 */
function getCurrentEnv(): EnvTarget {
  if (process.env.VERCEL_ENV === 'production') return 'prod';
  if (process.env.VERCEL_ENV === 'preview') return 'preview';
  return 'dev';
}

/**
 * Returnerer kun de analyse-moduler der er enabled i nuværende miljø.
 *
 * @returns Filtreret liste af enabled moduler
 */
export function getEnabledModules(): AnalyseModuleConfig[] {
  const env = getCurrentEnv();
  return ANALYSE_MODULES.filter((m) => m.enabled[env]);
}

/**
 * Tjek om et specifikt modul er enabled.
 *
 * @param moduleId - Modul-ID
 * @returns true hvis modulet er enabled i nuværende miljø
 */
export function isModuleEnabled(moduleId: string): boolean {
  const env = getCurrentEnv();
  const mod = ANALYSE_MODULES.find((m) => m.id === moduleId);
  return mod?.enabled[env] ?? false;
}
