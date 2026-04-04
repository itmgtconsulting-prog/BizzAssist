/**
 * GET /api/cvr-public?vat=XXXXXXXX
 * GET /api/cvr-public?name=Virksomhedsnavn
 *
 * Server-side proxy til Erhvervsstyrelsens CVR ElasticSearch.
 * Returnerer udvidet virksomhedsdata inkl. ejere og produktionsenheder.
 * Understøtter både CVR-nummer (vat) og navnesøgning (name).
 *
 * Primær kilde: Erhvervsstyrelsen ES (http://distribution.virk.dk)
 * Kræver CVR_ES_USER + CVR_ES_PASS i .env.local
 *
 * @param vat - 8-cifret dansk CVR-nummer (query param), eller
 * @param name - Virksomhedsnavn at søge efter (query param)
 * @returns CVRPublicData objekt eller { error: string }
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Udvidet virksomhedsdata — kompatibelt med det eksisterende interface */
export interface CVRPublicData {
  vat: number;
  name: string;
  address: string;
  zipcode: string;
  city: string;
  phone: string | null;
  email: string | null;
  industrycode: number | null;
  industrydesc: string | null;
  companycode: number | null;
  companydesc: string | null;
  startdate: string | null;
  enddate: string | null;
  employees: string | null;
  addressco: string | null;
  creditstartdate: string | null;
  creditstatus: string | null;
  owners: Array<{ name: string }> | null;
  productionunits: Array<{
    pno: number;
    main: boolean;
    name: string;
    address: string;
    zipcode: string;
    city: string;
    industrydesc: string | null;
    /** Telefonnummer for produktionsenheden */
    phone: string | null;
    /** Email for produktionsenheden */
    email: string | null;
    /** Om produktionsenheden er aktiv (ikke ophørt) */
    active: boolean;
  }> | null;

  /** Virksomhedens formål/vedtægtsmæssige formål (fra Vrvirksomhed.formaal) */
  formaal: string | null;

  /** Registreret selskabskapital med beløb og valuta (fra Vrvirksomhed.virksomhedMetadata.nyesteKapital) */
  registreretKapital: { vaerdi: number; valuta: string } | null;

  /** Stiftelsesdato i ISO-format (fra Vrvirksomhed.stiftelsesDato) */
  stiftet: string | null;

  /** Tidspunkt for seneste opdatering i CVR (fra Vrvirksomhed.sidstOpdateret) */
  sidstOpdateret: string | null;

  /** Om virksomheden er reklamebeskyttet (fra Vrvirksomhed.reklamebeskyttet) */
  reklamebeskyttet: boolean;

  /** Kommune fra beliggenhedsadresse (fra Vrvirksomhed.beliggenhedsadresse[].kommune) */
  kommune: string | null;

  /** Statustekst (Normal, Ophørt, Under konkurs etc.) fra virksomhedsstatus */
  statusTekst: string | null;

  /** Første regnskabsperiode (start–slut) fra virksomhedMetadata */
  foersteRegnskabsperiode: { start: string; slut: string } | null;

  /** Regnskabsår start/slut måneder (fra virksomhedMetadata) */
  regnskabsaar: {
    startMaaned: number;
    startDag: number;
    slutMaaned: number;
    slutDag: number;
  } | null;

  /** Seneste vedtægtsdato i ISO-format */
  senesteVedtaegtsdato: string | null;

  /** Tegningsregel — hvem der tegner selskabet */
  tegningsregel: string | null;

  /**
   * Historiske ændringer fra tidsbestemte arrays (navne, adresse, form, status, branche).
   * Indeholder ALLE perioder — ikke kun gyldigNu.
   */
  historik: Array<{
    /** Ændringstype: 'navn' | 'adresse' | 'form' | 'status' | 'branche' */
    type: string;
    /** Startdato for perioden (ISO) */
    fra: string;
    /** Slutdato for perioden (ISO), null hvis stadig gældende */
    til: string | null;
    /** Værdien i den pågældende periode */
    vaerdi: string;
  }>;

  /**
   * Deltagere (ejere, bestyrelsesmedlemmer m.fl.) med detaljerede rolleoplysninger.
   * Udtrukket fra Vrvirksomhed.deltagerRelation med perioder, ejerskabsandele mv.
   */
  deltagere: Array<{
    /** Deltagerens navn */
    navn: string;
    /** Deltagerens enhedsnummer (personnummer erstattes ikke — kun enhedsnummer fra CVR) */
    enhedsNummer: number | null;
    /** Om deltageren er en virksomhed (true) eller person (false) */
    erVirksomhed: boolean;
    /** Detaljerede roller med perioder og attributter */
    roller: Array<{
      /** Rollenavn (f.eks. DIREKTION, BESTYRELSE, STIFTER, REVISION, EJER) */
      rolle: string;
      /** Startdato for rollen (ISO) */
      fra: string | null;
      /** Slutdato for rollen (ISO), null = stadig aktiv */
      til: string | null;
      /** Ejerskabsandel som læsbar interval-streng (f.eks. "90-100%"), null hvis ikke relevant */
      ejerandel: string | null;
      /** Stemmeret som læsbar interval-streng (f.eks. "90-100%"), null hvis ikke relevant */
      stemmeandel: string | null;
      /** Særlige bemærkninger (f.eks. kapitalklasse) */
      bemærkning: string | null;
    }>;
  }>;
}

