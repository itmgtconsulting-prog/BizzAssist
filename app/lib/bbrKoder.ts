/**
 * BBR kodeværdi-oversætter.
 *
 * Datafordeler BBR returnerer numeriske koder for mange felter.
 * Disse tabeller oversætter koder til menneskelig-læsbare strenge.
 *
 * Kilde: https://teknik.bbr.dk/kodelister/0/1/0
 */

/** Slår en kode op i en tabel — returnerer koden selv hvis ikke fundet. */
function lookup(tabel: Record<number, string>, kode: number | null | undefined): string {
  if (kode == null) return '–';
  return tabel[kode] ?? `Ukendt (${kode})`;
}

// ─── Tagkonstruktion (BYG_TAGKONSTRUKTION) ─────────────────────────────────
const tagKonstruktion: Record<number, string> = {
  1: 'Fladt tag',
  2: 'Ensidig taghældning',
  3: 'Sadeltag',
  4: 'Valmet tag',
  5: 'Mansardtag',
  6: 'Andet tag',
  7: 'Ingen oplysning',
};

// ─── Tagmateriale (BYG_TAGDÆKNINGMATERIALE) ───────────────────────────────
const tagMateriale: Record<number, string> = {
  1: 'Betontagsten',
  2: 'Tegltagsten',
  3: 'Fibercement/asbest',
  4: 'Cementsten',
  5: 'Naturskifer',
  6: 'Fibercement (non-asbest)',
  7: 'Metalplader',
  8: 'Strå/rør',
  10: 'Tagpap m. ophæng',
  11: 'Tagpap u. ophæng',
  12: 'Glas',
  20: 'Grønt tag',
  90: 'Andet materiale',
  99: 'Ingen oplysning',
};

// ─── Ydervæggenes materiale (BYG_YDERVÆGGENES_MATERIALE) ─────────────────
const ydervaegMateriale: Record<number, string> = {
  1: 'Mursten',
  2: 'Letbeton/gasbeton',
  3: 'Fibercement/eternit (asbest)',
  4: 'Bindingsværk',
  5: 'Træ',
  6: 'Betonsten',
  7: 'Metal',
  8: 'Glas',
  10: 'Fibercement (non-asbest)',
  11: 'Ingen ydervæg',
  12: 'Letklinker',
  13: 'Plast',
  14: 'Beton',
  20: 'Kombination',
  90: 'Andet materiale',
  99: 'Ingen oplysning',
};

// ─── Varmeinstallation (BYG_VARMEINSTALLATION) ────────────────────────────
const varmeInstallation: Record<number, string> = {
  1: 'Fjernvarme / blokvarme',
  2: 'Centralvarme, 1 anlæg',
  3: 'Ovne til fast/flydende brændsel',
  4: 'Varmepumpe',
  5: 'Centralvarme, 2 anlæg',
  6: 'Biobrændselsanlæg',
  7: 'Elvarme',
  8: 'Gasradiator',
  9: 'Ingen varmeinstallation',
  10: 'Solvarme',
  99: 'Ingen oplysning',
};

// ─── Opvarmningsform (BYG_OPVARMNINGSFORM) ───────────────────────────────
const opvarmningsform: Record<number, string> = {
  1: 'Damp',
  2: 'Varmt vand',
  3: 'El',
  4: 'Luft',
  5: 'Strålevarme',
  6: 'Jordvarme',
  9: 'Ingen',
  99: 'Ingen oplysning',
};

// ─── Vandforsyning (BYG_VANDFORSYNING) ───────────────────────────────────
const vandforsyning: Record<number, string> = {
  1: 'Alment vandforsyningsanlæg',
  2: 'Privat vandforsyningsanlæg',
  3: 'Enkeltindvinding',
  4: 'Brønd',
  6: 'Ingen vandindlæg',
  7: 'Blandet vandforsyning',
  9: 'Ingen oplysning',
};

// ─── Afløbsforhold (BYG_AFLOEBSFORHOLD) ──────────────────────────────────
const afloebsforhold: Record<number, string> = {
  1: 'Afløb til kloaksystem',
  2: 'Afløb til samletank',
  3: 'Afløb til spildevandsanlæg',
  4: 'Afløb til spildevandssystem',
  5: 'Intet afløb',
  6: 'Blandet afløb',
  9: 'Ingen oplysning',
  10: 'Afløb til anden recipient',
  11: 'Afløb til havmiljø',
  20: 'Afløb til kommunal kloak',
  29: 'Ingen oplysning',
};

