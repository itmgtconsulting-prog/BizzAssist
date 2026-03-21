/**
 * Mock ejendomsdata til BizzAssist demo.
 * Afspejler realistiske danske ejendomme med BBR, tinglysning og økonomidata.
 * Udskiftes med Datafordeleren API i produktion.
 */

/** Simpel ejerrepræsentation til overblikssektionen. */
export interface Ejer {
  navn: string;
  cvr?: string;
  type: 'selskab' | 'person';
  ejerandel: number; // procent
  erhvervsdato: string;
}

/** Tinglyst hæftelse på ejendommen. */
export interface Haeftelse {
  id: string;
  type: 'pantebrev' | 'ejerpantebrev' | 'servitut' | 'udlæg';
  kreditor: string;
  debitor?: string;
  prioritet?: number;
  beloeb?: number;
  tinglysningsdato: string;
  status: 'aktiv' | 'aflyst';
  dokument: string;
}

/** En enkelt handel i handelshistorikken. */
export interface HandelHistorik {
  dato: string;
  pris: number;
  prisPerM2: number;
  koeberType: 'selskab' | 'person';
}

/** BBR-bygningsdata. */
export interface BBRBygning {
  id: string;
  opfoerelsesaar: number;
  bygningsareal: number;
  kaelder: number;
  tagetage: number;
  etager: number;
  tagmateriale: string;
  ydervaeggene: string;
  varmeinstallation: string;
  opvarmningsmaade: string;
  vandforsyning: string;
  afloebsforhold: string;
  energimaerke: 'A2020' | 'A2015' | 'A2010' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  anvendelse: string;
  boligenheder: number;
  erhvervsenheder: number;
  beboelsesareal: number;
  erhvervsareal: number;
}

/** Miljøindikator for en ejendom. */
export interface Miljoeindikator {
  id: string;
  titel: string;
  beskrivelse: string;
  status: 'aktiv' | 'inaktiv' | 'advarsel';
  ikon: string;
}

/** Virksomhed der har/har haft adresse på ejendommen. */
export interface VirksomhedPaaAdresse {
  navn: string;
  adresse: string;
  industri: string;
  /** Fx "17 år til nu" */
  periode: string;
  ansatte?: number;
  cvr: string;
}

/** Nuværende adkomsthaver ifølge tinglysning. */
export interface Adkomsthaver {
  navn: string;
  cvr?: string;
  /** Procent */
  andel: number;
  /** Fx "Skøde" */
  type: string;
  beloeb: number;
  dato: string;
}

/** Historisk adkomst (tidligere ejere). */
export interface HistoriskAdkomst {
  /** Array af navne — kan være flere medejere. */
  navne: string[];
  /** Array af procentandele, matcher navne-indeks. */
  andele: number[];
  type: string;
  beloeb: number;
  dato: string;
}

/** Node i ejerstruktur-træet. */
export interface EjerstrukturNode {
  id: string;
  navn: string;
  type: 'person' | 'selskab' | 'ejendom';
  /** Fx "Led" */
  titel?: string;
  /** 0–100 */
  andel?: number;
  foraeldreId?: string;
}

/** Detaljerede oplysninger om den nuværende ejer (selskab). */
export interface EjerDetaljer {
  navn: string;
  cvr: string;
  adresse: string;
  overtagelsesdato: string;
  ejertype: string;
  branche: string;
  telefon: string;
  email: string;
  tegningsregel: string;
  reklamebeskyttet: boolean;
  noegletal: {
    aar: number;
    resultatFoerSkat: number;
    resultat: number;
  };
}

/** En række i salgshistoriktabellen. */
export interface SalgsHistorikRaekke {
  /** Liste af købere med valgfri andel. */
  koebere: { navn: string; andel?: number }[];
  /** Fx "Skøde", "Familieoverdragelse", "Endeligt skøde". */
  handelstype: string;
  kilde: 'tinglysning' | 'ejerfortegnelsen';
  /** Samlet andel. */
  andel?: number;
  pris: number;
  dato: string;
}

/** En række i udbudshistoriktabellen. */
export interface UdbudsHistorikRaekke {
  status: string;
  /** Positiv = prisstigning, negativ = prisfald. */
  prisaendring?: number;
  pris: number;
  dato: string;
}

