/**
 * BIZZ-842: EJF (Ejerfortegnelsen) handelstype-mapping.
 *
 * Datafordeler EJF returnerer numeriske handelstype-koder i
 * overdragelsesmaade-feltet. Brugerne ser kun tal ("Type 10",
 * "Type 30") uden forklaring. Denne helper oversætter koderne
 * til label + description + semantisk farveklasse.
 *
 * Kilde: EJF-kodeliste / Datafordeler-dokumentation.
 *
 * @module app/lib/ejfKoder
 */

export type HandelstypeColor = 'emerald' | 'blue' | 'amber' | 'slate';

export interface HandelstypeInfo {
  /** Kort dansk label (vist i badge) */
  label: string;
  /** Engelsk label */
  labelEn: string;
  /** Længere forklaring (vises i tooltip) */
  description: string;
  /** Engelsk forklaring */
  descriptionEn: string;
  /** Semantisk farve — emerald=almindelig, blue=familie, amber=andet, slate=ukendt */
  color: HandelstypeColor;
}

/**
 * BIZZ-842: EJF handelstype-koder. Officiel EJF-kodeliste:
 *   10 = Almindelig fri handel
 *   20 = Familiehandel/interessefællesskab
 *   30 = Andet (gave, arv, skifte, tvang, auktion)
 *   40 = Ubekendt / ej oplyst
 */
const HANDELSTYPER: Record<string, HandelstypeInfo> = {
  '10': {
    label: 'Fri handel',
    labelEn: 'Free sale',
    description:
      'Almindelig fri handel — køber og sælger har modstridende økonomiske interesser (armslængdeprincippet).',
    descriptionEn:
      'Arm\u2019s length transaction between independent buyer and seller with opposing economic interests.',
    color: 'emerald',
  },
  '20': {
    label: 'Familiehandel',
    labelEn: 'Family sale',
    description:
      'Familiehandel eller interessefællesskab — køber og sælger er nærtstående eller har fælles interesser.',
    descriptionEn:
      'Transaction between related parties or with shared interests (family, associated companies).',
    color: 'blue',
  },
  '30': {
    label: 'Andet',
    labelEn: 'Other',
    description:
      'Andet end fri handel — fx gave, arv, skifte, tvangsauktion, fusion eller spaltning.',
    descriptionEn:
      'Non-standard transfer — gift, inheritance, forced sale, auction, merger or demerger.',
    color: 'amber',
  },
  '40': {
    label: 'Ubekendt',
    labelEn: 'Unknown',
    description: 'Handelstype ikke oplyst i EJF.',
    descriptionEn: 'Transaction type not reported in EJF.',
    color: 'slate',
  },
};

/**
 * Returnér handelstype-info for en given kode. Accepterer både numeriske
 * strings ("10") og tal (10). Returnerer null hvis koden er ukendt så
 * caller kan vælge at vise original-strengen ufortolket.
 */
export function getHandelstypeInfo(
  kode: string | number | null | undefined
): HandelstypeInfo | null {
  if (kode == null) return null;
  const key = String(kode).trim();
  if (key.length === 0) return null;
  return HANDELSTYPER[key] ?? null;
}

/**
 * Tailwind-klasser pr farve — badge-styling (text + bg + border).
 */
const COLOR_CLASSES: Record<HandelstypeColor, string> = {
  emerald: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  blue: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  amber: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
  slate: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
};

/**
 * Returnér Tailwind klasse-string for en handelstype-farve.
 */
export function handelstypeBadgeClasses(color: HandelstypeColor): string {
  return COLOR_CLASSES[color];
}