// ─── Supplerende varme (BYG_SUPPLERENDE_VARME) ──────────────────────────
const supplerendeVarme: Record<number, string> = {
  1: 'Varmepumpe',
  2: 'Brændeovn / pejs',
  3: 'Solpaneler / solfangere',
  4: 'Gasradiator(er)',
  5: 'Elradiator(er)',
  6: 'Biogasanlæg',
  7: 'Andet',
  99: 'Ingen oplysning',
};

// ─── Bygningsanvendelse (BYG_BYGANVENDELSE) ───────────────────────────────
const bygAnvendelse: Record<number, string> = {
  110: 'Stuehus til landbrugsejendom',
  120: 'Fritliggende enfamilieshus',
  121: 'Sammenbygget enfamilieshus',
  122: 'Dobbelthus',
  130: 'Række-, kæde- eller dobbelthus',
  131: 'Række- og kædehus',
  132: 'Dobbelthus (gammel)',
  140: 'Etagebolig til helårsbeboelse',
  150: 'Kollegium',
  160: 'Boligbyggeri til helårsbeboelse',
  185: 'Anneks i tilknytning til helårsbeboelse',
  190: 'Anden helårsbeboelse',
  210: 'Erhvervsmæssig produktion',
  211: 'Stald/lade',
  212: 'Drivhus/foliehus',
  213: 'Lade/lager',
  214: 'Ridestald',
  215: 'Maskinhus/garage til landbrug',
  216: 'Anden produktionsbygning',
  220: 'Industri og lager (udfases)',
  221: 'Bygning til industri med integreret produktionsapparat',
  222: 'Bygning til industri uden integreret produktionsapparat',
  223: 'Værksted',
  230: 'El-, gas-, vand-, varmeforsyning',
  231: 'Transformatorstation',
  232: 'Vandpumpestion',
  233: 'Varmecentral',
  234: 'Biogasanlæg',
  235: 'Vindmølle',
  236: 'El-/varmeproduktionsanlæg',
  239: 'Andet forsyningsanlæg',
  290: 'Anden industri/lager',
  310: 'Transport/garage',
  311: 'Togstation/lufthavn',
  312: 'Parkeringshus',
  313: 'Garagehus',
  314: 'Tankstation',
  315: 'Vejbygning/bro',
  319: 'Anden transportbygning',
  320: 'Kontor, handel, lager (udfases)',
  321: 'Bygning til kontor',
  322: 'Bygning til detailhandel',
  323: 'Bygning til lager',
  324: 'Butikscenter',
  325: 'Tankstation',
  329: 'Anden bygning til kontor, handel og lager',
  330: 'Hotel, restaurant, servicevirksomhed (udfases)',
  331: 'Café/restaurant',
  332: 'Hotel/vandrerhjem',
  333: 'Teater/biograf',
  334: 'Idrætshal/svømmehal',
  390: 'Anden handel/service',
  410: 'Hospital/behandling',
  411: 'Hospital',
  412: 'Specialklinik',
  413: 'Behandlingshjem',
  414: 'Plejecenter/-hjem',
  415: 'Børneinstitution',
  416: 'Skole',
  417: 'Daginstitution',
  418: 'Institution til undervisning',
  419: 'Anden institution',
  420: 'Kirke/kloster',
  430: 'Museum/teater',
  440: 'Idræt',
  490: 'Anden offentlig bygning',
  510: 'Sommerhus',
  520: 'Kolonihavehus',
  521: 'Fritidshus',
  529: 'Andet fritidshus',
  530: 'Feriehus til udlejning',
  540: 'Campinghytte',
  585: 'Anneks i tilknytning til fritidsbeboelse',
  590: 'Anden fritidsbygning',
  910: 'Garage',
  920: 'Carport',
  930: 'Udhus',
  940: 'Drivhus/orangeri',
  950: 'Tankanlæg/silo',
  960: 'Brønd/højtank',
  970: 'Svømmebassin/fontæne',
  990: 'Andet',
  999: 'Ingen oplysning',
};

