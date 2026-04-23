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

import { Home, Briefcase, User, type LucideIcon } from 'lucide-react';

export type EntityKind = 'ejendom' | 'virksomhed' | 'person';

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
    badgeDa: 'Ejendom',
    badgeEn: 'Property',
  },
  virksomhed: {
    Icon: Briefcase,
    textColor: 'text-blue-400',
    chip: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    iconBg: 'bg-blue-500/10 text-blue-400',
    badgeDa: 'Virksomhed',
    badgeEn: 'Company',
  },
  person: {
    Icon: User,
    textColor: 'text-purple-400',
    chip: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    iconBg: 'bg-purple-500/10 text-purple-400',
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
