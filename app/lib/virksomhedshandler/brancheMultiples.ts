/**
 * Branche-multiple mapping: DB07-kode → EV/EBITDA-range.
 *
 * BIZZ-1927: Statisk mapping brugt til at estimere virksomhedsværdi:
 *   estimeret_vaerdi = ejerandel_delta × aarsresultat × ev_ebitda_mid
 *
 * Kilder: Damodaran NYU dataset, EY/Deloitte M&A-rapporter, Argentum Nordic.
 * Opdateres manuelt ved nye rapporter (typisk årligt).
 *
 * @module app/lib/virksomhedshandler/brancheMultiples
 */

/** EV/EBITDA range for en branche */
export interface BrancheMultiple {
  /** DB07 prefix (2-cifret = sektor, 4-cifret = specifik branche) */
  db07_prefix: string;
  /** Dansk branche-label */
  branche_label: string;
  /** Lavt EV/EBITDA estimat */
  ev_ebitda_low: number;
  /** Midterste EV/EBITDA estimat */
  ev_ebitda_mid: number;
  /** Højt EV/EBITDA estimat */
  ev_ebitda_high: number;
  /** Datakilde */
  kilde: string;
  /** Sidste opdatering (YYYY-MM) */
  opdateret: string;
}

/**
 * Statisk branche-multiple mapping.
 * Sorteret efter DB07 prefix (numerisk).
 */
