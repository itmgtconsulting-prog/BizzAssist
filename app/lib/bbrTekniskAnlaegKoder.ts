/**
 * BBR_TekniskAnlaeg klassifikationskoder (tek020Klassifikation).
 *
 * Baseret på BBR's officielle kodelister for tekniske anlæg:
 * https://teknik.bbr.dk/kodelister/0/1/0/Klassifikation
 *
 * Bruges til at vise læsbar tekst på BBR-tab + risk-badges (oliefyr,
 * solceller, varmepumper).
 *
 * BIZZ-484: Initial mapping af de mest almindelige koder. Udvid efter
 * behov når BBR returnerer ukendte koder.
 *
 * @module bbrTekniskAnlaegKoder
 */

const TEK020_KODER: Record<string, { tekst: string; kategori: 'energi' | 'tank' | 'andet' }> = {
  // ─── Tanke (1000-serien) ───────────────────────────────────────────────
  '1110': { tekst: 'Olietank under jord', kategori: 'tank' },
  '1120': { tekst: 'Olietank over jord', kategori: 'tank' },
  '1130': { tekst: 'Olietank inde i bygning', kategori: 'tank' },
  '1210': { tekst: 'Gastank', kategori: 'tank' },
  '1220': { tekst: 'Gasflaskeopbevaring', kategori: 'tank' },
  '1230': { tekst: 'Brændselstank/-lager', kategori: 'tank' },
  '1240': { tekst: 'Anden tank/silo', kategori: 'tank' },

  // ─── Vedvarende energi (1300-1400) ─────────────────────────────────────
  '1310': { tekst: 'Solcelleanlæg', kategori: 'energi' },
  '1320': { tekst: 'Solfangeranlæg', kategori: 'energi' },
  '1330': { tekst: 'Husstandsvindmølle', kategori: 'energi' },
  '1340': { tekst: 'Vindmølle', kategori: 'energi' },
  '1350': { tekst: 'Vandmølle/-kraftværk', kategori: 'energi' },

  // ─── Varmepumper (1400) ────────────────────────────────────────────────
  '1410': { tekst: 'Varmepumpe', kategori: 'energi' },
  '1420': { tekst: 'Jordvarmepumpe', kategori: 'energi' },
  '1430': { tekst: 'Luft-til-vand varmepumpe', kategori: 'energi' },
  '1440': { tekst: 'Luft-til-luft varmepumpe', kategori: 'energi' },

  // ─── Andre installationer ──────────────────────────────────────────────
  '1510': { tekst: 'Spildevandsanlæg', kategori: 'andet' },
  '1520': { tekst: 'Brønd/boring', kategori: 'andet' },
  '1610': { tekst: 'Trykluftsanlæg', kategori: 'andet' },
  '1710': { tekst: 'Køleanlæg', kategori: 'andet' },
  '1810': { tekst: 'Elevator', kategori: 'andet' },
  '1820': { tekst: 'Trappelift', kategori: 'andet' },

  '1955': { tekst: 'Andet teknisk anlæg', kategori: 'andet' },
};

/**
 * Returnerer læsbar betegnelse for en tek020Klassifikation-kode.
 *
 * @param kode - BBR teknisk anlæg klassifikationskode
 * @returns Dansk betegnelse, eller koden selv som fallback
 */
export function tekniskAnlaegTekst(kode: string | null | undefined): string {
  if (!kode) return 'Ukendt teknisk anlæg';
  return TEK020_KODER[kode]?.tekst ?? `Teknisk anlæg ${kode}`;
}

/**
 * Returnerer kategori for klassifikationskode — bruges til badge-farver.
 *
 * @param kode - BBR teknisk anlæg klassifikationskode
 * @returns 'energi' | 'tank' | 'andet' eller 'andet' som fallback
 */
export function tekniskAnlaegKategori(
  kode: string | null | undefined
): 'energi' | 'tank' | 'andet' {
  if (!kode) return 'andet';
  return TEK020_KODER[kode]?.kategori ?? 'andet';
}