/** BBR Jordstykke. */
export interface Jordstykke {
  matrikelNummer: string;
  ejerlavsnavn: string;
  /** m² */
  registreretAreal: number;
}

/** BBR Enhed. */
export interface Enhed {
  adresse: string;
  anvendelse: string;
  vaerelser?: number;
  /** m² */
  samletAreal: number;
}

/** Fuld ejendomsmodel. */
export interface Ejendom {
  id: string;
  bfe: string;
  esr: string;
  adresse: string;
  postnummer: string;
  by: string;
  kommune: string;
  matrikelNummer: string;
  ejendomstype: string;
  opfoerelsesaar: number;

  // Arealer
  grundareal: number;
  bebyggelsesprocent: number;

  // Bygning (primær)
  bygningsareal: number;
  kaelder: number;
  etager: number;

  // Enheder
  beboelsesareal: number;
  erhvervsareal: number;
  beboelsesenheder: number;
  erhvervsenheder: number;

  // Økonomi
  ejendomsvaerdi: number;
  grundvaerdi: number;
  skat: number;
  grundskyld: number;

  // Handel
  senesteHandel: {
    pris: number;
    dato: string;
    prisPerM2: number;
  };
  handelHistorik: HandelHistorik[];

  // Ejere
  ejere: Ejer[];

  // BBR
  bygninger: BBRBygning[];

  // Tinglysning
  haeftelser: Haeftelse[];

  // Miljø
  miljoeindikatorer: Miljoeindikator[];

  // Geo
  lat: number;
  lng: number;

  // Meta
  thumbnail?: string;

  // --- Udvidede felter (Resights-niveau) ---

  /** Virksomheder registreret på adressen. */
  virksomhederPaaAdressen?: VirksomhedPaaAdresse[];

  /** Nuværende adkomsthaver fra tinglysning. */
  adkomsthaver?: Adkomsthaver;

  /** Historiske adkomster fra tinglysning. */
  historiskeAdkomster?: HistoriskAdkomst[];

  /** Tingbogsattest metadata. */
  tingbogsattest?: {
    aktNummer: string;
    matrikler: { matrikelNummer: string; areal: number; registreringsdato: string }[];
  };

  /** Ejerstruktur som fladt array af noder (bygger et træ). */
  ejerstruktur?: EjerstrukturNode[];

  /** Detaljerede oplysninger om den aktuelle ejer. */
  ejerDetaljer?: EjerDetaljer;

  /** Salgshistorik med købernavne og handelstype. */
  salgshistorik?: SalgsHistorikRaekke[];

  /** Udbudshistorik fra ejendomsmæglere. */
  udbudshistorik?: UdbudsHistorikRaekke[];

  /** BBR Jordstykker. */
  jordstykker?: Jordstykke[];

  /** BBR Enheder. */
  enheder?: Enhed[];

  /** Antal tekniske anlæg registreret i BBR. */
  tekniskeAnlaeg?: number;
}

