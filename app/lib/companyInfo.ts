/**
 * Centraliseret virksomhedsoplysninger for BizzAssist.
 *
 * Bruges i email footers, PDF-generering, juridiske sider (privacy/terms),
 * og translations. Ét sted at opdatere ved ændring af firmanavn, CVR, eller adresse.
 *
 * @returns Virksomhedsoplysninger for den juridiske enhed bag BizzAssist
 */
export const companyInfo = {
  name: 'Pecunia IT ApS',
  cvr: '44718502',
  address: 'Søbyvej 11',
  postalCode: '2650',
  city: 'Hvidovre',
  country: 'Denmark',

  /** Fuld adressestreng */
  get fullAddress(): string {
    return `${this.address}, ${this.postalCode} ${this.city}`;
  },

  /** Fuld juridisk tekst (DK) — til email footers og PDF */
  get legalLine(): string {
    return `BizzAssist — ${this.name} — ${this.fullAddress} — CVR ${this.cvr}`;
  },

  /** HTML-encoded juridisk tekst — til email footers */
  get legalLineHtml(): string {
    return `BizzAssist &mdash; ${this.name} &mdash; ${this.address.replace(/ø/g, '&oslash;')}, ${this.postalCode} ${this.city} &mdash; CVR ${this.cvr}`;
  },
} as const;