/** Fejl-response shape */
export interface CVRPublicError {
  error: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

// ─── ES Helpers ──────────────────────────────────────────────────────────────

type Periodic = { periode?: { gyldigFra?: string | null; gyldigTil?: string | null } };

/** Interval-koder fra CVR ES → læsbar streng */
const intervalKodeMap: Record<string, string> = {
  ANTAL_0_0: '0',
  ANTAL_1_1: '1',
  ANTAL_2_4: '2-4',
  ANTAL_5_9: '5-9',
  ANTAL_10_19: '10-19',
  ANTAL_20_49: '20-49',
  ANTAL_50_99: '50-99',
  ANTAL_100_199: '100-199',
  ANTAL_200_499: '200-499',
  ANTAL_500_999: '500-999',
  ANTAL_1000_999999: '1.000+',
};

/**
 * Mapper CVR ejerandel/stemmeret-decimal til læsbar interval-streng.
 * CVR ES bruger faste intervaller: 0.05 → 5-9.99%, 0.9 → 90-100% osv.
 *
 * @param val - Decimal-værdi fra EJERANDEL_PROCENT/EJERANDEL_STEMMERET_PROCENT
 */
function mapEjerandelInterval(val: number): string {
  if (val >= 0.9) return '90-100%';
  if (val >= 0.6667) return '66.67-89.99%';
  if (val >= 0.5) return '50-66.66%';
  if (val >= 0.3334) return '33.34-49.99%';
  if (val >= 0.25) return '25-33.33%';
  if (val >= 0.2) return '20-24.99%';
  if (val >= 0.15) return '15-19.99%';
  if (val >= 0.1) return '10-14.99%';
  if (val >= 0.05) return '5-9.99%';
  return `${(val * 100).toFixed(1)}%`;
}

/**
 * Mapper CVR interval-kode til læsbar streng.
 *
 * @param kode - Interval-kode fra ES, f.eks. "ANTAL_1000_999999"
 */
function mapIntervalKode(kode: string | null | undefined): string | null {
  if (!kode) return null;
  return intervalKodeMap[kode] ?? kode.replace('ANTAL_', '').replace('_', '-');
}

/**
 * Finder den gældende (åbne) periode i et array af tidsbestemte CVR-objekter.
 *
 * @param arr - Array med tidsbestemte objekter fra CVR ElasticSearch
 */
function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Mapper et råt ES-hit til CVRPublicData.
 *
 * @param hit - Rå ES-hit med _source.Vrvirksomhed
 */
function mapESHit(hit: Record<string, unknown>): CVRPublicData | null {
  const src = (hit._source as Record<string, unknown> | undefined)?.Vrvirksomhed as
    | Record<string, unknown>
    | undefined;
  if (!src) return null;

  const cvr = typeof src.cvrNummer === 'number' ? src.cvrNummer : null;
  if (!cvr) return null;

  // ── Navn ──
  const navne = Array.isArray(src.navne) ? (src.navne as (Periodic & { navn?: string })[]) : [];
  const navn = gyldigNu(navne)?.navn ?? '';

  // ── Adresse ──
  const adresser = Array.isArray(src.beliggenhedsadresse)
    ? (src.beliggenhedsadresse as (Periodic & Record<string, unknown>)[])
    : [];
  const adr = gyldigNu(adresser);
  const vejnavn = typeof adr?.vejnavn === 'string' ? adr.vejnavn : '';
  const husnummerFra = typeof adr?.husnummerFra === 'number' ? String(adr.husnummerFra) : '';
  const bogstavFra = typeof adr?.bogstavFra === 'string' ? adr.bogstavFra : '';
  const etage = typeof adr?.etage === 'string' ? adr.etage : '';
  const sidedoer = typeof adr?.sidedoer === 'string' ? adr.sidedoer : '';
  const postnr = typeof adr?.postnummer === 'number' ? String(adr.postnummer) : '';
  const by = typeof adr?.postdistrikt === 'string' ? adr.postdistrikt : '';
  const coNavn = typeof adr?.coNavn === 'string' ? adr.coNavn : null;

  let adresseStreng = `${vejnavn} ${husnummerFra}${bogstavFra}`.trim();
  if (etage) adresseStreng += `, ${etage}.`;
  if (sidedoer) adresseStreng += ` ${sidedoer}`;

  // ── Telefon ──
  const telefoner = Array.isArray(src.telefonnummer)
    ? (src.telefonnummer as (Periodic & { kontaktoplysning?: string })[])
    : [];
  const telefon = gyldigNu(telefoner)?.kontaktoplysning ?? null;

  // ── Email ──
  const emails = Array.isArray(src.emailadresse)
    ? (src.emailadresse as (Periodic & { kontaktoplysning?: string })[])
    : [];
  const email = gyldigNu(emails)?.kontaktoplysning ?? null;

  // ── Branche ──
  const brancher = Array.isArray(src.hovedbranche)
    ? (src.hovedbranche as (Periodic & { branchekode?: string | number; branchetekst?: string })[])
    : [];
  const brancheNu = gyldigNu(brancher);
  const branchekode =
    brancheNu?.branchekode != null
      ? typeof brancheNu.branchekode === 'number'
        ? brancheNu.branchekode
        : parseInt(String(brancheNu.branchekode), 10)
      : null;
  const branche = typeof brancheNu?.branchetekst === 'string' ? brancheNu.branchetekst : null;

  // ── Virksomhedsform ──
  const former = Array.isArray(src.virksomhedsform)
    ? (src.virksomhedsform as (Periodic & {
        kortBeskrivelse?: string;
        langBeskrivelse?: string;
        virksomhedsformkode?: number;
      })[])
    : [];
  const formNu = gyldigNu(former);
  const companydesc = formNu?.langBeskrivelse ?? formNu?.kortBeskrivelse ?? null;
  const companycode =
    typeof formNu?.virksomhedsformkode === 'number' ? formNu.virksomhedsformkode : null;

  // ── Status (felt hedder "status" ikke "statuskode" i ES) ──
  const statusser = Array.isArray(src.virksomhedsstatus)
    ? (src.virksomhedsstatus as (Periodic & { status?: string; statuskode?: string })[])
    : [];
  const aktuelStatus = gyldigNu(statusser);
  const rawStatus = aktuelStatus?.status ?? aktuelStatus?.statuskode ?? null;
  const aktiv = rawStatus === 'NORMAL' || rawStatus === 'AKTIV';

  // ── Start/slut-dato ──
  const livsforloeb = Array.isArray(src.livsforloeb)
    ? (src.livsforloeb as (Periodic & Record<string, unknown>)[])
    : [];
  const forloeb = gyldigNu(livsforloeb);
  const startdate = forloeb?.periode?.gyldigFra ? formatDate(forloeb.periode.gyldigFra) : null;
  const enddate = aktiv
    ? null
    : forloeb?.periode?.gyldigTil
      ? formatDate(forloeb.periode.gyldigTil)
      : null;

  // ── Ansatte (seneste kvartal → metadata fallback) ──
  const kvartal = Array.isArray(src.kvartalsbeskaeftigelse)
    ? (src.kvartalsbeskaeftigelse as (Periodic & {
        antalAnsatte?: number;
        intervalKodeAntalAnsatte?: string;
      })[])
    : [];
  const senestKvartal = kvartal.length > 0 ? kvartal[kvartal.length - 1] : null;
  const employeesFromKvartal =
    senestKvartal?.antalAnsatte != null
      ? String(senestKvartal.antalAnsatte)
      : mapIntervalKode(senestKvartal?.intervalKodeAntalAnsatte);
  // Fallback: nyesteErstMaanedsbeskaeftigelse fra virksomhedMetadata
  const metaTemp = src.virksomhedMetadata as Record<string, unknown> | undefined;
  const maanedsBeskæf = metaTemp?.nyesteErstMaanedsbeskaeftigelse as
    | Record<string, unknown>
    | undefined;
  const employeesFromMeta =
    maanedsBeskæf?.antalAnsatte != null
      ? String(maanedsBeskæf.antalAnsatte)
      : mapIntervalKode(maanedsBeskæf?.intervalKodeAntalAnsatte as string | undefined);
  const employees = employeesFromKvartal ?? employeesFromMeta;

  // ── Formål ──
  const formaalArr = Array.isArray(src.formaal)
    ? (src.formaal as (Periodic & { formaal?: string })[])
    : [];
  const formaalFromArr = gyldigNu(formaalArr)?.formaal ?? null;

  // ── Registreret kapital (fra virksomhedMetadata.nyesteKapital) ──
  const metadata = src.virksomhedMetadata as Record<string, unknown> | undefined;
  const nyesteKapital = metadata?.nyesteKapital as Record<string, unknown> | undefined;
  const registreretKapitalMeta =
    nyesteKapital &&
    typeof nyesteKapital.vaerdi === 'number' &&
    typeof nyesteKapital.valuta === 'string'
      ? { vaerdi: nyesteKapital.vaerdi, valuta: nyesteKapital.valuta }
      : null;

  // ── Stiftelsesdato ──
  const stiftet =
    typeof src.stiftelsesDato === 'string'
      ? src.stiftelsesDato
      : typeof metadata?.stiftelsesDato === 'string'
        ? (metadata.stiftelsesDato as string)
        : null;

  // ── Sidst opdateret ──
  const sidstOpdateret = typeof src.sidstOpdateret === 'string' ? src.sidstOpdateret : null;

  // ── Reklamebeskyttet ──
  const reklamebeskyttet = src.reklamebeskyttet === true;

  // ── Kommune (fra beliggenhedsadresse) ──
  const kommuneObj = adr?.kommune as Record<string, unknown> | undefined;
  const kommune = typeof kommuneObj?.kommuneNavn === 'string' ? kommuneObj.kommuneNavn : null;

  // ── Status tekst (feltet hedder "status" i ES, værdier: NORMAL, OPHOERT etc.) ──
  const rawStatusVal = rawStatus ?? (metadata?.sammensatStatus as string | undefined) ?? null;
  const statusDisplayMap: Record<string, string> = {
    NORMAL: 'Normal',
    OPHOERT: 'Ophørt',
    UNDER_KONKURS: 'Under konkurs',
    UNDER_FRIVILLIG_LIKVIDATION: 'Under frivillig likvidation',
    UNDER_TVANGSOPLØSNING: 'Under tvangsopløsning',
    UNDER_REKONSTRUKTION: 'Under rekonstruktion',
    AKTIV: 'Normal',
  };
  const statusTekst = rawStatusVal ? (statusDisplayMap[rawStatusVal] ?? rawStatusVal) : null;

  // ── Attributter (kapital, regnskab, vedtægt, tegningsregel, formål etc.) ──
  const attributter = Array.isArray(src.attributter)
    ? (src.attributter as Record<string, unknown>[])
    : [];

  /** Hjælper: hent gyldig værdi fra en attribut */
  function getAttrValue(attrType: string): string | null {
    for (const attr of attributter) {
      if (attr.type !== attrType) continue;
      const vaerdier = Array.isArray(attr.vaerdier)
        ? (attr.vaerdier as (Periodic & { vaerdi?: string })[])
        : [];
      const current = gyldigNu(vaerdier);
      return current?.vaerdi ?? null;
    }
    return null;
  }

  const tegningsregel = getAttrValue('TEGNINGSREGEL');
  const senesteVedtaegtsdato = getAttrValue('VEDTÆGT_SENESTE');

  // ── Registreret kapital (fra attributter KAPITAL + KAPITALVALUTA) ──
  const kapitalStr = getAttrValue('KAPITAL');
  const kapitalValuta = getAttrValue('KAPITALVALUTA');
  const registreretKapitalAttr =
    kapitalStr != null ? { vaerdi: parseFloat(kapitalStr), valuta: kapitalValuta ?? 'DKK' } : null;

  // ── Første regnskabsperiode (fra attributter) ──
  const foersteStart = getAttrValue('FØRSTE_REGNSKABSPERIODE_START');
  const foersteSlut = getAttrValue('FØRSTE_REGNSKABSPERIODE_SLUT');
  const foersteRegnskabsperiode =
    foersteStart && foersteSlut ? { start: foersteStart, slut: foersteSlut } : null;

  // ── Regnskabsår (fra attributter) ──
  const regStartStr = getAttrValue('REGNSKABSÅR_START');
  const regSlutStr = getAttrValue('REGNSKABSÅR_SLUT');
  const regnskabsaar =
    regStartStr && regSlutStr
      ? (() => {
          // Format: "--MM-DD" (gMonthDay) e.g. "--01-01" = 1. jan, "--12-31" = 31. dec
          const startMatch = regStartStr.match(/--?(\d{1,2})-(\d{1,2})/);
          const slutMatch = regSlutStr.match(/--?(\d{1,2})-(\d{1,2})/);
          if (!startMatch || !slutMatch) return null;
          return {
            startMaaned: parseInt(startMatch[1], 10),
            startDag: parseInt(startMatch[2], 10),
            slutMaaned: parseInt(slutMatch[1], 10),
            slutDag: parseInt(slutMatch[2], 10),
          };
        })()
      : null;

  // ── Formål (fra attributter hvis ikke i formaal-array) ──
  const formaalFraAttr = getAttrValue('FORMÅL');

  // ── Historik (alle perioder fra tidsbestemte arrays) ──
  const historik: Array<{ type: string; fra: string; til: string | null; vaerdi: string }> = [];

  // Navne-historik
  for (const entry of navne) {
    const val = (entry as Periodic & { navn?: string }).navn;
    if (val) {
      historik.push({
        type: 'navn',
        fra: entry.periode?.gyldigFra ?? '',
        til: entry.periode?.gyldigTil ?? null,
        vaerdi: val,
      });
    }
  }

  // Adresse-historik
  for (const entry of adresser) {
    const v = entry as Periodic & Record<string, unknown>;
    const vej = typeof v.vejnavn === 'string' ? v.vejnavn : '';
    const hus = typeof v.husnummerFra === 'number' ? String(v.husnummerFra) : '';
    const bog = typeof v.bogstavFra === 'string' ? v.bogstavFra : '';
    const pnr = typeof v.postnummer === 'number' ? String(v.postnummer) : '';
    const bd = typeof v.postdistrikt === 'string' ? v.postdistrikt : '';
    const adrStr = `${vej} ${hus}${bog}, ${pnr} ${bd}`.trim().replace(/^,\s*/, '');
    if (adrStr) {
      historik.push({
        type: 'adresse',
        fra: entry.periode?.gyldigFra ?? '',
        til: entry.periode?.gyldigTil ?? null,
        vaerdi: adrStr,
      });
    }
  }

  // Virksomhedsform-historik
  for (const entry of former) {
    const val = entry.langBeskrivelse ?? entry.kortBeskrivelse;
    if (val) {
      historik.push({
        type: 'form',
        fra: entry.periode?.gyldigFra ?? '',
        til: entry.periode?.gyldigTil ?? null,
        vaerdi: val,
      });
    }
  }

  // Status-historik
  for (const entry of statusser) {
    const val =
      (entry as Periodic & { status?: string; statuskode?: string }).status ??
      (entry as Periodic & { status?: string; statuskode?: string }).statuskode;
    if (val) {
      historik.push({
        type: 'status',
        fra: entry.periode?.gyldigFra ?? '',
        til: entry.periode?.gyldigTil ?? null,
        vaerdi: val,
      });
    }
  }

  // Branche-historik
  for (const entry of brancher) {
    const val = entry.branchetekst;
    if (val) {
      historik.push({
        type: 'branche',
        fra: entry.periode?.gyldigFra ?? '',
        til: entry.periode?.gyldigTil ?? null,
        vaerdi: val,
      });
    }
  }

  // ── Ejere / Deltagere (deltagerRelation) ──
  const relationer = Array.isArray(src.deltagerRelation)
    ? (src.deltagerRelation as Record<string, unknown>[])
    : [];
  const owners: { name: string }[] = [];

  /** Deltagere med detaljerede roller, perioder og ejerskabsandele */
  const deltagere: CVRPublicData['deltagere'] = [];

  for (const rel of relationer) {
    const deltager = rel.deltager as Record<string, unknown> | undefined;
    if (!deltager) continue;
    const dnavne = Array.isArray(deltager.navne)
      ? (deltager.navne as (Periodic & { navn?: string })[])
      : [];
    const dNavn = gyldigNu(dnavne)?.navn;

    const enhedsNummer = typeof deltager.enhedsNummer === 'number' ? deltager.enhedsNummer : null;
    // Afgør om deltageren er en virksomhed: check enhedstype, og fallback til navnemønster
    const enhedstype = typeof deltager.enhedstype === 'string' ? deltager.enhedstype : '';
    const erVirksomhed =
      enhedstype !== ''
        ? enhedstype !== 'PERSON'
        : // Fallback heuristik: typiske virksomhedsnavne-suffikser
          dNavn != null &&
          /\b(a\/s|aps|as|a\.s\.|i\/s|k\/s|p\/s|s\.m\.b\.a|holding|invest|fond|fonden|amba|forening|komplementar|ivs|se)\b/i.test(
            dNavn
          );

    // Udtræk roller fra organisationer med perioder og attributter
    const organisationer = Array.isArray(rel.organisationer)
      ? (rel.organisationer as Record<string, unknown>[])
      : [];
    const rollerMedPerioder: CVRPublicData['deltagere'][0]['roller'] = [];

    for (const org of organisationer) {
      // Rollenavn — alle perioder (ikke kun gyldigNu)
      const orgNavne = Array.isArray(org.organisationsNavn)
        ? (org.organisationsNavn as (Periodic & { navn?: string })[])
        : [];

      // Medlemsdata indeholder attributter (ejerandel, stemmeret etc.)
      const medlemsData = Array.isArray(org.medlemsData)
        ? (org.medlemsData as Record<string, unknown>[])
        : [];

      // Udtræk attributter og afgør om rollen er aktiv via vaerdier-perioder.
      //
      // CVR ES: organisationsNavn.gyldigTil er UPÅLIDELIG — ofte null selv for ophørte
      // roller. Den korrekte kilde er vaerdier-perioderne i medlemsData.attributter.
      // Gælder for ALLE rolletyper: EJERREGISTER (EJERANDEL_PROCENT), Direktion (FUNKTION),
      // Bestyrelse (FUNKTION), Revision, Stifter etc.
      let ejerandel: string | null = null;
      let stemmeandel: string | null = null;
      let bemærkning: string | null = null;
      /** Om mindst én vaerdi-periode er åben (gyldigTil == null) → rollen er aktiv */
      let vaerdiAktiv = false;
      /** Tidligste startdato fra vaerdier */
      let vaerdiFra: string | null = null;
      /** Seneste slutdato fra vaerdier (for historiske) */
      let vaerdiTil: string | null = null;
      /** Om der overhovedet var vaerdier at tjekke */
      let harVaerdier = false;

      for (const md of medlemsData) {
        const attributter = Array.isArray(md.attributter)
          ? (md.attributter as Record<string, unknown>[])
          : [];
        for (const attr of attributter) {
          const attrType = typeof attr.type === 'string' ? attr.type : '';
          const vaerdier = Array.isArray(attr.vaerdier)
            ? (attr.vaerdier as (Periodic & { vaerdi?: string | number })[])
            : [];
          if (vaerdier.length === 0) continue;
          const gyldig = gyldigNu(vaerdier);

          // Track åbne/lukkede perioder for ALLE attributtyper
          harVaerdier = true;
          if (vaerdier.some((v) => v.periode?.gyldigTil == null)) vaerdiAktiv = true;
          for (const v of vaerdier) {
            if (v.periode?.gyldigFra && (!vaerdiFra || v.periode.gyldigFra < vaerdiFra)) {
              vaerdiFra = v.periode.gyldigFra;
            }
            if (v.periode?.gyldigTil && (!vaerdiTil || v.periode.gyldigTil > vaerdiTil)) {
              vaerdiTil = v.periode.gyldigTil;
            }
          }

          // Ejerandels-specifikke attributter
          if (attrType === 'EJERANDEL_PROCENT' && gyldig?.vaerdi != null) {
            const raw =
              typeof gyldig.vaerdi === 'number' ? gyldig.vaerdi : parseFloat(String(gyldig.vaerdi));
            ejerandel = isNaN(raw) ? null : mapEjerandelInterval(raw);
          } else if (attrType === 'EJERANDEL_STEMMERET_PROCENT' && gyldig?.vaerdi != null) {
            const raw =
              typeof gyldig.vaerdi === 'number' ? gyldig.vaerdi : parseFloat(String(gyldig.vaerdi));
            stemmeandel = isNaN(raw) ? null : mapEjerandelInterval(raw);
          } else if (attrType === 'KAPITALKLASSE' && gyldig?.vaerdi != null) {
            bemærkning = String(gyldig.vaerdi);
          }
        }
      }

      // Udpak alle rollenavne med perioder.
      // Brug vaerdier-perioderne til at afgøre aktiv/historisk (mere pålidelig end orgNavn.gyldigTil).
      // Hvis ingen vaerdier fandtes → fald tilbage til organisationsNavn-perioden.
      for (const orgNavn of orgNavne) {
        const rolle = orgNavn.navn;
        if (!rolle) continue;
        const effektivFra =
          harVaerdier && vaerdiFra ? vaerdiFra : (orgNavn.periode?.gyldigFra ?? null);
        const effektivTil = harVaerdier
          ? vaerdiAktiv
            ? null
            : vaerdiTil
          : (orgNavn.periode?.gyldigTil ?? null);
        rollerMedPerioder.push({
          rolle,
          fra: effektivFra,
          til: effektivTil,
          ejerandel,
          stemmeandel,
          bemærkning,
        });
      }
    }

    if (dNavn) {
      deltagere.push({ navn: dNavn, enhedsNummer, erVirksomhed, roller: rollerMedPerioder });
    }
  }

  // Byg owners fra deltagere med aktive ejerroller (EJERREGISTER med til == null)
  for (const d of deltagere) {
    const harAktivEjerRolle = d.roller.some((r) => {
      const upper = r.rolle.toUpperCase();
      return (
        (upper.includes('EJER') ||
          upper.includes('LEGALE') ||
          upper.includes('REEL') ||
          upper.includes('INTERESSENT') ||
          upper.includes('FULDT_ANSVARLIG')) &&
        r.til === null
      );
    });
    if (harAktivEjerRolle) {
      owners.push({ name: d.navn });
    }
  }

  // ── Produktionsenheder (stub — erstattes af separat PE-fetch i route handler) ──
  const productionunits: CVRPublicData['productionunits'] = null;

  return {
    vat: cvr,
    name: navn,
    address: adresseStreng,
    zipcode: postnr,
    city: by,
    phone: telefon,
    email,
    industrycode: branchekode,
    industrydesc: branche,
    companycode,
    companydesc,
    startdate,
    enddate,
    employees,
    addressco: coNavn,
    creditstartdate: null,
    creditstatus: null,
    owners: owners.length > 0 ? owners : null,
    productionunits,
    formaal: formaalFromArr ?? formaalFraAttr,
    registreretKapital: registreretKapitalMeta ?? registreretKapitalAttr,
    stiftet,
    sidstOpdateret,
    reklamebeskyttet,
    kommune,
    statusTekst,
    foersteRegnskabsperiode,
    regnskabsaar,
    senesteVedtaegtsdato,
    tegningsregel,
    historik,
    deltagere,
  };
}

/**
 * Formaterer en ISO-dato til "dd/mm - yyyy" (cvrapi.dk-kompatibelt format).
 *
 * @param isoDate - ISO-dato streng
 */
function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm} - ${d.getFullYear()}`;
}

/**
 * Henter produktionsenheder fra det separate produktionsenhed-index i CVR ES.
 * Returnerer fulde PE-data med navn, adresse, branche, ansatte etc.
 *
 * @param cvr - CVR-nummer for virksomheden
 * @param auth - Base64-encoded credentials
 */
async function fetchProduktionsenheder(
  cvr: number,
  auth: string
): Promise<CVRPublicData['productionunits']> {
  try {
    const peQuery = {
      query: {
        nested: {
          path: 'VrproduktionsEnhed.virksomhedsrelation',
          query: {
            bool: {
              must: [{ term: { 'VrproduktionsEnhed.virksomhedsrelation.cvrNummer': cvr } }],
              must_not: [
                { exists: { field: 'VrproduktionsEnhed.virksomhedsrelation.periode.gyldigTil' } },
              ],
            },
          },
        },
      },
      _source: [
        'VrproduktionsEnhed.pNummer',
        'VrproduktionsEnhed.navne',
        'VrproduktionsEnhed.beliggenhedsadresse',
        'VrproduktionsEnhed.hovedbranche',
        'VrproduktionsEnhed.produktionsEnhedMetadata',
        'VrproduktionsEnhed.telefonNummer',
        'VrproduktionsEnhed.elektroniskPost',
      ],
      size: 100,
    };

    const res = await fetch(`${CVR_ES_BASE}/produktionsenhed/_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(peQuery),
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 3600 },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
    };

    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) return null;

    return hits
      .map((hit) => {
        const pe = (hit._source as Record<string, unknown> | undefined)?.VrproduktionsEnhed as
          | Record<string, unknown>
          | undefined;
        if (!pe) return null;

        const pno = typeof pe.pNummer === 'number' ? pe.pNummer : 0;

        // Navn
        const peNavne = Array.isArray(pe.navne)
          ? (pe.navne as (Periodic & { navn?: string })[])
          : [];
        const peName = gyldigNu(peNavne)?.navn ?? '';

        // Adresse
        const peAdresser = Array.isArray(pe.beliggenhedsadresse)
          ? (pe.beliggenhedsadresse as (Periodic & Record<string, unknown>)[])
          : [];
        const peAdr = gyldigNu(peAdresser);
        const peVej = typeof peAdr?.vejnavn === 'string' ? peAdr.vejnavn : '';
        const peHus = typeof peAdr?.husnummerFra === 'number' ? String(peAdr.husnummerFra) : '';
        const peBog = typeof peAdr?.bogstavFra === 'string' ? peAdr.bogstavFra : '';
        const pePost = typeof peAdr?.postnummer === 'number' ? String(peAdr.postnummer) : '';
        const peBy = typeof peAdr?.postdistrikt === 'string' ? peAdr.postdistrikt : '';

        // Branche
        const peBrancher = Array.isArray(pe.hovedbranche)
          ? (pe.hovedbranche as (Periodic & { branchetekst?: string })[])
          : [];
        const peBranche = gyldigNu(peBrancher)?.branchetekst ?? null;

        // Metadata — sammensatStatus + hovedafdeling
        const peMeta = pe.produktionsEnhedMetadata as Record<string, unknown> | undefined;
        const peStatus =
          typeof peMeta?.sammensatStatus === 'string' ? peMeta.sammensatStatus : null;
        const peAktiv = peStatus !== 'Ophørt';

        // Telefon
        const peTelefoner = Array.isArray(pe.telefonNummer)
          ? (pe.telefonNummer as (Periodic & { kontaktoplysning?: string })[])
          : [];
        const peTlf = gyldigNu(peTelefoner)?.kontaktoplysning ?? null;

        // Email
        const peEmails = Array.isArray(pe.elektroniskPost)
          ? (pe.elektroniskPost as (Periodic & { kontaktoplysning?: string })[])
          : [];
        const peEmail = gyldigNu(peEmails)?.kontaktoplysning ?? null;

        return {
          pno,
          main: false,
          name: peName,
          address: `${peVej} ${peHus}${peBog}`.trim(),
          zipcode: pePost,
          city: peBy,
          industrydesc: peBranche,
          phone: peTlf,
          email: peEmail,
          active: peAktiv,
        };
      })
      .filter((pe): pe is NonNullable<typeof pe> => pe !== null);
  } catch (err) {
    console.error('[cvr-public] PE fetch error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * Henter virksomhedsdata fra Erhvervsstyrelsens CVR ES via CVR-nummer eller navn.
 *
 * @param req - Next.js request med ?vat= eller ?name= query param
 * @returns CVRPublicData eller fejlbesked
 */
export async function GET(req: NextRequest): Promise<NextResponse<CVRPublicData | CVRPublicError>> {
  const vat = req.nextUrl.searchParams.get('vat') ?? '';
  const name = req.nextUrl.searchParams.get('name') ?? '';
  const enhedsNr = req.nextUrl.searchParams.get('enhedsNummer') ?? '';

  if (!vat && !name && !enhedsNr) {
    return NextResponse.json(
      { error: 'Angiv enten ?vat=, ?name= eller ?enhedsNummer= parameter' },
      { status: 400 }
    );
  }

  if (vat && !/^\d{8}$/.test(vat)) {
    return NextResponse.json({ error: 'Ugyldigt CVR-nummer — skal være 8 cifre' }, { status: 400 });
  }

  if (enhedsNr && !/^\d+$/.test(enhedsNr)) {
    return NextResponse.json(
      { error: 'Ugyldigt enhedsNummer — skal være numerisk' },
      { status: 400 }
    );
  }

  if (!vat && !enhedsNr && name.trim().length < 2) {
    return NextResponse.json({ error: 'Navn skal være mindst 2 tegn' }, { status: 400 });
  }

  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ error: 'CVR-adgang ikke konfigureret' }, { status: 503 });
  }

  // Build ES query
  const esQuery =
    vat || enhedsNr
      ? {
          query: {
            bool: {
              must: [
                vat
                  ? { term: { 'Vrvirksomhed.cvrNummer': vat } }
                  : { term: { 'Vrvirksomhed.enhedsNummer': enhedsNr } },
              ],
            },
          },
          size: 1,
        }
      : {
          query: {
            nested: {
              path: 'Vrvirksomhed.navne',
              query: {
                bool: {
                  should: [
                    /* Eksakt phrase match — højest score */
                    {
                      match_phrase: { 'Vrvirksomhed.navne.navn': { query: name.trim(), boost: 5 } },
                    },
                    /* Prefix-match — fanger "cerama" → "Cerama A/S" */
                    {
                      match_phrase_prefix: {
                        'Vrvirksomhed.navne.navn': { query: name.trim(), boost: 4 },
                      },
                    },
                    /* Standard match med alle ord */
                    {
                      match: {
                        'Vrvirksomhed.navne.navn': {
                          query: name.trim(),
                          operator: 'and',
                          boost: 3,
                        },
                      },
                    },
                    /* Fuzzy match — fanger stavefejl */
                    {
                      match: {
                        'Vrvirksomhed.navne.navn': {
                          query: name.trim(),
                          fuzziness: 'AUTO',
                          operator: 'or',
                          boost: 1,
                        },
                      },
                    },
                  ],
                  minimum_should_match: 1,
                },
              },
            },
          },
          size: 10,
        };

  const cacheTime = vat || enhedsNr ? 3600 : 300;

  try {
    const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

    const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(10000),
      next: { revalidate: cacheTime },
    });

    if (!res.ok) {
      console.error('[cvr-public] ES returned', res.status);
      return NextResponse.json(
        { error: `CVR-opslag fejlede (HTTP ${res.status})` },
        { status: 502 }
      );
    }

    const data = (await res.json()) as {
      hits?: { total?: number; hits?: Record<string, unknown>[] };
    };

    const hits = data.hits?.hits ?? [];

    if (hits.length === 0) {
      return NextResponse.json({ error: 'Virksomhed ikke fundet' }, { status: 404 });
    }

    // For vat-lookup, return single result
    if (vat) {
      const mapped = mapESHit(hits[0]);
      if (!mapped) {
        return NextResponse.json({ error: 'Kunne ikke parse virksomhedsdata' }, { status: 500 });
      }

      // Hent fulde produktionsenheder fra separat PE-index
      mapped.productionunits = await fetchProduktionsenheder(mapped.vat, auth);

      return NextResponse.json(mapped, {
        headers: { 'Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=600` },
      });
    }

    // For name search, return first match (company page expects single result)
    // But if called from search, the caller handles the first hit
    const mapped = mapESHit(hits[0]);
    if (!mapped) {
      return NextResponse.json({ error: 'Kunne ikke parse virksomhedsdata' }, { status: 500 });
    }

    // Hent fulde produktionsenheder fra separat PE-index
    mapped.productionunits = await fetchProduktionsenheder(mapped.vat, auth);

    return NextResponse.json(mapped, {
      headers: { 'Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=600` },
    });
  } catch (err) {
    console.error('[cvr-public] Error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: 'CVR-opslag mislykkedes — prøv igen senere' },
      { status: 502 }
    );
  }
}
