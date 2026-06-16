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

/** Aktiv-form til adresse-disambiguering — behøver også BFE for at skelne ejerlejligheder. */
interface AktivDisambInput extends AktivLabelInput {
  bfe?: number | null;
}

/**
 * Find resolvede adresse-labels der deles af flere DISTINKTE ejendomme.
 *
 * BIZZ-2149: Ejerlejligheder kan dele samme gade-adresse men have forskellige
 * BFE-numre (fx "Stjernegade 24A" = BFE 244640 + 244655). De er separate
 * forsikrings-aktiver og må IKKE flettes — men i en flad tabel ser de ens ud.
 * Returnerer de adresse-labels der optræder på mere end ét BFE, så de kan
 * disambigueres med et BFE-suffix.
 *
 * @param aktiver - Alle aktiver i analysen
 * @param da - true for dansk, false for engelsk (matcher visAktivLabel)
 * @returns Set af labels der deles af ≥2 distinkte ejendoms-BFE'er
 */
export function findDelteAdresser(aktiver: AktivDisambInput[], da: boolean): Set<string> {
  const bfePerLabel = new Map<string, Set<number>>();
  for (const a of aktiver) {
    // Kun resolvede ejendomme — adresseløse ("BFE xxx") håndteres af visAktivLabel.
    if (a.type !== 'ejendom' || a.bfe == null || erEjendomUdenAdresse(a)) continue;
    const label = visAktivLabel(a, da);
    if (!bfePerLabel.has(label)) bfePerLabel.set(label, new Set());
    bfePerLabel.get(label)!.add(a.bfe);
  }
  const delte = new Set<string>();
  for (const [label, bfeSet] of bfePerLabel) {
    if (bfeSet.size > 1) delte.add(label);
  }
  return delte;
}

/**
 * Som visAktivLabel, men tilføjer "(BFE xxx)" når adressen deles af flere
 * distinkte ejendomme, så ejerlejligheder med samme adresse kan skelnes uden
 * at blive flettet sammen.
 *
 * @param aktiv - Aktiv med type + label + bfe
 * @param da - true for dansk, false for engelsk
 * @param delteAdresser - Resultatet af findDelteAdresser for hele listen
 * @returns Disambigueret label
 */
export function visAktivLabelDisambig(
  aktiv: AktivDisambInput,
  da: boolean,
  delteAdresser: Set<string>
): string {
  const base = visAktivLabel(aktiv, da);
  if (aktiv.type === 'ejendom' && aktiv.bfe != null && delteAdresser.has(base)) {
    return `${base} (BFE ${aktiv.bfe})`;
  }
  return base;
}