// ─── BBR Status (BYG_STATUS) ──────────────────────────────────────────────
const bygStatus: Record<number, string> = {
  1: 'Projekteret bygning',
  2: 'Bygning under opførelse',
  3: 'Bygning opført',
  4: 'Nedrevet/slettet',
  5: 'Kondemneret',
  6: 'Bygning opført',
  7: 'Midlertidig opførelse',
  10: 'Bygning nedrevet',
  11: 'Bygning bortfaldet',
};

// ─── Enhedsstatus (ENH_STATUS) ────────────────────────────────────────────
const enhedStatus: Record<number, string> = {
  1: 'Til udlejning',
  2: 'Beboet af ejer',
  3: 'Ledigt',
  4: 'Til salg',
  5: 'Under opførelse',
  6: 'Under nedrivning',
  10: 'Nedrevet',
  11: 'Bortfaldet',
};

// ─── Enhedsanvendelse (ENH_ANVENDELSE) ────────────────────────────────────
const enhedAnvendelse: Record<number, string> = {
  110: 'Helårsbeboelse',
  120: 'Helårsbeboelse',
  121: 'Helårsbeboelse (ejerbolig)',
  122: 'Helårsbeboelse (udlejning)',
  130: 'Rækkehus',
  131: 'Sommerhus',
  132: 'Kollegieværelse',
  140: 'Etagelejlighed',
  150: 'Kollegium',
  160: 'Ungdomsbolig',
  185: 'Anneks',
  190: 'Anden helårsbeboelse',
  210: 'Produktion',
  220: 'Industri/lager',
  230: 'Forsyning',
  290: 'Anden industri',
  310: 'Transport/garage',
  320: 'Kontor/handel/lager/administration',
  321: 'Kontor',
  322: 'Butik',
  323: 'Engros',
  324: 'Administration',
  325: 'Hotel',
  330: 'Butik/cafe',
  390: 'Anden handel/service',
  410: 'Behandlingshjem',
  590: 'Fritidshus',
  910: 'Garage',
  920: 'Carport',
  930: 'Udhus',
  990: 'Andet',
};

/**
 * Oversætter et BBR tagkonstruktionskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function tagKonstruktionTekst(kode: number | null | undefined): string {
  return lookup(tagKonstruktion, kode);
}

/**
 * Oversætter et BBR tagmaterialekode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function tagMaterialeTekst(kode: number | null | undefined): string {
  return lookup(tagMateriale, kode);
}

/**
 * Oversætter et BBR ydervæggenes materialekode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function ydervaegMaterialeTekst(kode: number | null | undefined): string {
  return lookup(ydervaegMateriale, kode);
}

/**
 * Oversætter et BBR varmeinstallationskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function varmeInstallationTekst(kode: number | null | undefined): string {
  return lookup(varmeInstallation, kode);
}

/**
 * Oversætter et BBR opvarmningsformkode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function opvarmningsformTekst(kode: number | null | undefined): string {
  return lookup(opvarmningsform, kode);
}

/**
 * Alias for opvarmningsformTekst — bruges med det nye GraphQL-felt byg057Opvarmningsmiddel.
 * @param kode - Numerisk kode fra BBR
 */
export function opvarmningsmiddelTekst(kode: number | null | undefined): string {
  return lookup(opvarmningsform, kode);
}

/**
 * Oversætter et BBR vandforsyningskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function vandforsyningTekst(kode: number | null | undefined): string {
  return lookup(vandforsyning, kode);
}

/**
 * Oversætter et BBR afløbsforholdskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function afloebsforholdTekst(kode: number | null | undefined): string {
  return lookup(afloebsforhold, kode);
}

/**
 * Oversætter et BBR supplerende varme-kode til tekst.
 * @param kode - Numerisk kode fra BBR (byg058SupplerendeVarme)
 */
export function supplerendeVarmeTekst(kode: number | null | undefined): string {
  return lookup(supplerendeVarme, kode);
}

