/**
 * BIZZ-806: Central farve- og ikon-mapping pr. entitetstype.
 *
 * Bruges af /dashboard/search (universel søgning), domain/sager kunde-
 * picker, og evt. andre entitets-liste-komponenter. Sikrer konsistent
 * visuel identifikation på tværs af appen:
 *
 *   - Ejendom      → emerald (grøn) + Home/MapPin
 *   - Virksomhed   → blue (blå)     + Briefcase
 *   - Person       → purple (lilla) + User
 *
 * Konsumenter får både icon-komponent-reference (lucide-react) og
 * præ-computede Tailwind-klasser til bg/text/border så rendering er
 * én linje uden per-type conditionals.
 */

import { Home, Briefcase, User, Building2, type LucideIcon } from 'lucide-react';

export type EntityKind = 'ejendom' | 'virksomhed' | 'person';

/**
 * BIZZ-859: Sub-type for ejendoms-hierarki. Bruges til type-badges
 * og breadcrumb-labels på tværs af søg og detaljesider.
 *
 *   sfe            → Samlet Fast Ejendom (matrikel-niveau)
 *   hovedejendom   → Ejerlejlighed der selv er opdelt i lejligheder
 *   ejerlejlighed  → Leaf-niveau enhed med etage/dør
 *   bygning        → Bygning på SFE uden opdelt-status
 */
export type EjendomKind = 'sfe' | 'hovedejendom' | 'ejerlejlighed' | 'bygning';

/** Badge-style for ejendoms-hierarki-niveau. */
export interface EjendomKindStyle {
  Icon: LucideIcon;
  chip: string;
  badgeDa: string;
  badgeEn: string;
  tooltipDa: string;
  tooltipEn: string;
}

const EJENDOM_STYLES: Record<EjendomKind, EjendomKindStyle> = {
  sfe: {
    Icon: Building2,
    chip: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
    badgeDa: 'SFE',
    badgeEn: 'SFE',
    tooltipDa:
      'Samlet Fast Ejendom — matrikel-niveau ejendom der samler bygninger og ejerlejligheder',
    tooltipEn:
      'Collective Real Property — cadastral-level property combining buildings and condominiums',
  },
  hovedejendom: {
    Icon: Building2,
    chip: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
    badgeDa: 'Hovedejendom',
    badgeEn: 'Main property',
    tooltipDa: 'Ejerlejlighed der selv er opdelt i flere lejligheder',
    tooltipEn: 'Condominium that is itself subdivided into multiple units',
  },
  ejerlejlighed: {
    Icon: Home,
    chip: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    badgeDa: 'Ejerlejlighed',
    badgeEn: 'Condominium',
    tooltipDa: 'Ejerlejlighed under en hovedejendom',
    tooltipEn: 'Condominium unit under a main property',
  },
  bygning: {
    Icon: Building2,
    chip: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    badgeDa: 'Bygning',
    badgeEn: 'Building',
    tooltipDa: 'Bygning med egen vurdering',
    tooltipEn: 'Building with own valuation',
  },
};

/**
 * BIZZ-859: Returnerer style for en given ejendoms-hierarki-type.
 */
export function getEjendomKindStyle(kind: EjendomKind): EjendomKindStyle {
  return EJENDOM_STYLES[kind];
}

export interface EntityStyle {
  /** Lucide icon component (default rendering) */
  Icon: LucideIcon;
  /** Tailwind className for text-color (fx "text-emerald-400") */
  textColor: string;
  /** Tailwind className for background + border (chip/avatar-container)
   *  fx "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" */
  chip: string;
  /** Tailwind className for ikon-avatar-baggrund uden border */
  iconBg: string;
  /**
   * BIZZ-853: Tailwind-klasser til klikbare links på entitetstypen.
   * Inklusive hover (farveskift) + focus-visible (tastatur-ring) +
   * transition + cursor. Bruges af EntityLink.tsx + alle inline
   * <a>/<Link>-references i detaljeviews.
   */
  link: string;
  /** Dansk badge-label (kort kategori-navn til chip-tekst) */
  badgeDa: string;
  /** Engelsk badge-label */
  badgeEn: string;
}

const STYLES: Record<EntityKind, EntityStyle> = {
  ejendom: {
    Icon: Home,
    textColor: 'text-emerald-400',
    chip: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    iconBg: 'bg-emerald-500/10 text-emerald-400',
    link: 'text-slate-200 hover:text-emerald-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:rounded-sm transition-colors cursor-pointer',
    badgeDa: 'Ejendom',
    badgeEn: 'Property',
  },
  virksomhed: {
    Icon: Briefcase,
    textColor: 'text-blue-400',
    chip: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    iconBg: 'bg-blue-500/10 text-blue-400',
    link: 'text-slate-200 hover:text-blue-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:rounded-sm transition-colors cursor-pointer',
    badgeDa: 'Virksomhed',
    badgeEn: 'Company',
  },
  person: {
    Icon: User,
    textColor: 'text-purple-400',
    chip: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    iconBg: 'bg-purple-500/10 text-purple-400',
    link: 'text-slate-200 hover:text-purple-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:rounded-sm transition-colors cursor-pointer',
    badgeDa: 'Person',
    badgeEn: 'Person',
  },
};

/**
 * Returnerer komplet style-objekt for en given entitetstype.
 * Kast ikke ved ukendt input — returnerer person-fallback som er
 * neutral-nok til ikke at vildlede UI.
 *
 * @param kind - Entitetstype ('ejendom' | 'virksomhed' | 'person')
 */
export function getEntityStyle(kind: EntityKind): EntityStyle {
  return STYLES[kind] ?? STYLES.person;
}

/**
 * Genvej: få badge-label i den ønskede sprog-form.
 */
export function getEntityBadge(kind: EntityKind, lang: 'da' | 'en'): string {
  const s = getEntityStyle(kind);
  return lang === 'da' ? s.badgeDa : s.badgeEn;
}

/**
 * Map legacy search-api `type`-streng ('company' | 'person' | 'address')
 * til central EntityKind. `address` kortlægges til 'ejendom'.
 */
export function mapLegacyType(legacyType: 'address' | 'company' | 'person'): EntityKind {
  switch (legacyType) {
    case 'address':
      return 'ejendom';
    case 'company':
      return 'virksomhed';
    case 'person':
      return 'person';
  }
}
