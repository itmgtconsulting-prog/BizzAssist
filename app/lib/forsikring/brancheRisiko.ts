/**
 * brancheRisiko — Mapping fra DB07-branchekoder til risiko-kategori
 * og påkrævede forsikringsdækninger.
 *
 * BIZZ-1377: Bruges af gap-engine til branchekode-baserede checks.
 *
 * @module
 */

/** Risiko-kategori for en branche */
export type RisikoKategori = 'standard' | 'hoejrisiko' | 'holding';

/** Påkrævede dækninger for en branche */
export interface BrancheKrav {
  /** Risiko-kategori */
  kategori: RisikoKategori;
  /** Dansk label for branchen */
  label: string;
  /** Påkrævede dæknings-typer */
  kraevede_daekninger: string[];
}

/**
 * Højrisiko-branchekoder (DB07 prefix-match).
 * Branchekoder der matcher et prefix i denne tabel kræver
 * specifikke forsikringer ud over standard bygningsforsikring.
 */
const HOEJRISIKO_BRANCHER: Array<{ prefix: string; krav: BrancheKrav }> = [
  // Restaurant/hotel/café
  {
    prefix: '5610',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Restaurant',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'driftstab', 'produktansvar'],
    },
  },
  {
    prefix: '5621',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Catering',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '5630',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Bar/natklub',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'driftstab'],
    },
  },
  {
    prefix: '5510',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Hotel',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'driftstab', 'rejsegods'],
    },
  },
  // Værksted/industri
  {
    prefix: '25',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Metalforarbejdning',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade', 'maskinkasko'],
    },
  },
  {
    prefix: '33',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Reparation/installation',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade'],
    },
  },
  // Bygge/anlæg
  {
    prefix: '41',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Byggeri',
      kraevede_daekninger: ['all-risk', 'erhvervsansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '42',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Anlægsarbejde',
      kraevede_daekninger: ['all-risk', 'erhvervsansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '43',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Specialiseret byggeri',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade'],
    },
  },
  // Transport
  {
    prefix: '49',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Transport',
      kraevede_daekninger: ['transportansvar', 'godsforsikring'],
    },
  },
  // Kemisk industri
  {
    prefix: '20',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Kemisk industri',
      kraevede_daekninger: ['forurening', 'miljoeansvar', 'erhvervsansvar'],
    },
  },
  // Autolakering
  {
    prefix: '4520',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Autoværksted/lakering',
      kraevede_daekninger: ['forurening', 'brand', 'erhvervsansvar'],
    },
  },
  // Vaskeri
  {
    prefix: '9601',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Vaskeri',
      kraevede_daekninger: ['forurening', 'maskinkasko'],
    },
  },
  // Holding
  {
    prefix: '6420',
    krav: { kategori: 'holding', label: 'Holdingselskab', kraevede_daekninger: ['d&o'] },
  },
];

/**
 * Slå branchekrav op for en branchekode.
 *
 * @param kode - DB07-branchekode (fx "561010", "681020")
 * @returns BrancheKrav eller null (standard-branche)
 */
export function lookupBrancheKrav(kode: string | null): BrancheKrav | null {
  if (!kode) return null;
  const clean = kode.replace(/\./g, '').trim();
  // Længste prefix-match først (mere specifik)
  const sorted = [...HOEJRISIKO_BRANCHER].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const entry of sorted) {
    if (clean.startsWith(entry.prefix)) return entry.krav;
  }
  return null;
}

/**
 * Tjek om en branchekode er operationel (ikke holding/admin).
 *
 * @param kode - DB07-branchekode
 * @returns true hvis operationel
 */
export function isOperationelBranche(kode: string | null): boolean {
  if (!kode) return false;
  const clean = kode.replace(/\./g, '').trim();
  // Holding/admin/finansiel
  const nonOperationelle = ['6420', '6430', '6499', '7010', '7021', '7022'];
  return !nonOperationelle.some((prefix) => clean.startsWith(prefix));
}
