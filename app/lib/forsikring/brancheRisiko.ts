/**
 * brancheRisiko — Mapping fra DB07-branchekoder til risiko-kategori
 * og påkrævede forsikringsdækninger.
 *
 * BIZZ-1377: Bruges af gap-engine til branchekode-baserede checks.
 *
 * Dækker alle DB07-hovedgrupper (sektioner A–S). Specifikke
 * underbrancher (4 cifre) tilføjes hvor de adskiller sig væsentligt
 * fra hovedgruppen. `lookupBrancheKrav()` matcher længste prefix
 * først, så specifikke koder vinder over generiske.
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
 * Branche-krav-tabel (DB07 prefix-match).
 * Branchekoder der matcher et prefix kræver de listede dækninger.
 * Mere specifikke koder vinder via længste-prefix-match.
 */
const BRANCHE_KRAV: Array<{ prefix: string; krav: BrancheKrav }> = [
  // ─── Sektion B: Råstofudvinding (05-09) ──────────────────────
  {
    prefix: '05',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Kuludvinding',
      kraevede_daekninger: [
        'all-risk',
        'erhvervsansvar',
        'arbejdsskade',
        'forurening',
        'miljoeansvar',
      ],
    },
  },
  {
    prefix: '06',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Olie- og gasudvinding',
      kraevede_daekninger: [
        'all-risk',
        'erhvervsansvar',
        'arbejdsskade',
        'forurening',
        'miljoeansvar',
      ],
    },
  },
  {
    prefix: '07',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Metalmaler-udvinding',
      kraevede_daekninger: ['all-risk', 'erhvervsansvar', 'arbejdsskade', 'forurening'],
    },
  },
  {
    prefix: '08',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Grus-, sten- og saltindvinding',
      kraevede_daekninger: ['all-risk', 'erhvervsansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '09',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Servicetjenester ved råstofudvinding',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade'],
    },
  },

  // ─── Sektion C: Fremstilling (10-33) ─────────────────────────
  {
    prefix: '10',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Fødevarefremstilling',
      kraevede_daekninger: [
        'brand',
        'erhvervsansvar',
        'produktansvar',
        'driftstab',
        'arbejdsskade',
      ],
    },
  },
  {
    prefix: '11',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Drikkevarefremstilling',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'produktansvar', 'driftstab'],
    },
  },
  {
    prefix: '12',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Tobaksindustri',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '13',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Tekstilindustri',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '14',
    krav: {
      kategori: 'standard',
      label: 'Beklædningsindustri',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '15',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Læder- og fodtøjsindustri',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'produktansvar', 'forurening'],
    },
  },
  {
    prefix: '16',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Træ- og korkindustri',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '17',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Papir- og papindustri',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '18',
    krav: {
      kategori: 'standard',
      label: 'Trykkerier og grafisk produktion',
      kraevede_daekninger: ['erhvervsansvar', 'maskinkasko'],
    },
  },
  {
    prefix: '19',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Olieraffinering og kokeværker',
      kraevede_daekninger: [
        'brand',
        'forurening',
        'miljoeansvar',
        'erhvervsansvar',
        'arbejdsskade',
      ],
    },
  },
  {
    prefix: '20',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Kemisk industri',
      kraevede_daekninger: ['forurening', 'miljoeansvar', 'erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '21',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Lægemiddelindustri',
      kraevede_daekninger: [
        'erhvervsansvar',
        'produktansvar',
        'forurening',
        'professionelt_ansvar',
      ],
    },
  },
  {
    prefix: '22',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Plast-, gummi- og glasfiberindustri',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'produktansvar', 'forurening'],
    },
  },
  {
    prefix: '23',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Glas-, keramik- og stenindustri',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '24',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Fremstilling af metal',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'arbejdsskade', 'forurening'],
    },
  },
  {
    prefix: '25',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Metalforarbejdning',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade', 'maskinkasko'],
    },
  },
  {
    prefix: '26',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Elektronik og optik',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar', 'maskinkasko'],
    },
  },
  {
    prefix: '27',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Elektriske apparater',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar', 'brand'],
    },
  },
  {
    prefix: '28',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Maskinindustri',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '29',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Motorkøretøjsindustri',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar', 'arbejdsskade', 'forurening'],
    },
  },
  {
    prefix: '30',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Andre transportmidler',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '31',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Møbelindustri',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '32',
    krav: {
      kategori: 'standard',
      label: 'Anden fremstillingsvirksomhed',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '33',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Reparation og installation af maskiner',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade'],
    },
  },

  // ─── Sektion D-E: Energi, vand, affald (35-39) ───────────────
  {
    prefix: '35',
    krav: {
      kategori: 'hoejrisiko',
      label: 'El-, gas- og fjernvarmeforsyning',
      kraevede_daekninger: [
        'all-risk',
        'erhvervsansvar',
        'arbejdsskade',
        'driftstab',
        'forurening',
      ],
    },
  },
  {
    prefix: '36',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Vandforsyning',
      kraevede_daekninger: ['all-risk', 'erhvervsansvar', 'driftstab', 'forurening'],
    },
  },
  {
    prefix: '37',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Kloak- og spildevandsbehandling',
      kraevede_daekninger: ['erhvervsansvar', 'forurening', 'miljoeansvar'],
    },
  },
  {
    prefix: '38',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Affaldshåndtering og genbrug',
      kraevede_daekninger: ['erhvervsansvar', 'forurening', 'miljoeansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '39',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Rensning af jord og grundvand',
      kraevede_daekninger: ['erhvervsansvar', 'forurening', 'miljoeansvar', 'arbejdsskade'],
    },
  },

  // ─── Sektion F: Bygge og anlæg (41-43) ───────────────────────
  {
    prefix: '41',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Bygningsfærdiggørelse',
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
      label: 'Specialiseret bygge- og anlægsvirksomhed',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade'],
    },
  },

  // ─── Sektion G: Handel (45-47) ───────────────────────────────
  {
    prefix: '4520',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Autoværksted/lakering',
      kraevede_daekninger: ['forurening', 'brand', 'erhvervsansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '45',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Handel med motorkøretøjer',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar', 'indbrud', 'brand'],
    },
  },
  {
    prefix: '46',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Engroshandel',
      kraevede_daekninger: ['erhvervsansvar', 'brand', 'transportansvar', 'driftstab'],
    },
  },
  {
    prefix: '47',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Detailhandel',
      kraevede_daekninger: ['erhvervsansvar', 'indbrud', 'brand', 'driftstab'],
    },
  },

  // ─── Sektion H: Transport (49-53) ────────────────────────────
  {
    prefix: '49',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Landtransport',
      kraevede_daekninger: ['transportansvar', 'godsforsikring', 'kasko'],
    },
  },
  {
    prefix: '50',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Skibsfart',
      kraevede_daekninger: ['transportansvar', 'godsforsikring', 'kasko', 'erhvervsansvar'],
    },
  },
  {
    prefix: '51',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Lufttransport',
      kraevede_daekninger: ['transportansvar', 'godsforsikring', 'kasko', 'erhvervsansvar'],
    },
  },
  {
    prefix: '52',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Hjælpevirksomhed til transport',
      kraevede_daekninger: ['erhvervsansvar', 'godsforsikring', 'brand'],
    },
  },
  {
    prefix: '53',
    krav: {
      kategori: 'standard',
      label: 'Post- og kurertjeneste',
      kraevede_daekninger: ['erhvervsansvar', 'godsforsikring'],
    },
  },

  // ─── Sektion I: Overnatning og restauration (55-56) ──────────
  {
    prefix: '5510',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Hotel',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'driftstab', 'rejsegods'],
    },
  },
  {
    prefix: '55',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Overnatningsfaciliteter',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'driftstab'],
    },
  },
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
    prefix: '56',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Restaurations- og barvirksomhed',
      kraevede_daekninger: ['brand', 'erhvervsansvar', 'driftstab', 'produktansvar'],
    },
  },

  // ─── Sektion J: Information og kommunikation (58-63) ─────────
  {
    prefix: '58',
    krav: {
      kategori: 'standard',
      label: 'Forlagsvirksomhed',
      kraevede_daekninger: ['erhvervsansvar', 'cyberforsikring', 'professionelt_ansvar'],
    },
  },
  {
    prefix: '59',
    krav: {
      kategori: 'standard',
      label: 'Film, video og tv-produktion',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar', 'all-risk'],
    },
  },
  {
    prefix: '60',
    krav: {
      kategori: 'standard',
      label: 'Radio- og tv-virksomhed',
      kraevede_daekninger: ['erhvervsansvar', 'cyberforsikring', 'driftstab'],
    },
  },
  {
    prefix: '61',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Telekommunikation',
      kraevede_daekninger: ['erhvervsansvar', 'cyberforsikring', 'driftstab'],
    },
  },
  {
    prefix: '62',
    krav: {
      kategori: 'standard',
      label: 'IT/software',
      kraevede_daekninger: ['erhvervsansvar', 'cyberforsikring', 'professionelt_ansvar'],
    },
  },
  {
    prefix: '63',
    krav: {
      kategori: 'standard',
      label: 'Informationstjenester',
      kraevede_daekninger: ['erhvervsansvar', 'cyberforsikring'],
    },
  },

  // ─── Sektion K: Finansiering og forsikring (64-66) ───────────
  {
    prefix: '6420',
    krav: { kategori: 'holding', label: 'Holdingselskab', kraevede_daekninger: ['d&o'] },
  },
  {
    prefix: '64',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Pengeinstitutter og finansiering',
      kraevede_daekninger: [
        'erhvervsansvar',
        'professionelt_ansvar',
        'd&o',
        'cyberforsikring',
        'kriminalitet',
      ],
    },
  },
  {
    prefix: '65',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Forsikring og pension',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar', 'd&o', 'cyberforsikring'],
    },
  },
  {
    prefix: '66',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Finansielle hjælpetjenester',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar', 'd&o', 'cyberforsikring'],
    },
  },

  // ─── Sektion L: Fast ejendom (68) ────────────────────────────
  {
    prefix: '6810',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Udlejning af boliger',
      kraevede_daekninger: [
        'ejendomsforsikring',
        'erhvervsansvar',
        'huslejetab',
        'driftstab',
        'hus_grundejer_ansvar',
      ],
    },
  },
  {
    prefix: '6820',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Udlejning af erhvervsejendomme',
      kraevede_daekninger: [
        'ejendomsforsikring',
        'erhvervsansvar',
        'huslejetab',
        'driftstab',
        'hus_grundejer_ansvar',
      ],
    },
  },
  {
    prefix: '68',
    krav: {
      kategori: 'standard',
      label: 'Ejendomsmægler/administration',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar', 'cyberforsikring'],
    },
  },

  // ─── Sektion M: Liberale, videnskab, teknik (69-75) ──────────
  {
    prefix: '69',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Juridisk og regnskab',
      kraevede_daekninger: [
        'erhvervsansvar',
        'professionelt_ansvar',
        'cyberforsikring',
        'kriminalitet',
      ],
    },
  },
  {
    prefix: '70',
    krav: {
      kategori: 'standard',
      label: 'Rådgivning og virksomhedsledelse',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar', 'd&o'],
    },
  },
  {
    prefix: '71',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Arkitekt-, ingeniør- og teknisk konsulent',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar', 'all-risk'],
    },
  },
  {
    prefix: '72',
    krav: {
      kategori: 'standard',
      label: 'Forskning og udvikling',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar', 'cyberforsikring'],
    },
  },
  {
    prefix: '73',
    krav: {
      kategori: 'standard',
      label: 'Reklame og markedsanalyse',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar', 'cyberforsikring'],
    },
  },
  {
    prefix: '74',
    krav: {
      kategori: 'standard',
      label: 'Anden videnservice',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar'],
    },
  },
  {
    prefix: '75',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Dyrlægevirksomhed',
      kraevede_daekninger: ['erhvervsansvar', 'behandlingsansvar', 'professionelt_ansvar'],
    },
  },

  // ─── Sektion N: Administrative og hjælpetjenester (77-82) ────
  {
    prefix: '7711',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Biludlejning',
      kraevede_daekninger: ['kasko', 'erhvervsansvar', 'transportansvar'],
    },
  },
  {
    prefix: '77',
    krav: {
      kategori: 'standard',
      label: 'Udlejning og leasing',
      kraevede_daekninger: ['erhvervsansvar', 'kasko', 'maskinkasko'],
    },
  },
  {
    prefix: '78',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Arbejdsformidling og vikarbureau',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade', 'professionelt_ansvar'],
    },
  },
  {
    prefix: '79',
    krav: {
      kategori: 'standard',
      label: 'Rejsebureauer og turisme',
      kraevede_daekninger: ['erhvervsansvar', 'professionelt_ansvar', 'rejsegods', 'kriminalitet'],
    },
  },
  {
    prefix: '80',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Vagt-, sikkerheds- og efterforskningsvirksomhed',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade', 'kriminalitet'],
    },
  },
  {
    prefix: '8129',
    krav: {
      kategori: 'standard',
      label: 'Anden rengøring',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '81',
    krav: {
      kategori: 'standard',
      label: 'Service af bygninger og anlæg',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade'],
    },
  },
  {
    prefix: '82',
    krav: {
      kategori: 'standard',
      label: 'Administration og kontorservice',
      kraevede_daekninger: ['erhvervsansvar', 'cyberforsikring'],
    },
  },

  // ─── Sektion O: Offentlig administration (84) ────────────────
  {
    prefix: '84',
    krav: {
      kategori: 'standard',
      label: 'Offentlig administration og forsvar',
      kraevede_daekninger: ['erhvervsansvar', 'd&o', 'cyberforsikring'],
    },
  },

  // ─── Sektion P: Undervisning (85) ────────────────────────────
  {
    prefix: '85',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Undervisning',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade', 'professionelt_ansvar'],
    },
  },

  // ─── Sektion Q: Sundhed og sociale tjenester (86-88) ─────────
  {
    prefix: '86',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Sundhedsvæsen',
      kraevede_daekninger: [
        'erhvervsansvar',
        'behandlingsansvar',
        'patientforsikring',
        'professionelt_ansvar',
      ],
    },
  },
  {
    prefix: '87',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Plejehjem og institutionsophold',
      kraevede_daekninger: [
        'erhvervsansvar',
        'behandlingsansvar',
        'patientforsikring',
        'arbejdsskade',
      ],
    },
  },
  {
    prefix: '88',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Sociale foranstaltninger uden institutionsophold',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade', 'behandlingsansvar'],
    },
  },

  // ─── Sektion R: Kultur, forlystelser og sport (90-93) ────────
  {
    prefix: '90',
    krav: {
      kategori: 'standard',
      label: 'Kreative, kunstneriske og forlystelses-aktiviteter',
      kraevede_daekninger: ['erhvervsansvar', 'all-risk'],
    },
  },
  {
    prefix: '91',
    krav: {
      kategori: 'standard',
      label: 'Biblioteker, arkiver, museer',
      kraevede_daekninger: ['erhvervsansvar', 'brand', 'all-risk'],
    },
  },
  {
    prefix: '92',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Lotteri og spillevirksomhed',
      kraevede_daekninger: [
        'erhvervsansvar',
        'd&o',
        'professionelt_ansvar',
        'kriminalitet',
        'cyberforsikring',
      ],
    },
  },
  {
    prefix: '93',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Sport, forlystelser og fritid',
      kraevede_daekninger: ['erhvervsansvar', 'arbejdsskade', 'driftstab'],
    },
  },

  // ─── Sektion S: Andre serviceydelser (94-96) ─────────────────
  {
    prefix: '94',
    krav: {
      kategori: 'standard',
      label: 'Organisationer (forenings-, faglige, religiøse)',
      kraevede_daekninger: ['erhvervsansvar', 'd&o'],
    },
  },
  {
    prefix: '95',
    krav: {
      kategori: 'standard',
      label: 'Reparation af husholdningsartikler',
      kraevede_daekninger: ['erhvervsansvar', 'produktansvar'],
    },
  },
  {
    prefix: '9601',
    krav: {
      kategori: 'hoejrisiko',
      label: 'Vaskeri',
      kraevede_daekninger: ['forurening', 'maskinkasko', 'erhvervsansvar'],
    },
  },
  {
    prefix: '9602',
    krav: {
      kategori: 'standard',
      label: 'Frisør- og skønhedssalon',
      kraevede_daekninger: ['erhvervsansvar', 'behandlingsansvar'],
    },
  },
  {
    prefix: '96',
    krav: {
      kategori: 'standard',
      label: 'Andre personlige serviceydelser',
      kraevede_daekninger: ['erhvervsansvar'],
    },
  },
];

/** Bagudkompatibelt alias — tidligere navngivet HOEJRISIKO_BRANCHER. */
const HOEJRISIKO_BRANCHER = BRANCHE_KRAV;

/**
 * Slå branchekrav op for en branchekode.
 *
 * @param kode - DB07-branchekode (fx "561010", "681020")
 * @returns BrancheKrav eller null (standard-branche uden specifikke krav)
 */
export function lookupBrancheKrav(kode: string | null): BrancheKrav | null {
  if (!kode) return null;
  const clean = kode.replace(/\./g, '').trim();
  // Længste prefix-match først (mere specifik vinder over generisk)
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
  // Holding/management/investerings-prefixes — ikke operationelle
  const nonOperationelle = ['6420', '6430', '6499', '7010', '7021', '7022'];
  return !nonOperationelle.some((prefix) => clean.startsWith(prefix));
}
