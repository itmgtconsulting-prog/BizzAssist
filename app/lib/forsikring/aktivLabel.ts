/**
 * BIZZ-2150: Vise-label for et forsikrings-aktiv.
 *
 * Ejendomme uden en resolvet adresse beholder koncernWalk-labelet "BFE xxx"
 * (sat i koncernWalk.ts og kun erstattet ved succesfuld adresse-berigelse).
 * I UI skal det bare BFE-nummer ikke fejllæses som en adresse — vis i stedet
 * "Ukendt adresse (BFE xxx)" og en gul "Ingen adresse"-badge.
 */

/** Minimal aktiv-form helperen behøver — fungerer for både live- og snapshot-aktiver. */
interface AktivLabelInput {
  type?: string | null;
  label?: string | null;
}

/**
 * Er aktivet en ejendom hvis adresse ikke kunne resolves?
 *
 * @param aktiv - Aktiv med type + label
 * @returns true hvis ejendom og label stadig er det rå "BFE xxx"-fallback
 */
export function erEjendomUdenAdresse(aktiv: AktivLabelInput): boolean {
  return (
    aktiv.type === 'ejendom' && typeof aktiv.label === 'string' && aktiv.label.startsWith('BFE ')
  );
}

/**
 * Beregn den label der vises til brugeren for et aktiv.
 *
 * @param aktiv - Aktiv med type + label
 * @param da - true for dansk, false for engelsk
 * @returns "Ukendt adresse (BFE xxx)" for adresseløse ejendomme, ellers labelet uændret
 */
export function visAktivLabel(aktiv: AktivLabelInput, da: boolean): string {
  const label = aktiv.label ?? '';
  if (!erEjendomUdenAdresse(aktiv)) return label;
  return da ? `Ukendt adresse (${label})` : `Unknown address (${label})`;
}
