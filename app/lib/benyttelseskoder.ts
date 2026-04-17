/**
 * Danske VUR benyttelseskoder — tekst-mapping til visning på ejendomsbilleder.
 *
 * Referenceseneste VUR-taxonomi (Vurderingsportalen/Datafordeler).
 * BIZZ-457: Bruges til at vise "Værksted (1955)" badge på oversigtssiden.
 *
 * @module benyttelseskoder
 */

const BENYTTELSESKODER: Record<string, string> = {
  // ─── Bolig ────────────────────────────────────────────────────────────
  '01': 'Parcelhus',
  '02': 'Tofamiliehus',
  '03': 'Række-/kæde-/dobbelthus',
  '04': 'Etageejendom',
  '05': 'Landbrug',
  '06': 'Bebygget landbrug',
  '07': 'Beboelsesejendom',
  '08': 'Blandet bolig/erhverv',
  '09': 'Alment byggeri',
  '10': 'Beboelsesejendom',
  '11': 'Ejerlejlighed',
  '12': 'Kollegium',
  '13': 'Ungdomsbolig',
  '14': 'Døgninstitution',
  '15': 'Beboelse i erhvervsejendom',
  '16': 'Rækkehus',

  // ─── Sommerhus / fritid ────────────────────────────────────────────────
  '21': 'Sommerhus',
  '22': 'Kolonihave',
  '23': 'Fritidsbolig',
  '24': 'Feriehus',

  // ─── Erhverv ──────────────────────────────────────────────────────────
  '30': 'Forretning',
  '31': 'Værksted',
  '32': 'Fabrik',
  '33': 'Lagerbygning',
  '34': 'Hotel',
  '35': 'Restaurant',
  '36': 'Kontorejendom',
  '37': 'Butik',
  '38': 'Industri',
  '39': 'Transport/logistik',
  '40': 'Erhverv',
  '41': 'Blandet erhverv',
  '42': 'Parkeringsanlæg',
  '43': 'Tankstation',
  '44': 'Biograf/teater',
  '45': 'Landbrugsbygning',

  // ─── Offentlig / anden ────────────────────────────────────────────────
  '50': 'Offentlig ejendom',
  '51': 'Skole',
  '52': 'Børneinstitution',
  '53': 'Plejehjem',
  '54': 'Sygehus',
  '55': 'Kirke',
  '56': 'Kulturhus',
  '57': 'Idrætshal',
  '58': 'Administration',

  // ─── Grund / ubebygget ────────────────────────────────────────────────
  '60': 'Ubebygget grund',
  '61': 'Byggegrund',
  '62': 'Landbrugsjord',
  '63': 'Skov',
  '64': 'Naturareal',

  // ─── Særlige ──────────────────────────────────────────────────────────
  '70': 'Garage/carport',
  '71': 'Udhus',
  '72': 'Anden bygning',
  '80': 'Specialbygning',
  '90': 'Anden ejendom',
  '99': 'Ukendt',
};

/**
 * Returnerer benyttelseskode som læselig tekst (f.eks. "31" → "Værksted").
 * Falder tilbage til koden selv hvis den ikke findes i mappingen.
 *
 * @param kode - Benyttelseskode (2-3 cifre)
 * @returns Dansk betegnelse, eller koden selv som fallback
 */
export function benyttelsekodeTekst(kode: string | null | undefined): string | null {
  if (!kode) return null;
  const normalized = kode.trim().padStart(2, '0');
  return BENYTTELSESKODER[normalized] ?? kode;
}

/**
 * Bygger "Værksted (1955)" tekst til visning på ejendomsbadge.
 *
 * @param benyttelseskode - VUR benyttelseskode
 * @param byggeaar - Opførelsesår fra BBR
 * @returns Formateret streng "Betegnelse (År)" eller null hvis begge mangler
 */
export function formatBenyttelseOgByggeaar(
  benyttelseskode: string | null | undefined,
  byggeaar: number | null | undefined
): string | null {
  const tekst = benyttelsekodeTekst(benyttelseskode);
  if (!tekst && !byggeaar) return null;
  if (tekst && byggeaar) return `${tekst} (${byggeaar})`;
  if (tekst) return tekst;
  return `(${byggeaar})`;
}
