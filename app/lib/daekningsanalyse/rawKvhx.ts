/**
 * Parser for "rå" KVHX-adressedatasæt til matrikeldækningsanalyse.
 *
 * Datasættet (typisk et bredbånds-base-udtræk) har kolonnerne
 * sub_address_kvhx_id, address_street_name, address_postcode, DAWA_KVHX og
 * HomeInternet_base — dvs. IKKE en færdig adresse-streng. Denne modul genkender
 * formatet, rekonstruerer den fulde enhedsadresse (husnr + etage/dør udledt fra
 * DAWA_KVHX med sub_address_kvhx_id som fallback) og udstiller postnr/gade-facetter
 * så brugeren kan vælge hvilken delmængde analysen skal køre på.
 *
 * Kunde-semantik: når en HomeInternet-kolonne findes, tælles kun rækker med
 * HomeInternet_base >= 1 som kunder (resten er base-adresser uden abonnement).
 *
 * @module app/lib/daekningsanalyse/rawKvhx
 */

/** Husnummer + etage + dør udledt af en KVHX-nøgle. */
export interface HusnrParts {
  husnr: string;
  etage: string;
  dor: string;
}

/** Én kunde-enhed fra rådatasættet. */
export interface RawKvhxRecord {
  street: string;
  postnr: number;
  husnr: string;
  etage: string;
  dor: string;
  /** HomeInternet-kundeantal på enheden (null hvis kolonnen mangler i filen). */
  homeInternet: number | null;
}

/** Resultatet af at parse et rå KVHX-datasæt. */
export interface RawKvhxDataset {
  records: RawKvhxRecord[];
  /** Distinkte postnumre i datasættet (stigende). */
  postnumre: number[];
  /** Distinkte gadenavne pr. postnr (alfabetisk). */
  streetsByPostnr: Record<number, string[]>;
  /** Om filen havde en HomeInternet-kolonne (⟹ kunde-filtrering blev anvendt). */
  hasHomeInternetColumn: boolean;
  /** Antal datarækker i alt (før kunde-filtrering). */
  totalRows: number;
  /** Antal kunde-rækker efter filtrering. */
  customerRows: number;
}

/**
 * Udled husnr/etage/dør fra fast-bredde DAWA_KVHX.
 * Layout: [0:4]kommune [4:8]vej [8:12]husnr [13:15]etage [15:19]dør ('_'-polstret).
 *
 * @param dawa - DAWA_KVHX-strengen
 * @returns husnr/etage/dør, eller null hvis husnr ikke kan udledes
 */
function fromDawaKvhx(dawa: string): HusnrParts | null {
  if (!dawa || dawa.length < 12) return null;
  const husnr = dawa.slice(8, 12).replace(/_/g, '').trim();
  if (!husnr) return null;
  return {
    husnr,
    etage: dawa.length >= 15 ? dawa.slice(13, 15).replace(/_/g, '').trim() : '',
    dor: dawa.length >= 19 ? dawa.slice(15, 19).replace(/_/g, '').trim() : '',
  };
}

/**
 * Fallback-udledning fra sub_address_kvhx_id (bruges når DAWA_KVHX er blank).
 * Layout: kommune(3, uden ledende 0) + vej(4) + husnr(3 cifre, nulpolstret)
 * [+ evt. husnr-bogstav] + etage(2: ST/KL eller cifre) + dør(2 bogstaver | cifre).
 *
 * @param kvhx - sub_address_kvhx_id-strengen
 * @returns husnr/etage/dør, eller null hvis husnr ikke kan udledes
 */
function fromSubKvhx(kvhx: string): HusnrParts | null {
  if (!kvhx || kvhx.length < 10) return null;
  const digits = kvhx.slice(7, 10);
  if (!/^\d{3}$/.test(digits)) return null;
  let husnr = String(parseInt(digits, 10));
  let p = 10;
  const c = kvhx[10];
  const pair = (kvhx.slice(10, 12) || '').toUpperCase();
  // Enkelt bogstav der IKKE er en etage-markør (ST/KL) ⟹ husnr-bogstav (fx 114A).
  if (c && /[A-Za-z]/.test(c) && pair !== 'ST' && pair !== 'KL') {
    husnr += c.toUpperCase();
    p = 11;
  }
  const rest = kvhx.slice(p);
  let etage = '';
  let dor = '';
  if (rest.length) {
    const e = rest.slice(0, 2).toUpperCase();
    if (e === 'ST' || e === 'KL') etage = e.toLowerCase();
    else if (/^\d{2}$/.test(rest.slice(0, 2))) etage = String(parseInt(rest.slice(0, 2), 10));
    else if (/^\d$/.test(rest[0])) etage = rest[0];
    const dRaw = rest.slice(2);
    if (/^[A-Za-z]{2}$/.test(dRaw)) dor = dRaw.toLowerCase();
    else if (/^\d+$/.test(dRaw)) dor = String(parseInt(dRaw, 10));
    else if (dRaw) dor = dRaw.toLowerCase();
  }
  return { husnr, etage, dor };
}

/**
 * Udled husnr/etage/dør fra DAWA_KVHX (primær) med sub_address_kvhx_id som fallback.
 *
 * @param dawaKvhx - DAWA_KVHX (kan være tom)
 * @param subKvhx - sub_address_kvhx_id (kan være tom)
 * @returns husnr/etage/dør, eller null hvis ingen af nøglerne kan udledes
 */
