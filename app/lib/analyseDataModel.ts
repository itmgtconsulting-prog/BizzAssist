/**
 * analyseDataModel — unified domæne-baseret datamodel for pivot-analyse.
 *
 * BIZZ-1269: Grupperer felter fra materialized views i forretningsdomæner
 * (Ejendom, Virksomhed) med danske labels og type-metadata.
 * Bruges af DataModelPanel for visuel felt-navigation.
 *
 * @module app/lib/analyseDataModel
 */

/** Felt-type for visuel indikator i UI */
export type FieldType = 'text' | 'number' | 'date' | 'boolean';

/** Et felt i datamodellen */
export interface DataModelField {
  /** Kolonne-navn i MV */
  column: string;
  /** Dansk label til UI */
  label: string;
  /** Type (bestemmer ikon) */
  type: FieldType;
  /** Kort beskrivelse til tooltip */
  description: string;
}

/** Et domæne i datamodellen (grupperer relaterede felter) */
export interface DataModelDomain {
  /** Unikt ID */
  id: string;
  /** Dansk label */
  label: string;
  /** Kilde-tabel (public.mv_analyse_*) */
  table: string;
  /** Farve til UI badge (tailwind farvenavn) */
  color: string;
  /** Felter i domænet */
  fields: DataModelField[];
}

/**
 * Unified datamodel organiseret efter forretningsdomæner.
 * Erstatter tekniske tabelnavne med intuitive grupperinger.
 */
export const ANALYSE_DOMAINS: DataModelDomain[] = [
  {
    id: 'ejendom',
    label: 'Ejendom',
    table: 'public.mv_analyse_ejendom',
    color: 'emerald',
    fields: [
      { column: 'bfe_nummer', label: 'BFE-nummer', type: 'number', description: 'Ejendoms-ID' },
      {
        column: 'boligareal_m2',
        label: 'Boligareal (m²)',
        type: 'number',
        description: 'Samlet boligareal',
      },
      {
        column: 'opfoerelsesaar',
        label: 'Opførelsesår',
        type: 'number',
        description: 'Bygningens alder',
      },
      {
        column: 'energimaerke',
        label: 'Energimærke',
        type: 'text',
        description: 'A2015, B, C, D...',
      },
      {
        column: 'anvendelse_tekst',
        label: 'Anvendelse',
        type: 'text',
        description: 'Parcelhus, Lejlighed, Kontor...',
      },
      {
        column: 'anvendelse_kategori',
        label: 'Kategori',
        type: 'text',
        description: 'Bolig, erhverv, institution',
      },
      { column: 'kommunenavn', label: 'Kommune', type: 'text', description: 'Fx Hvidovre, Aarhus' },
      { column: 'region', label: 'Region', type: 'text', description: 'Hovedstaden, Sjælland...' },
      { column: 'ejer_navn', label: 'Ejer', type: 'text', description: 'Ejers navn' },
      {
        column: 'ejer_type',
        label: 'Ejertype',
        type: 'text',
        description: 'Selskab, Privat, Kommune...',
      },
      {
        column: 'ejerandel_pct',
        label: 'Ejerandel (%)',
        type: 'number',
        description: 'Ejerandel i procent',
      },
      {
        column: 'virksomhed_navn',
        label: 'Ejervirksomhed',
        type: 'text',
        description: 'Virksomhedsejers navn',
      },
      {
        column: 'virksomhed_branche',
        label: 'Ejerbranche',
        type: 'text',
        description: 'Virksomhedsejers branche',
      },
      {
        column: 'virksomhed_ansatte',
        label: 'Ejeransatte',
        type: 'number',
        description: 'Ansatte i ejervirksomhed',
      },
    ],
  },
  {
    id: 'virksomhed',
    label: 'Virksomhed',
    table: 'public.mv_analyse_virksomhed',
    color: 'blue',
    fields: [
      { column: 'cvr', label: 'CVR-nummer', type: 'text', description: 'CVR (8 cifre)' },
      { column: 'navn', label: 'Virksomhedsnavn', type: 'text', description: 'Officielt navn' },
      {
        column: 'branche_tekst',
        label: 'Branche',
        type: 'text',
        description: 'Branchebeskrivelse',
      },
      {
        column: 'virksomhedsform',
        label: 'Selskabsform',
        type: 'text',
        description: 'APS, AS, IVS, ENK...',
      },
      { column: 'status', label: 'Status', type: 'text', description: 'NORMAL, OPHØRT...' },
      { column: 'stiftet', label: 'Stiftet', type: 'date', description: 'Stiftelsesdato' },
      { column: 'ansatte', label: 'Ansatte', type: 'number', description: 'Antal årsansatte' },
      {
        column: 'antal_ejendomme',
        label: 'Antal ejendomme',
        type: 'number',
        description: 'Ejede ejendomme',
      },
    ],
  },
];