export const BRANCHE_MULTIPLES: BrancheMultiple[] = [
  // ── Primær sektor ──
  {
    db07_prefix: '01',
    branche_label: 'Landbrug og gartneri',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 7,
    ev_ebitda_high: 10,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '02',
    branche_label: 'Skovbrug',
    ev_ebitda_low: 6,
    ev_ebitda_mid: 8,
    ev_ebitda_high: 12,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '03',
    branche_label: 'Fiskeri',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 7,
    ev_ebitda_high: 10,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },

  // ── Industri ──
  {
    db07_prefix: '10',
    branche_label: 'Fødevareindustri',
    ev_ebitda_low: 7,
    ev_ebitda_mid: 10,
    ev_ebitda_high: 14,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '20',
    branche_label: 'Kemisk industri',
    ev_ebitda_low: 8,
    ev_ebitda_mid: 11,
    ev_ebitda_high: 15,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '21',
    branche_label: 'Medicinalindustri',
    ev_ebitda_low: 12,
    ev_ebitda_mid: 18,
    ev_ebitda_high: 25,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '25',
    branche_label: 'Metalvareindustri',
    ev_ebitda_low: 6,
    ev_ebitda_mid: 8,
    ev_ebitda_high: 11,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '28',
    branche_label: 'Maskinindustri',
    ev_ebitda_low: 7,
    ev_ebitda_mid: 10,
    ev_ebitda_high: 14,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },

  // ── Bygge og anlæg ──
  {
    db07_prefix: '41',
    branche_label: 'Opførelse af bygninger',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 7,
    ev_ebitda_high: 10,
    kilde: 'EY Nordic M&A 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '42',
    branche_label: 'Anlægsarbejde',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 7,
    ev_ebitda_high: 10,
    kilde: 'EY Nordic M&A 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '43',
    branche_label: 'Specialiseret byggevirksomhed',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 8,
    ev_ebitda_high: 11,
    kilde: 'EY Nordic M&A 2025',
    opdateret: '2026-01',
  },

  // ── Handel ──
  {
    db07_prefix: '45',
    branche_label: 'Handel med biler og motorcykler',
    ev_ebitda_low: 4,
    ev_ebitda_mid: 6,
    ev_ebitda_high: 9,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '46',
    branche_label: 'Engroshandel',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 8,
    ev_ebitda_high: 12,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '47',
    branche_label: 'Detailhandel',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 8,
    ev_ebitda_high: 12,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },

  // ── Transport ──
  {
    db07_prefix: '49',
    branche_label: 'Landtransport',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 7,
    ev_ebitda_high: 10,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '50',
    branche_label: 'Vandtransport',
    ev_ebitda_low: 6,
    ev_ebitda_mid: 8,
    ev_ebitda_high: 12,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '52',
    branche_label: 'Hjælpevirksomhed til transport',
    ev_ebitda_low: 7,
    ev_ebitda_mid: 10,
    ev_ebitda_high: 14,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },

  // ── Hotel og restauration ──
  {
    db07_prefix: '55',
    branche_label: 'Hoteller',
    ev_ebitda_low: 8,
    ev_ebitda_mid: 12,
    ev_ebitda_high: 16,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '56',
    branche_label: 'Restauration',
    ev_ebitda_low: 4,
    ev_ebitda_mid: 6,
    ev_ebitda_high: 9,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },

  // ── IT og kommunikation ──
  {
    db07_prefix: '58',
    branche_label: 'Forlagsvirksomhed',
    ev_ebitda_low: 7,
    ev_ebitda_mid: 10,
    ev_ebitda_high: 15,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '61',
    branche_label: 'Telekommunikation',
    ev_ebitda_low: 6,
    ev_ebitda_mid: 8,
    ev_ebitda_high: 11,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '62',
    branche_label: 'IT-konsulent + software',
    ev_ebitda_low: 8,
    ev_ebitda_mid: 12,
    ev_ebitda_high: 18,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '63',
    branche_label: 'Informationstjenester',
    ev_ebitda_low: 8,
    ev_ebitda_mid: 12,
    ev_ebitda_high: 18,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },

  // ── Finans og forsikring ──
  {
    db07_prefix: '64',
    branche_label: 'Finansiel virksomhed',
    ev_ebitda_low: 8,
    ev_ebitda_mid: 12,
    ev_ebitda_high: 16,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '65',
    branche_label: 'Forsikring og pension',
    ev_ebitda_low: 8,
    ev_ebitda_mid: 11,
    ev_ebitda_high: 15,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },

  // ── Ejendomme ──
  {
    db07_prefix: '68',
    branche_label: 'Ejendomshandel og udlejning',
    ev_ebitda_low: 10,
    ev_ebitda_mid: 15,
    ev_ebitda_high: 22,
    kilde: 'EY Nordic M&A 2025',
    opdateret: '2026-01',
  },

  // ── Rådgivning og videnservice ──
  {
    db07_prefix: '69',
    branche_label: 'Juridisk + revision',
    ev_ebitda_low: 6,
    ev_ebitda_mid: 9,
    ev_ebitda_high: 13,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '70',
    branche_label: 'Hovedkontor + management',
    ev_ebitda_low: 7,
    ev_ebitda_mid: 10,
    ev_ebitda_high: 14,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '71',
    branche_label: 'Arkitekt + ingeniør',
    ev_ebitda_low: 7,
    ev_ebitda_mid: 10,
    ev_ebitda_high: 14,
    kilde: 'EY Nordic M&A 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '72',
    branche_label: 'Forskning og udvikling',
    ev_ebitda_low: 10,
    ev_ebitda_mid: 15,
    ev_ebitda_high: 22,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '73',
    branche_label: 'Reklame og markedsanalyse',
    ev_ebitda_low: 6,
    ev_ebitda_mid: 9,
    ev_ebitda_high: 13,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '74',
    branche_label: 'Anden videnservice',
    ev_ebitda_low: 6,
    ev_ebitda_mid: 9,
    ev_ebitda_high: 13,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },

  // ── Service ──
  {
    db07_prefix: '77',
    branche_label: 'Udlejning og leasing',
    ev_ebitda_low: 7,
    ev_ebitda_mid: 10,
    ev_ebitda_high: 14,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '78',
    branche_label: 'Vikarbureauer',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 7,
    ev_ebitda_high: 10,
    kilde: 'Argentum Nordic 2025',
    opdateret: '2026-01',
  },
  {
    db07_prefix: '81',
    branche_label: 'Ejendomsservice',
    ev_ebitda_low: 5,
    ev_ebitda_mid: 7,
    ev_ebitda_high: 10,
    kilde: 'EY Nordic M&A 2025',
    opdateret: '2026-01',
  },

  // ── Sundhed ──
  {
    db07_prefix: '86',
    branche_label: 'Sundhedsvæsen',
    ev_ebitda_low: 8,
    ev_ebitda_mid: 12,
    ev_ebitda_high: 18,
    kilde: 'Damodaran 2025',
    opdateret: '2026-01',
  },
];

/**
 * Find EV/EBITDA-range for en DB07-branchekode.
 * Prøver eksakt match først, derefter 2-cifret prefix.
 *
 * @param db07Code - DB07 branchekode (fx "620100" eller "62")
 * @returns BrancheMultiple eller null hvis ukendt branche
 */