export function parseHusnr(dawaKvhx: string, subKvhx: string): HusnrParts | null {
  return fromDawaKvhx(dawaKvhx) ?? fromSubKvhx(subKvhx);
}

/**
 * Byg en dansk enhedsadresse-streng klar til DAWA datavask.
 * Format: "Vejnavn Husnr[, etage. dør], Postnr By".
 *
 * @param street - Vejnavn
 * @param husnr - Husnummer (kan indeholde bogstav, fx 114A)
 * @param etage - Etage ('st'/'kl'/tal, evt. tom)
 * @param dor - Dør (tv/th/mf/tal, evt. tom)
 * @param postnr - Postnummer
 * @param by - Postdistrikt (by-navn); udelades hvis tom
 * @returns Adresse-streng
 */
export function formatEnhedsadresse(
  street: string,
  husnr: string,
  etage: string,
  dor: string,
  postnr: number | string,
  by: string
): string {
  const eLbl = etage === 'st' ? 'st.' : etage === 'kl' ? 'kl.' : etage ? `${etage}.` : '';
  let mid = '';
  if (eLbl && dor) mid = `, ${eLbl} ${dor}`;
  else if (eLbl) mid = `, ${eLbl}`;
  else if (dor) mid = `, ${dor}`;
  const byPart = by ? ` ${by}` : '';
  return `${street} ${husnr}${mid}, ${postnr}${byPart}`;
}

/**
 * Find kolonne-indeks (0-baseret) ud fra normaliserede header-navne.
 *
 * @param header - Header-rækken (lowercased, trimmed)
 * @param names - Accepterede kolonnenavne
 * @returns Indeks eller -1
 */
function findCol(header: string[], names: string[]): number {
  return header.findIndex((h) => names.includes(h));
}

/**
 * Parse et rå KVHX-datasæt fra en 2D-rækkematrix (inkl. header-række, 0-indekseret).
 * Returnerer null hvis arket ikke matcher rå-formatet (så kalderen kan falde tilbage
 * til den eksisterende adresse-kolonne-parsing / AI-ekstraktion).
 *
 * @param rows - Ark-rækker inkl. header i rows[0]
 * @returns Parset datasæt med kunde-records + postnr/gade-facetter, eller null
 */
export function parseRawKvhxRows(
  rows: (string | number | null | undefined)[][]
): RawKvhxDataset | null {
  if (!rows || rows.length < 2) return null;
  const header = rows[0].map((c) =>
    String(c ?? '')
      .trim()
      .toLowerCase()
  );

  const iStreet = findCol(header, ['address_street_name']);
  const iPostnr = findCol(header, ['address_postcode']);
  const iDawa = findCol(header, ['dawa_kvhx']);
  const iSub = findCol(header, ['sub_address_kvhx_id']);
  const iHome = header.findIndex((h) => h.includes('homeinternet'));
  // Rå-format kræver gade + postnr + mindst én KVHX-nøgle.
  if (iStreet < 0 || iPostnr < 0 || (iDawa < 0 && iSub < 0)) return null;

  const records: RawKvhxRecord[] = [];
  let totalRows = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const street = String(row[iStreet] ?? '').trim();
    const postnr = Number(row[iPostnr]);
    if (!street || !Number.isFinite(postnr)) continue;
    totalRows++;

    const home = iHome >= 0 ? (Number.isFinite(Number(row[iHome])) ? Number(row[iHome]) : 0) : null;
    // Kun HomeInternet-kunder tælles når kolonnen findes.
    if (iHome >= 0 && (home ?? 0) < 1) continue;

    const dawa = iDawa >= 0 ? String(row[iDawa] ?? '').trim() : '';
    const sub = iSub >= 0 ? String(row[iSub] ?? '').trim() : '';
    const parts = parseHusnr(dawa, sub);
    if (!parts) continue; // husnr kan ikke udledes ⟹ spring rækken over

    records.push({
      street,
      postnr,
      husnr: parts.husnr,
      etage: parts.etage,
      dor: parts.dor,
      homeInternet: home,
    });
  }

  if (records.length === 0) return null;

  const postnumre = [...new Set(records.map((r) => r.postnr))].sort((a, b) => a - b);
  const streetsByPostnr: Record<number, string[]> = {};
  for (const pc of postnumre) {
    streetsByPostnr[pc] = [
      ...new Set(records.filter((r) => r.postnr === pc).map((r) => r.street)),
    ].sort((a, b) => a.localeCompare(b, 'da'));
  }

  return {
    records,
    postnumre,
    streetsByPostnr,
    hasHomeInternetColumn: iHome >= 0,
    totalRows,
    customerRows: records.length,
  };
}

/**
 * Byg de-duplikerede enhedsadresse-strenge for en valgt delmængde af datasættet.
 *
 * @param dataset - Parset rå-datasæt
 * @param postnr - Valgt postnr (obligatorisk)
 * @param by - Postdistrikt-navn til det valgte postnr (slås op i DAWA af kalderen)
 * @param street - Valgt gade (valgfri; undlad/tom = alle gader i postnummeret)
 * @returns Sorterede, unikke adresse-strenge klar til /resolve
 */
export function buildSelectedAddresses(
  dataset: RawKvhxDataset,
  postnr: number,
  by: string,
  street?: string
): string[] {
  const seen = new Set<string>();
  for (const r of dataset.records) {
    if (r.postnr !== postnr) continue;
    if (street && r.street !== street) continue;
    seen.add(formatEnhedsadresse(r.street, r.husnr, r.etage, r.dor, r.postnr, by));
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'da', { numeric: true }));
}
