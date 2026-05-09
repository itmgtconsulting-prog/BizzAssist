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
  },
  {
    id: 'forsikring',
    label: 'Forsikrings-gap',
    labelEn: 'Insurance gap',
    icon: 'Shield',
    path: '/dashboard/analyse/forsikring',
    enabled: { dev: true, preview: true, prod: false },
    requiredPlan: 'professionel',
    description: 'Identificér dækningsgab i kundens forsikringsportefølje',
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