/**
 * Oversætter et BBR bygningsanvendelseskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function bygAnvendelseTekst(kode: number | null | undefined): string {
  return lookup(bygAnvendelse, kode);
}

/**
 * Oversætter et BBR bygningsstatuskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function bygStatusTekst(kode: number | null | undefined): string {
  return lookup(bygStatus, kode);
}

/**
 * Oversætter et BBR enhedsanvendelseskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function enhedAnvendelseTekst(kode: number | null | undefined): string {
  return lookup(enhedAnvendelse, kode);
}

/**
 * Oversætter et BBR enhedsstatuskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function enhedStatusTekst(kode: number | null | undefined): string {
  return lookup(enhedStatus, kode);
}

// ─── Toiletforhold (ENH_TOILET) ────────────────────────────────────────────
const toiletforhold: Record<number, string> = {
  1: 'Eget toilet',
  2: 'Fælles toilet',
  3: 'Ingen toilet',
  10: 'Ikke oplyst',
};

/**
 * Oversætter et BBR toiletforholdskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function toiletforholdTekst(kode: number | null | undefined): string {
  return lookup(toiletforhold, kode);
}

// ─── Badeforhold (ENH_BAD) ─────────────────────────────────────────────────
const badeforhold: Record<number, string> = {
  1: 'Eget bad',
  2: 'Fælles bad',
  3: 'Ingen bad',
  10: 'Ikke oplyst',
};

/**
 * Oversætter et BBR badeforholdskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function badeforholdTekst(kode: number | null | undefined): string {
  return lookup(badeforhold, kode);
}

// ─── Køkkenforhold (ENH_KØKKEN) ────────────────────────────────────────────
const koekkforhold: Record<number, string> = {
  1: 'Eget køkken med afløb og kogeinstallation',
  2: 'Eget køkken med afløb, uden kogeinstallation',
  3: 'Eget køkken uden afløb',
  4: 'Fælles køkken',
  5: 'Ingen køkken',
  10: 'Ikke oplyst',
};

/**
 * Oversætter et BBR køkkenforholdskode til tekst.
 * @param kode - Numerisk kode fra BBR
 */
export function koekkforholdTekst(kode: number | null | undefined): string {
  return lookup(koekkforhold, kode);
}

// ─── Boligtype (ENH_BOLIGTYPE) ──────────────────────────────────────────────
const boligtype: Record<string, string> = {
  '1': 'Egentlig beboelseslejlighed',
  '2': 'Blandet bolig og erhverv',
  '3': 'Enkeltværelse',
  '4': 'Fællesbolig',
  '5': 'Sommer-/fritidsbolig',
  E: 'Andet (erhverv/institution)',
};

/**
 * Oversætter et BBR boligtypekode til tekst.
 * @param kode - Kode fra BBR (enh023Boligtype) — streng ("1"-"5" eller "E")
 */
export function boligtypeTekst(kode: string | null | undefined): string {
  if (!kode) return '–';
  return boligtype[kode] ?? `Ukendt (${kode})`;
}

// ─── Energiforsyning (ENH_ENERGIFORSYNING) ──────────────────────────────────
const energiforsyning: Record<number, string> = {
  1: 'Gas fra værk',
  2: '230 V el fra værk',
  3: '400 V el fra værk',
  4: '230 V el + gas fra værk',
  5: '400 V el + gas fra værk',
  6: 'Hverken el eller gas',
};

/**
 * Oversætter et BBR energiforsyningskode til tekst.
 * @param kode - Numerisk kode fra BBR (enh035Energiforsyning)
 */
export function energiforsyningTekst(kode: number | null | undefined): string {
  return lookup(energiforsyning, kode);
}

// ─── Ejerforholdskode (EJF) ────────────────────────────────────────────────
const ejerforhold: Record<string, string> = {
  '10': 'Privatpersoner eller I/S',
  '20': 'A/S, ApS eller P/S',
  '30': 'Forening, legat eller selvejende institution',
  '40': 'Offentlig myndighed',
  '41': 'Staten',
  '50': 'Andelsboligforening',
  '60': 'Almennyttigt boligselskab',
  '70': 'Fond',
  '80': 'Andet',
  '90': 'Ikke oplyst',
};

/**
 * Oversætter en ejerforholdskode fra Datafordeler til tekst.
 * @param kode - Ejerforholdskode streng (f.eks. "10", "20")
 */
export function ejerforholdTekst(kode: string | null | undefined): string {
  if (!kode) return '–';
  return ejerforhold[kode] ?? `Ukendt (${kode})`;
}
