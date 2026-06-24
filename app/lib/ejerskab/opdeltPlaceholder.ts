/**
 * BIZZ-2193: Detektér EJF's "Ukendt"-placeholder for opdelte SFE/hovedejendomme.
 *
 * For en ejendom der er OPDELT i ejerlejligheder repræsenterer Ejerfortegnelsen
 * (EJF) SFE-niveauets ejer som en navnløs placeholder: ejer_navn="Ukendt",
 * person, intet CVR, fuld andel (1/1). Det reelle ejerskab ligger på de
 * underliggende ejerlejligheder. Vist råt bliver det misvisende "Ukendt 100%".
 *
 * Denne helper afgør om en gældende ejer-liste KUN består af denne placeholder,
 * så kaldere kan undertrykke den (eller mappe til status-teksten "Opdelt i
 * ejerlejligheder"). Bevidst snæver: kun den ENESTE gældende ejer med fuld andel
 * konverteres — partiel/ideel-anpart med en ukendt medejer (t≠n eller flere
 * rækker) er reelt delvist-ukendt ejerskab og må IKKE undertrykkes.
 *
 * @module app/lib/ejerskab/opdeltPlaceholder
 */

/** Minimal delmængde af en ejf_ejerskab-række der kræves for placeholder-tjek. */
export interface EjfEjerRow {
  ejer_navn: string | null;
  ejer_cvr: string | null;
  ejerandel_taeller: number | null;
  ejerandel_naevner: number | null;
}

/**
 * Er den gældende ejer-liste udelukkende EJF's opdelt-SFE "Ukendt" 1/1-placeholder?
 *
 * @param rows - Gældende ejer-rækker fra ejf_ejerskab for ét BFE
 * @returns true hvis listen er præcis én navnløs "Ukendt"-fuld-andel-placeholder uden CVR
 */
export function erOpdeltSfePlaceholder(rows: EjfEjerRow[]): boolean {
  if (rows.length !== 1) return false;
  const r = rows[0];
  return (
    r.ejer_navn === 'Ukendt' &&
    !r.ejer_cvr &&
    r.ejerandel_taeller != null &&
    r.ejerandel_naevner != null &&
    r.ejerandel_taeller === r.ejerandel_naevner
  );
}
