/**
 * Forsikrings-modul — selskabs-aware coverage-alias mapping.
 *
 * BIZZ-1939: Forskellige forsikringsselskaber bruger forskellige termer for
 * funktionelt identiske dækninger. Topdanmark/If skriver fx ikke
 * "Hus- og grundejeransvar" på policen — de dækker ejendomsejer-ansvaret
 * via "Erhvervsansvar" (+ "Udvidet ansvar for beboelsesejendom"). Når den
 * forsikrede aktivitet er boligudlejning, er Erhvervsansvaret reelt det samme
 * som det Alm. Brand kalder "Hus- og grundejeransvar" (vilkår nr. 850).
 *
 * Uden denne mapping markerer gap-engine `hus_grundejer_ansvar` som manglende
 * på Topdanmark-policer der reelt dækker det — en ren terminologi-bug, ikke et
 * faktisk dæknings-hul (false positive).
 *
 * Mappingen er bevidst samlet ét sted, så nye selskabs-/dæknings-aliasser kan
 * vedligeholdes uden at røre selve gap-engine-logikken.
 *
 * @module app/lib/forsikring/coverageAliases
 */

import type { CoverageCode, ForsikringCoverage } from './types';

/**
 * En alias-regel: hvis selskabet har `naar` aktiveret, anses `saa` også for
 * dækket. `note` dokumenterer den forsikringsfaglige begrundelse.
 */
interface CoverageAliasRule {
  /** Kanonisk dækningskode der skal være til stede og aktiv */
  naar: CoverageCode;
  /** Kanonisk dækningskode der dermed også anses for dækket */
  saa: CoverageCode;
  /** Forsikringsfaglig begrundelse (til reference/vedligehold) */
  note: string;
}

/**
 * Alias-regler pr. selskabs-familie (lowercase nøgle der matches mod
 * insurer_name via substring). Topdanmark og If deler vilkårskatalog
 * (Topdanmark er en del af If Skadeforsikring).
 */
const INSURER_COVERAGE_ALIASES: Record<string, CoverageAliasRule[]> = {
  topdanmark: [
    {
      naar: 'erhvervsansvar',
      saa: 'hus_grundejer_ansvar',
      note:
        'Topdanmark dækker ejendomsejer-/grundejeransvar via Erhvervsansvar ' +
        '(+ Udvidet ansvar for beboelsesejendom, §22500), ikke via en separat ' +
        '"Hus- og grundejeransvar"-linje (vilkår DF20903-2 §20100-20200).',
    },
  ],
  if: [
    {
      naar: 'erhvervsansvar',
      saa: 'hus_grundejer_ansvar',
      note: 'If/Topdanmark deler vilkårskatalog — samme Erhvervsansvar-mapping.',
    },
  ],
};

/**
 * Find selskabs-familien for et insurer_name (til alias-opslag).
 *
 * @param insurerName - Selskabsnavn fra policen (fx "Topdanmark - en del af If Skadeforsikring")
 * @returns Alias-nøgle ("topdanmark" | "if" | ...) eller null hvis ingen aliasser kendes
 */
export function resolveInsurerFamily(insurerName: string | null | undefined): string | null {
  if (!insurerName) return null;
  const lower = insurerName.toLowerCase();
  // Mest specifikke familie vinder (Topdanmark før If, da navnet kan rumme begge).
  for (const family of ['topdanmark', 'if']) {
    if (family === 'if') {
      // "If" må kun matche som helt ord/selskabsnavn, ikke som delstreng (fx "Gjensidige").
      if (/\bif\b/.test(lower)) return family;
    } else if (lower.includes(family)) {
      return family;
    }
  }
  return null;
}

/**
 * Beregn det effektive sæt af dækkede kanoniske koder for en police, inkl.
 * selskabs-specifikke aliasser (fx Topdanmark Erhvervsansvar ⇒ hus_grundejer_ansvar).
 *
 * @param insurerName - Selskabsnavn fra policen (afgør hvilke aliasser der gælder)
 * @param coverages - Policens dækninger
 * @returns Sæt af coverage_code-strenge der anses for dækket (med aliasser)
 */
export function effectiveCoveredCodes(
  insurerName: string | null | undefined,
  coverages: Pick<ForsikringCoverage, 'coverage_code' | 'is_covered'>[]
): Set<string> {
  const codes = new Set<string>();
  for (const c of coverages) {
    if (c.is_covered) codes.add(c.coverage_code);
  }
  const family = resolveInsurerFamily(insurerName);
  if (family) {
    for (const rule of INSURER_COVERAGE_ALIASES[family] ?? []) {
      if (codes.has(rule.naar)) codes.add(rule.saa);
    }
  }
  return codes;
}
