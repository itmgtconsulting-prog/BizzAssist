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
 * Returnerer true hvis benyttelseskode-teksten signalerer "fritids-/sommerhus"-
 * kategorien — dvs. en kategori der ikke giver mening i byzone.
 */
function erFritidsKategori(tekst: string | null): boolean {
  if (!tekst) return false;
  const t = tekst.toLowerCase();
  return (
    t.includes('sommerhus') ||
    t.includes('kolonihave') ||
    t.includes('fritidsbolig') ||
    t.includes('feriehus')
  );
}

/**
 * Bygger "Værksted (1955)" tekst til visning på ejendomsbadge.
 *
 * BIZZ-574 v1: Suppress fritids-kategori i Byzone.
 * BIZZ-574 v2: Udvidet til alle kendte ikke-sommerhus-zoner. Eksempel:
 * Thorvald Bindesbølls Plads 18, 3. th har zone="Udfaset" (historisk
 * zonestatus), ikke "Byzone" — v1-checken ramte derfor ikke. v2 vender
 * logikken: hvis zone er kendt og IKKE "Sommerhuszone", er fritids-kategori
 * per definition forkert. Fritids-badge vises kun når zone === Sommerhuszone
 * ELLER zone er ukendt (null, ingen data — så stoler vi på VUR-koden).
 *
 * Derudover suppress for ejerlejligheder (en ejerlejlighed kan per definition
 * ikke være et sommerhus — selv i sommerhuszone er de registreret som
 * ferielejligheder/feriehuse-andelsbolig, ikke som "Sommerhus" kode 21).
 *
 * @param benyttelseskode - VUR benyttelseskode
 * @param byggeaar - Opførelsesår fra BBR
 * @param zone - Plandata-zone ('Byzone' | 'Landzone' | 'Sommerhuszone' | 'Udfaset' | null)
 * @param erEjerlejlighed - True hvis ejendommen er registreret som ejerlejlighed
 * @returns Formateret streng "Betegnelse (År)" eller null hvis begge mangler
 */
export function formatBenyttelseOgByggeaar(
  benyttelseskode: string | null | undefined,
  byggeaar: number | null | undefined,
  zone?: string | null,
  erEjerlejlighed?: boolean
): string | null {
  let tekst = benyttelsekodeTekst(benyttelseskode);
  if (erFritidsKategori(tekst)) {
    // Suppress hvis zone er kendt og IKKE Sommerhuszone.
    // Bevarer badge hvis zone er null/ukendt (datamangel — stol på VUR-kode).
    if (zone && zone !== 'Sommerhuszone') {
      tekst = null;
    }
    // Suppress for ejerlejligheder uanset zone — en ejerlejlighed er aldrig
    // et "Sommerhus" (kode 21), selv i sommerhuszone.
    else if (erEjerlejlighed) {
      tekst = null;
    }
  }
  if (!tekst && !byggeaar) return null;
  if (tekst && byggeaar) return `${tekst} (${byggeaar})`;
  if (tekst) return tekst;
  return `(${byggeaar})`;
}