export function lookupBrancheMultiple(db07Code: string | null | undefined): BrancheMultiple | null {
  if (!db07Code) return null;
  const code = db07Code.replace(/\D/g, '');
  if (code.length < 2) return null;

  // Eksakt match (4+ cifre)
  const exact = BRANCHE_MULTIPLES.find((m) => code.startsWith(m.db07_prefix));
  if (exact) return exact;

  // 2-cifret prefix
  const prefix2 = code.slice(0, 2);
  return BRANCHE_MULTIPLES.find((m) => m.db07_prefix === prefix2) ?? null;
}

/**
 * Estimér virksomhedsværdi baseret på branche-multiple og årsresultat.
 *
 * @param db07Code - DB07 branchekode
 * @param aarsresultat - Seneste årsresultat (EBITDA proxy) i DKK
 * @param ejerandelDelta - Ændring i ejerandel (0-100)
 * @returns Estimeret værdi-range { low, mid, high } i DKK, eller null
 */
export function estimerVaerdi(
  db07Code: string | null | undefined,
  aarsresultat: number | null | undefined,
  ejerandelDelta: number
): { low: number; mid: number; high: number } | null {
  if (!aarsresultat || aarsresultat <= 0 || ejerandelDelta <= 0) return null;
  const multiple = lookupBrancheMultiple(db07Code);
  if (!multiple) return null;

  const factor = ejerandelDelta / 100;
  return {
    low: Math.round(aarsresultat * multiple.ev_ebitda_low * factor),
    mid: Math.round(aarsresultat * multiple.ev_ebitda_mid * factor),
    high: Math.round(aarsresultat * multiple.ev_ebitda_high * factor),
  };
}

/** Et lav/mid/høj-interval i DKK. */
export interface Interval {
  lav: number;
  mid: number;
  hoej: number;
}

/**
 * Fuldt beregnings-breakdown for en estimeret transaktionsværdi.
 *
 * BIZZ-1948: Bruges til AI-forklaring-popup'en, så brugeren kan se HVAD
 * estimatet bygger på (EBITDA × branche-multiple → enterprise value →
 * × ejerandels-delta → transaktionsværdi).
 */
export interface TransaktionsBreakdown {
  /** EBITDA-proxy brugt i beregningen (resultat før skat) i DKK */
  ebitda_used: number;
  /** Branche-multiple range (EV/EBITDA) */
  multiple: { lav: number; mid: number; hoej: number };
  /** Enterprise value = EBITDA × multiple */
  ev_range: Interval;
  /** Ejerandels-delta i procentpoint */
  delta_pct: number;
  /** Transaktionsværdi = EV × delta% */
  transaktionsvaerdi: Interval;
  /** Dansk branche-label for den matchede multiple */
  branche_label: string;
  /** Datakilde for multiplen (fx "Damodaran 2025") */
  kilde: string;
}

/**
 * Beregn estimeret transaktionsværdi for en ejerandels-ændring, med fuldt
 * mellemregnings-breakdown til AI-forklaring.
 *
 * Logik: Enterprise Value = EBITDA × branche-multiple;
 *        Transaktionsværdi = EV × (ejerandels-delta / 100).
 *
 * @param db07Code - DB07 branchekode
 * @param ebitda - EBITDA-proxy (resultat før skat) i DKK
 * @param ejerandelDelta - Ændring i ejerandel i procentpoint (0-100)
 * @returns Fuldt breakdown, eller null hvis EBITDA/branche/delta mangler
 */
export function beregnTransaktionsvaerdi(
  db07Code: string | null | undefined,
  ebitda: number | null | undefined,
  ejerandelDelta: number
): TransaktionsBreakdown | null {
  if (!ebitda || ebitda <= 0 || ejerandelDelta <= 0) return null;
  const multiple = lookupBrancheMultiple(db07Code);
  if (!multiple) return null;

  const factor = ejerandelDelta / 100;
  const evLow = Math.round(ebitda * multiple.ev_ebitda_low);
  const evMid = Math.round(ebitda * multiple.ev_ebitda_mid);
  const evHigh = Math.round(ebitda * multiple.ev_ebitda_high);

  return {
    ebitda_used: ebitda,
    multiple: {
      lav: multiple.ev_ebitda_low,
      mid: multiple.ev_ebitda_mid,
      hoej: multiple.ev_ebitda_high,
    },
    ev_range: { lav: evLow, mid: evMid, hoej: evHigh },
    delta_pct: ejerandelDelta,
    transaktionsvaerdi: {
      lav: Math.round(evLow * factor),
      mid: Math.round(evMid * factor),
      hoej: Math.round(evHigh * factor),
    },
    branche_label: multiple.branche_label,
    kilde: multiple.kilde,
  };
}