export const mockEjendomme: Ejendom[] = [
  {
    id: 'ej-001',
    bfe: '2091183',
    esr: '167-2811',
    adresse: 'Arnold Nielsens Boulevard 64A',
    postnummer: '2650',
    by: 'Hvidovre',
    kommune: 'Hvidovre Kommune',
    matrikelNummer: '21co, Hvidovre By, Risbjerg',
    ejendomstype: 'Handel og/eller kontor (1958)',
    opfoerelsesaar: 1958,
    grundareal: 1648,
    bebyggelsesprocent: 67,
    bygningsareal: 1104,
    kaelder: 76,
    etager: 2,
    beboelsesareal: 0,
    erhvervsareal: 1104,
    beboelsesenheder: 0,
    erhvervsenheder: 1,
    ejendomsvaerdi: 12242000,
    grundvaerdi: 12242000,
    skat: 65400,
    grundskyld: 65400,
    senesteHandel: {
      pris: 12500000,
      dato: '2025-12-09',
      prisPerM2: 11322,
    },
    handelHistorik: [
      { dato: '2025-12-09', pris: 12500000, prisPerM2: 11322, koeberType: 'selskab' },
      { dato: '2021-03-15', pris: 9800000, prisPerM2: 8877, koeberType: 'selskab' },
      { dato: '2017-06-22', pris: 7200000, prisPerM2: 6522, koeberType: 'selskab' },
      { dato: '2013-11-08', pris: 5500000, prisPerM2: 4982, koeberType: 'person' },
      { dato: '2009-04-17', pris: 4100000, prisPerM2: 3714, koeberType: 'selskab' },
    ],
    ejere: [
      {
        navn: 'JAJR Ejendomme 2 ApS',
        cvr: '43817652',
        type: 'selskab',
        ejerandel: 100,
        erhvervsdato: '2025-12-09',
      },
    ],
    bygninger: [
      {
        id: 'bbr-001',
        opfoerelsesaar: 1958,
        bygningsareal: 1104,
        kaelder: 76,
        tagetage: 0,
        etager: 2,
        tagmateriale: 'Fibercement, herunder asbest',
        ydervaeggene: 'Mursten',
        varmeinstallation: 'Centralvarme med én fyringsenhed',
        opvarmningsmaade: 'Fjernvarme/blokvarme',
        vandforsyning: 'Alment vandforsyningsanlæg',
        afloebsforhold: 'Afløb til kommunal kloak',
        energimaerke: 'D',
        anvendelse: 'Kontor, handel, lager, offentlig administration',
        boligenheder: 0,
        erhvervsenheder: 1,
        beboelsesareal: 0,
        erhvervsareal: 1104,
      },
    ],
    haeftelser: [
      {
        id: 'h-001',
        type: 'pantebrev',
        kreditor: 'Nykredit Realkredit A/S',
        debitor: 'JAJR Ejendomme 2 ApS',
        prioritet: 1,
        beloeb: 8500000,
        tinglysningsdato: '2025-12-09',
        status: 'aktiv',
        dokument: 'Pantebrev 2025-12-09',
      },
      {
        id: 'h-002',
        type: 'servitut',
        kreditor: 'Hvidovre Kommune',
        debitor: 'Ejer til enhver tid',
        prioritet: 2,
        tinglysningsdato: '1972-04-15',
        status: 'aktiv',
        dokument: 'Deklaration om byggelinje',
      },
    ],
    miljoeindikatorer: [
      {
        id: 'm-001',
        titel: 'Boringer',
        beskrivelse: 'Der er 5 aktive boringer.',
        status: 'advarsel',
        ikon: '🔩',
      },
      {
        id: 'm-002',
        titel: 'Byzone',
        beskrivelse: 'Ejendommen ligger i byzone.',
        status: 'aktiv',
        ikon: '🏙️',
      },
      {
        id: 'm-003',
        titel: 'Grundvandsbeskyttelse',
        beskrivelse: 'Indsatsplan for grundvandsbeskyttelse i Hvidovre Kommune.',
        status: 'advarsel',
        ikon: '💧',
      },
      {
        id: 'm-004',
        titel: 'Jordforurening V2',
        beskrivelse: 'Kortlagt på V2 niveau.',
        status: 'advarsel',
        ikon: '⚠️',
      },
      {
        id: 'm-005',
        titel: 'Kystnærhedszone',
        beskrivelse: 'Ejendommen er ikke i kystnærhedszone.',
        status: 'inaktiv',
        ikon: '🌊',
      },
      {
        id: 'm-006',
        titel: 'Områdeklassificering',
        beskrivelse: 'Område med krav om analyser.',
        status: 'advarsel',
        ikon: '🗺️',
      },
    ],
    lat: 55.6397,
    lng: 12.4784,

    // --- Udvidede data ---
    virksomhederPaaAdressen: [
      {
        navn: 'JAJR Ejendomme 2 ApS',
        adresse: 'Arnold Nielsens Boulevard 64A, 2650 Hvidovre',
        industri: 'Køb og salg af egen fast ejendom',
        periode: '3 mdr. til nu',
        ansatte: 1,
        cvr: '43817652',
      },
      {
        navn: 'Hvidovre VVS & Ventilation A/S',
        adresse: 'Arnold Nielsens Boulevard 64A, 2650 Hvidovre',
        industri: 'VVS-arbejde',
        periode: '17 år til nu',
        ansatte: 24,
        cvr: '27384910',
      },
      {
        navn: 'Risbjerg El-Service ApS',
        adresse: 'Arnold Nielsens Boulevard 64A, 2650 Hvidovre',
        industri: 'Elektriske installationer',
        periode: '11 år til nu',
        ansatte: 8,
        cvr: '31029847',
      },
    ],

    adkomsthaver: {
      navn: 'JAJR Ejendomme 2 ApS',
      cvr: '43817652',
      andel: 100,
      type: 'Skøde',
      beloeb: 12500000,
      dato: '2025-12-09',
    },

    historiskeAdkomster: [
      {
        navne: ['Hvidovre Erhverv Holding ApS'],
        andele: [100],
        type: 'Skøde',
        beloeb: 9800000,
        dato: '2021-03-15',
      },
      {
        navne: ['BV Invest ApS'],
        andele: [100],
        type: 'Endeligt skøde',
        beloeb: 7200000,
        dato: '2017-06-22',
      },
      {
        navne: ['Bent Viggo Nielsen', 'Kirsten Nielsen'],
        andele: [50, 50],
        type: 'Familieoverdragelse',
        beloeb: 5500000,
        dato: '2013-11-08',
      },
      {
        navne: ['ANB Ejendomme K/S'],
        andele: [100],
        type: 'Skøde',
        beloeb: 4100000,
        dato: '2009-04-17',
      },
    ],

    tingbogsattest: {
      aktNummer: '2025-12-09.A.22837',
      matrikler: [
        {
          matrikelNummer: '21co, Hvidovre By, Risbjerg',
          areal: 1648,
          registreringsdato: '2025-12-09',
        },
      ],
    },

    ejerstruktur: [
      {
        id: 'node-jakob',
        navn: 'Jakob Juul Rasmussen',
        type: 'person',
        titel: 'Direktør & ejer',
        andel: 100,
      },
      {
        id: 'node-holding',
        navn: 'JAJR Holding ApS',
        type: 'selskab',
        titel: 'Holdingselskab',
        cvr: '41928374',
        andel: 100,
        foraeldreId: 'node-jakob',
      } as EjerstrukturNode & { cvr: string },
      {
        id: 'node-ejendom2',
        navn: 'JAJR Ejendomme 2 ApS',
        type: 'selskab',
        titel: 'Driftsselskab',
        cvr: '43817652',
        andel: 100,
        foraeldreId: 'node-holding',
      } as EjerstrukturNode & { cvr: string },
      {
        id: 'node-property',
        navn: 'Arnold Nielsens Boulevard 64A',
        type: 'ejendom',
        titel: 'BFE 2091183',
        foraeldreId: 'node-ejendom2',
      },
    ],

    ejerDetaljer: {
      navn: 'JAJR Ejendomme 2 ApS',
      cvr: '43817652',
      adresse: 'Arnold Nielsens Boulevard 64A, 2650 Hvidovre',
      overtagelsesdato: '2025-12-09',
      ejertype: 'Selskab',
      branche: 'Køb og salg af egen fast ejendom (682040)',
      telefon: '+45 20 30 40 50',
      email: 'jakob@jajr.dk',
      tegningsregel: 'Direktionen alene',
      reklamebeskyttet: false,
      noegletal: {
        aar: 2023,
        resultatFoerSkat: 480000,
        resultat: 372000,
      },
    },

    salgshistorik: [
      {
        koebere: [{ navn: 'JAJR Ejendomme 2 ApS', andel: 100 }],
        handelstype: 'Skøde',
        kilde: 'tinglysning',
        andel: 100,
        pris: 12500000,
        dato: '2025-12-09',
      },
      {
        koebere: [{ navn: 'Hvidovre Erhverv Holding ApS', andel: 100 }],
        handelstype: 'Almindelig fri handel',
        kilde: 'tinglysning',
        andel: 100,
        pris: 9800000,
        dato: '2021-03-15',
      },
      {
        koebere: [{ navn: 'BV Invest ApS', andel: 100 }],
        handelstype: 'Endeligt skøde',
        kilde: 'ejerfortegnelsen',
        andel: 100,
        pris: 7200000,
        dato: '2017-06-22',
      },
      {
        koebere: [
          { navn: 'Bent Viggo Nielsen', andel: 50 },
          { navn: 'Kirsten Nielsen', andel: 50 },
        ],
        handelstype: 'Familieoverdragelse',
        kilde: 'tinglysning',
        andel: 100,
        pris: 5500000,
        dato: '2013-11-08',
      },
      {
        koebere: [{ navn: 'ANB Ejendomme K/S', andel: 100 }],
        handelstype: 'Skøde',
        kilde: 'tinglysning',
        andel: 100,
        pris: 4100000,
        dato: '2009-04-17',
      },
    ],

    udbudshistorik: [],

    jordstykker: [
      {
        matrikelNummer: '21co',
        ejerlavsnavn: 'Hvidovre By, Risbjerg',
        registreretAreal: 1648,
      },
    ],

    enheder: [
      {
        adresse: 'Arnold Nielsens Boulevard 64A, 2650 Hvidovre',
        anvendelse: 'Kontor',
        vaerelser: undefined,
        samletAreal: 1104,
      },
    ],

    tekniskeAnlaeg: 0,
  },
  {
    id: 'ej-002',
    bfe: '1847392',
    esr: '101-4421',
    adresse: 'Østergade 24',
    postnummer: '1100',
    by: 'København K',
    kommune: 'Københavns Kommune',
    matrikelNummer: '412, København',
    ejendomstype: 'Beboelsesejendom (1890)',
    opfoerelsesaar: 1890,
    grundareal: 520,
    bebyggelsesprocent: 185,
    bygningsareal: 962,
    kaelder: 120,
    etager: 5,
    beboelsesareal: 780,
    erhvervsareal: 182,
    beboelsesenheder: 8,
    erhvervsenheder: 2,
    ejendomsvaerdi: 28500000,
    grundvaerdi: 18200000,
    skat: 142000,
    grundskyld: 142000,
    senesteHandel: {
      pris: 31200000,
      dato: '2024-06-15',
      prisPerM2: 32432,
    },
    handelHistorik: [
      { dato: '2024-06-15', pris: 31200000, prisPerM2: 32432, koeberType: 'selskab' },
      { dato: '2019-09-03', pris: 24500000, prisPerM2: 25468, koeberType: 'selskab' },
      { dato: '2014-03-28', pris: 17800000, prisPerM2: 18503, koeberType: 'person' },
      { dato: '2008-11-12', pris: 14200000, prisPerM2: 14761, koeberType: 'selskab' },
    ],
    ejere: [
      {
        navn: 'K1 Invest ApS',
        cvr: '38291047',
        type: 'selskab',
        ejerandel: 100,
        erhvervsdato: '2024-06-15',
      },
    ],
    bygninger: [
      {
        id: 'bbr-002',
        opfoerelsesaar: 1890,
        bygningsareal: 962,
        kaelder: 120,
        tagetage: 0,
        etager: 5,
        tagmateriale: 'Tegl',
        ydervaeggene: 'Mursten',
        varmeinstallation: 'Centralvarme med én fyringsenhed',
        opvarmningsmaade: 'Fjernvarme/blokvarme',
        vandforsyning: 'Alment vandforsyningsanlæg',
        afloebsforhold: 'Afløb til kommunal kloak',
        energimaerke: 'E',
        anvendelse: 'Beboelsesbygning',
        boligenheder: 8,
        erhvervsenheder: 2,
        beboelsesareal: 780,
        erhvervsareal: 182,
      },
    ],
    haeftelser: [
      {
        id: 'h-003',
        type: 'pantebrev',
        kreditor: 'Realkredit Danmark A/S',
        debitor: 'K1 Invest ApS',
        prioritet: 1,
        beloeb: 20000000,
        tinglysningsdato: '2024-06-15',
        status: 'aktiv',
        dokument: 'Pantebrev 2024-06-15',
      },
    ],
    miljoeindikatorer: [
      {
        id: 'm-007',
        titel: 'Byzone',
        beskrivelse: 'Ejendommen ligger i byzone.',
        status: 'aktiv',
        ikon: '🏙️',
      },
      {
        id: 'm-008',
        titel: 'Støjbelastning',
        beskrivelse: 'Ejendommen er støjbelastet fra Strøget.',
        status: 'advarsel',
        ikon: '🔊',
      },
    ],
    lat: 55.6784,
    lng: 12.5841,
  },
  {
    id: 'ej-003',
    bfe: '3291847',
    esr: '751-8831',
    adresse: 'Strandvejen 142',
    postnummer: '2900',
    by: 'Hellerup',
    kommune: 'Gentofte Kommune',
    matrikelNummer: '4b, Hellerup By',
    ejendomstype: 'Parcelhus (1965)',
    opfoerelsesaar: 1965,
    grundareal: 1240,
    bebyggelsesprocent: 18,
    bygningsareal: 224,
    kaelder: 60,
    etager: 1,
    beboelsesareal: 224,
    erhvervsareal: 0,
    beboelsesenheder: 1,
    erhvervsenheder: 0,
    ejendomsvaerdi: 9800000,
    grundvaerdi: 7400000,
    skat: 48200,
    grundskyld: 48200,
    senesteHandel: {
      pris: 10500000,
      dato: '2023-08-22',
      prisPerM2: 46875,
    },
    handelHistorik: [
      { dato: '2023-08-22', pris: 10500000, prisPerM2: 46875, koeberType: 'person' },
      { dato: '2018-05-11', pris: 8200000, prisPerM2: 36607, koeberType: 'person' },
      { dato: '2012-02-14', pris: 5800000, prisPerM2: 25893, koeberType: 'person' },
    ],
    ejere: [
      {
        navn: 'Mette og Lars Andersen',
        type: 'person',
        ejerandel: 100,
        erhvervsdato: '2023-08-22',
      },
    ],
    bygninger: [
      {
        id: 'bbr-003',
        opfoerelsesaar: 1965,
        bygningsareal: 224,
        kaelder: 60,
        tagetage: 0,
        etager: 1,
        tagmateriale: 'Tegl',
        ydervaeggene: 'Mursten',
        varmeinstallation: 'Centralvarme med én fyringsenhed',
        opvarmningsmaade: 'Naturgas fra nettet',
        vandforsyning: 'Alment vandforsyningsanlæg',
        afloebsforhold: 'Afløb til kommunal kloak',
        energimaerke: 'C',
        anvendelse: 'Beboelsesbygning',
        boligenheder: 1,
        erhvervsenheder: 0,
        beboelsesareal: 224,
        erhvervsareal: 0,
      },
    ],
    haeftelser: [
      {
        id: 'h-004',
        type: 'pantebrev',
        kreditor: 'Jyske Realkredit A/S',
        debitor: 'Mette og Lars Andersen',
        prioritet: 1,
        beloeb: 6500000,
        tinglysningsdato: '2023-08-22',
        status: 'aktiv',
        dokument: 'Pantebrev 2023-08-22',
      },
    ],
    miljoeindikatorer: [
      {
        id: 'm-009',
        titel: 'Byzone',
        beskrivelse: 'Ejendommen ligger i byzone.',
        status: 'aktiv',
        ikon: '🏙️',
      },
      {
        id: 'm-010',
        titel: 'Kystnærhedszone',
        beskrivelse: 'Ejendommen er i kystnærhedszone (300m fra kyst).',
        status: 'advarsel',
        ikon: '🌊',
      },
    ],
    lat: 55.7312,
    lng: 12.5764,
  },
  {
    id: 'ej-004',
    bfe: '4182736',
    esr: '461-1192',
    adresse: 'Industrivej 8',
    postnummer: '8000',
    by: 'Aarhus C',
    kommune: 'Aarhus Kommune',
    matrikelNummer: '12a, Aarhus Markjorder',
    ejendomstype: 'Industri/lager (1992)',
    opfoerelsesaar: 1992,
    grundareal: 4800,
    bebyggelsesprocent: 42,
    bygningsareal: 2016,
    kaelder: 0,
    etager: 1,
    beboelsesareal: 0,
    erhvervsareal: 2016,
    beboelsesenheder: 0,
    erhvervsenheder: 3,
    ejendomsvaerdi: 18700000,
    grundvaerdi: 9200000,
    skat: 89400,
    grundskyld: 89400,
    senesteHandel: {
      pris: 19500000,
      dato: '2022-11-03',
      prisPerM2: 9682,
    },
    handelHistorik: [
      { dato: '2022-11-03', pris: 19500000, prisPerM2: 9682, koeberType: 'selskab' },
      { dato: '2016-07-28', pris: 13200000, prisPerM2: 6548, koeberType: 'selskab' },
      { dato: '2010-03-19', pris: 8900000, prisPerM2: 4415, koeberType: 'selskab' },
    ],
    ejere: [
      {
        navn: 'Aarhus Logistik A/S',
        cvr: '29184736',
        type: 'selskab',
        ejerandel: 75,
        erhvervsdato: '2022-11-03',
      },
      {
        navn: 'Midtjysk Invest ApS',
        cvr: '34827165',
        type: 'selskab',
        ejerandel: 25,
        erhvervsdato: '2022-11-03',
      },
    ],
    bygninger: [
      {
        id: 'bbr-004',
        opfoerelsesaar: 1992,
        bygningsareal: 2016,
        kaelder: 0,
        tagetage: 0,
        etager: 1,
        tagmateriale: 'Fibercement, herunder asbest',
        ydervaeggene: 'Pladebeklædning',
        varmeinstallation: 'Centralvarme med én fyringsenhed',
        opvarmningsmaade: 'Naturgas fra nettet',
        vandforsyning: 'Alment vandforsyningsanlæg',
        afloebsforhold: 'Afløb til kommunal kloak',
        energimaerke: 'F',
        anvendelse: 'Industri og lager',
        boligenheder: 0,
        erhvervsenheder: 3,
        beboelsesareal: 0,
        erhvervsareal: 2016,
      },
    ],
    haeftelser: [
      {
        id: 'h-005',
        type: 'pantebrev',
        kreditor: 'Sydbank A/S',
        debitor: 'Aarhus Logistik A/S',
        prioritet: 1,
        beloeb: 12000000,
        tinglysningsdato: '2022-11-03',
        status: 'aktiv',
        dokument: 'Pantebrev 2022-11-03',
      },
      {
        id: 'h-006',
        type: 'ejerpantebrev',
        kreditor: 'Aarhus Logistik A/S',
        debitor: 'Aarhus Logistik A/S',
        prioritet: 2,
        beloeb: 3000000,
        tinglysningsdato: '2022-11-03',
        status: 'aktiv',
        dokument: 'Ejerpantebrev 2022-11-03',
      },
    ],
    miljoeindikatorer: [
      {
        id: 'm-011',
        titel: 'Erhvervszone',
        beskrivelse: 'Ejendommen er i erhvervszone.',
        status: 'aktiv',
        ikon: '🏭',
      },
      {
        id: 'm-012',
        titel: 'Jordforurening V1',
        beskrivelse: 'Kortlagt på V1 niveau (mulig forurening).',
        status: 'advarsel',
        ikon: '⚠️',
      },
    ],
    lat: 56.1543,
    lng: 10.1921,
  },
];

/**
 * Slår en ejendom op via id.
 * @param id - Ejendomsid
 * @returns Ejendom eller undefined
 */
export function getEjendomById(id: string): Ejendom | undefined {
  return mockEjendomme.find((e) => e.id === id);
}

/**
 * Formaterer et beløb til dansk valuta.
 * @param beloeb - Beløb i DKK
 * @returns Formateret streng, fx "12.500.000 DKK"
 */
export function formatDKK(beloeb: number): string {
  return beloeb.toLocaleString('da-DK') + ' DKK';
}

/**
 * Formaterer en dato til dansk format.
 * @param dato - ISO dato-streng
 * @returns Dansk datoformat, fx "9. dec. 2025"
 */
export function formatDato(dato: string): string {
  return new Date(dato).toLocaleDateString('da-DK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
