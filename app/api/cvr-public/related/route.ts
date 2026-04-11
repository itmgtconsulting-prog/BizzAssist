/**
 * GET /api/cvr-public/related?cvr=XXXXXXXX
 *
 * Finder virksomheder som den givne virksomhed ejer andele i (datterselskaber/investeringer).
 * Søger CVR ElasticSearch for virksomheder hvor det givne CVR-nummer optræder som deltager.
 *
 * Kræver CVR_ES_USER + CVR_ES_PASS i .env.local
 *
 * @param cvr - 8-cifret CVR-nummer (query param)
 * @returns { virksomheder: RelateretVirksomhed[], error?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/** En ejer af en relateret virksomhed */
export interface RelatVirkEjer {
  /** Ejerens navn */
  navn: string;
  /** Ejerens enhedsNummer (CVR ES) */
  enhedsNummer: number;
  /** Om ejeren er en virksomhed (vs. person) */
  erVirksomhed: boolean;
  /** Ejerandel interval (f.eks. "90-100%") */
  ejerandel: string | null;
  /** Numerisk ejerandel (0-1) til sortering */
  ejerandelNum: number;
  /** Branchebeskrivelse (kun for virksomheder, beriget via CVR ES) */
  branche?: string | null;
}

/** En relateret virksomhed (datterselskab/investering) */
export interface RelateretVirksomhed {
  /** CVR-nummer */
  cvr: number;
  /** Virksomhedsnavn */
  navn: string;
  /** Virksomhedsform (f.eks. Anpartsselskab) */
  form: string | null;
  /** Branchebeskrivelse */
  branche: string | null;
  /** Adresse */
  adresse: string | null;
  /** Postnummer */
  postnr: string | null;
  /** By */
  by: string | null;
  /** Om virksomheden er aktiv */
  aktiv: boolean;
  /** Antal ansatte (streng) */
  ansatte: string | null;
  /** Ejerandel for den valgte virksomhed (f.eks. "90-100%") */
  ejerandel: string | null;
  /** Numerisk ejerandel (0-1) til sortering */
  ejerandelNum: number;
  /** Stiftelsesdato */
  stiftet: string | null;
  /** Direktør(er) — navne fra Direktion-rolle */
  direktoer: string | null;
  /** Direktionsmedlemmer med enhedsNummer (til klikbare links) */
  direktion: { navn: string; enhedsNummer: number }[];
  /** Bestyrelsesmedlemmer med enhedsNummer (til klikbare links) */
  bestyrelse: { navn: string; enhedsNummer: number }[];
  /** Antal produktionsenheder */
  antalPenheder: number;
  /** Antal datterselskaber (beregnet fra listen) */
  antalDatterselskaber: number;
  /** CVR-nummer på den virksomhed fra listen med størst ejerandel (til gruppering) — null = direkte under den valgte */
  ejetAfCvr: number | null;
  /** Alle ejere med ejerandele (virksomheder og personer fra ejerregistret) */
  ejere: RelatVirkEjer[];
}

// ─── ES Config ───────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

type Periodic = { periode?: { gyldigFra?: string | null; gyldigTil?: string | null } };

/** Finder den gældende (åbne) periode i et tidsbestemt array */
function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

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

/** Mapper ejerandel decimal → interval */
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

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const cvr = req.nextUrl.searchParams.get('cvr')?.replace(/\D/g, '');
  if (!cvr || cvr.length !== 8) {
    return NextResponse.json({ virksomheder: [], error: 'Ugyldigt CVR-nummer' }, { status: 400 });
  }

  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json(
      { virksomheder: [], error: 'CVR ES credentials ikke konfigureret' },
      { status: 503 }
    );
  }

  const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

  /** ES _source felter til virksomhedssøgning */
  const ES_SOURCE_FIELDS = [
    'Vrvirksomhed.cvrNummer',
    'Vrvirksomhed.navne',
    'Vrvirksomhed.virksomhedsform',
    'Vrvirksomhed.hovedbranche',
    'Vrvirksomhed.beliggenhedsadresse',
    'Vrvirksomhed.virksomhedsstatus',
    'Vrvirksomhed.virksomhedMetadata',
    'Vrvirksomhed.livsforloeb',
    'Vrvirksomhed.enhedsNummer',
    'Vrvirksomhed.stiftelsesDato',
    'Vrvirksomhed.kvartalsbeskaeftigelse',
    'Vrvirksomhed.deltagerRelation',
  ];

  /**
   * Søg CVR ES efter virksomheder hvor et sæt enhedsNummere optræder som deltager.
   *
   * @param enhedsNummere - EnhedsNummere at søge efter
   * @returns Rå ES hits
   */
  async function searchByDeltagere(enhedsNummere: number[]): Promise<Record<string, unknown>[]> {
    if (enhedsNummere.length === 0) return [];
    const query =
      enhedsNummere.length === 1
        ? { term: { 'Vrvirksomhed.deltagerRelation.deltager.enhedsNummer': enhedsNummere[0] } }
        : { terms: { 'Vrvirksomhed.deltagerRelation.deltager.enhedsNummer': enhedsNummere } };
    const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        query: { bool: { must: [query] } },
        _source: ES_SOURCE_FIELDS,
        size: 100,
      }),
      signal: AbortSignal.timeout(12000),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { hits?: { hits?: Record<string, unknown>[] } };
    return data.hits?.hits ?? [];
  }

  /**
   * Mapper et råt ES hit til en RelateretVirksomhed.
   * Returnerer null hvis CVR mangler eller matcher excludeCvr.
   *
   * @param hit - Rå ES hit
   * @param roundEnhedsNummere - EnhedsNummere fra denne søgerunde (til ejerandel-beregning)
   * @param excludeCvr - CVR at ekskludere (hovedvirksomheden)
   */
  function mapHitToVirksomhed(
    hit: Record<string, unknown>,
    roundEnhedsNummere: Set<number>,
    excludeCvr: number
  ): (RelateretVirksomhed & { esEnhedsNummer: number | null }) | null {
    const src = (hit._source as Record<string, unknown>)?.Vrvirksomhed as
      | Record<string, unknown>
      | undefined;
    if (!src) return null;

    const relCvr = typeof src.cvrNummer === 'number' ? src.cvrNummer : null;
    if (!relCvr || relCvr === excludeCvr) return null;

    // EnhedsNummer for denne virksomhed (til næste søgerunde)
    const esEnhedsNummer = typeof src.enhedsNummer === 'number' ? src.enhedsNummer : null;

    // Navn
    const navne = Array.isArray(src.navne) ? (src.navne as (Periodic & { navn?: string })[]) : [];
    const navn = gyldigNu(navne)?.navn ?? '';

    // Form
    const formArr = Array.isArray(src.virksomhedsform)
      ? (src.virksomhedsform as (Periodic & { langBeskrivelse?: string })[])
      : [];
    const form = gyldigNu(formArr)?.langBeskrivelse ?? null;

    // Branche
    const brancheArr = Array.isArray(src.hovedbranche)
      ? (src.hovedbranche as (Periodic & { branchetekst?: string })[])
      : [];
    const branche = gyldigNu(brancheArr)?.branchetekst ?? null;

    // Adresse
    const adrArr = Array.isArray(src.beliggenhedsadresse)
      ? (src.beliggenhedsadresse as (Periodic & Record<string, unknown>)[])
      : [];
    const adr = gyldigNu(adrArr);
    const vejnavn = typeof adr?.vejnavn === 'string' ? adr.vejnavn : '';
    const husnr = typeof adr?.husnummerFra === 'number' ? String(adr.husnummerFra) : '';
    const bogstav = typeof adr?.bogstavFra === 'string' ? adr.bogstavFra : '';
    const adresse = vejnavn ? `${vejnavn} ${husnr}${bogstav}`.trim() : null;
    const postnr = typeof adr?.postnummer === 'number' ? String(adr.postnummer) : null;
    const by = typeof adr?.postdistrikt === 'string' ? adr.postdistrikt : null;

    // Status
    const statusArr = Array.isArray(src.virksomhedsstatus)
      ? (src.virksomhedsstatus as (Periodic & { status?: string; statuskode?: string })[])
      : [];
    const statusVal = gyldigNu(statusArr)?.status ?? gyldigNu(statusArr)?.statuskode ?? '';
    const meta = src.virksomhedMetadata as Record<string, unknown> | undefined;
    const sammensatStatus = typeof meta?.sammensatStatus === 'string' ? meta.sammensatStatus : '';
    const livsforloeb = Array.isArray(src.livsforloeb) ? (src.livsforloeb as Periodic[]) : [];
    const harSlutdato = livsforloeb.some((l) => l.periode?.gyldigTil != null);
    const aktiv =
      (statusVal === 'NORMAL' || statusVal === 'AKTIV' || statusVal === '') &&
      sammensatStatus !== 'Ophørt' &&
      !harSlutdato;
    const maanedsBeskæf = meta?.nyesteErstMaanedsbeskaeftigelse as
      | Record<string, unknown>
      | undefined;
    const ansatte =
      maanedsBeskæf?.antalAnsatte != null
        ? String(maanedsBeskæf.antalAnsatte)
        : maanedsBeskæf?.intervalKodeAntalAnsatte
          ? (intervalKodeMap[maanedsBeskæf.intervalKodeAntalAnsatte as string] ?? null)
          : null;

    // Stiftet
    const stiftet = typeof src.stiftelsesDato === 'string' ? src.stiftelsesDato : null;

    // Ejere — alle deltagere med EJERANDEL_PROCENT fra ejerregistret
    const relationer = Array.isArray(src.deltagerRelation)
      ? (src.deltagerRelation as Record<string, unknown>[])
      : [];
    const ejere: RelatVirkEjer[] = [];
    let ejerandel: string | null = null;
    let ejerandelNum = 0;

    for (const rel of relationer) {
      const deltager = rel.deltager as Record<string, unknown> | undefined;
      if (!deltager) continue;
      const dEnhedsNr = typeof deltager.enhedsNummer === 'number' ? deltager.enhedsNummer : null;
      if (!dEnhedsNr) continue;
      const erVirksomhed =
        typeof deltager.enhedstype === 'string' && deltager.enhedstype !== 'PERSON';

      const orgs = Array.isArray(rel.organisationer)
        ? (rel.organisationer as Record<string, unknown>[])
        : [];
      let ejerAndelVal: number | null = null;
      for (const org of orgs) {
        const orgNavne = Array.isArray(org.organisationsNavn)
          ? (org.organisationsNavn as (Periodic & { navn?: string })[])
          : [];
        const erEjerReg = orgNavne.some((n) => n.navn === 'EJERREGISTER');
        if (!erEjerReg) continue;
        const medl = Array.isArray(org.medlemsData)
          ? (org.medlemsData as Record<string, unknown>[])
          : [];
        for (const m of medl) {
          const attrs = Array.isArray(m.attributter)
            ? (m.attributter as Record<string, unknown>[])
            : [];
          for (const attr of attrs) {
            if (typeof attr.type === 'string' && attr.type === 'EJERANDEL_PROCENT') {
              const vaerdier = Array.isArray(attr.vaerdier)
                ? (attr.vaerdier as (Periodic & { vaerdi?: string | number })[])
                : [];
              const harAabenPeriode = vaerdier.some((v) => v.periode?.gyldigTil == null);
              if (!harAabenPeriode) continue;
              const rawVal = gyldigNu(vaerdier)?.vaerdi;
              const parsed = typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal ?? ''));
              if (!isNaN(parsed)) ejerAndelVal = parsed;
            }
          }
        }
      }

      if (ejerAndelVal != null) {
        const dnavne = Array.isArray(deltager.navne)
          ? (deltager.navne as (Periodic & { navn?: string })[])
          : [];
        const dNavn = gyldigNu(dnavne)?.navn ?? '';
        ejere.push({
          navn: dNavn,
          enhedsNummer: dEnhedsNr,
          erVirksomhed,
          ejerandel: mapEjerandelInterval(ejerAndelVal),
          ejerandelNum: ejerAndelVal,
        });

        // Sæt ejerandel kun for ejere fra denne søgerunde (bekræftede gruppe-virksomheder)
        if (roundEnhedsNummere.has(dEnhedsNr) && ejerandelNum < ejerAndelVal) {
          ejerandel = mapEjerandelInterval(ejerAndelVal);
          ejerandelNum = ejerAndelVal;
        }
      }
    }

    ejere.sort((a, b) => b.ejerandelNum - a.ejerandelNum);

    // Direktør + bestyrelse (struktureret med enhedsNummer for klikbare links)
    const direktionList: { navn: string; enhedsNummer: number }[] = [];
    const bestyrelseList: { navn: string; enhedsNummer: number }[] = [];
    const direktoerNavne: string[] = [];
    for (const rel of relationer) {
      const deltager = rel.deltager as Record<string, unknown> | undefined;
      if (!deltager) continue;
      const erPerson = typeof deltager.enhedstype === 'string' && deltager.enhedstype === 'PERSON';
      if (!erPerson) continue;
      const dEnhedsNr = typeof deltager.enhedsNummer === 'number' ? deltager.enhedsNummer : null;
      const dnavne = Array.isArray(deltager.navne)
        ? (deltager.navne as (Periodic & { navn?: string })[])
        : [];
      const dNavn = gyldigNu(dnavne)?.navn;
      if (!dNavn) continue;
      const orgs = Array.isArray(rel.organisationer)
        ? (rel.organisationer as Record<string, unknown>[])
        : [];
      for (const org of orgs) {
        const orgNavne = Array.isArray(org.organisationsNavn)
          ? (org.organisationsNavn as (Periodic & { navn?: string })[])
          : [];
        const erDirektion = orgNavne.some(
          (n) => n.navn === 'Direktion' && n.periode?.gyldigTil == null
        );
        const erBestyrelse = orgNavne.some(
          (n) =>
            (n.navn === 'Bestyrelse' || n.navn === 'Tilsynsråd') && n.periode?.gyldigTil == null
        );
        if (erDirektion && dEnhedsNr && !direktionList.some((d) => d.enhedsNummer === dEnhedsNr)) {
          direktionList.push({ navn: dNavn, enhedsNummer: dEnhedsNr });
          if (!direktoerNavne.includes(dNavn)) direktoerNavne.push(dNavn);
        }
        if (
          erBestyrelse &&
          dEnhedsNr &&
          !bestyrelseList.some((b) => b.enhedsNummer === dEnhedsNr)
        ) {
          bestyrelseList.push({ navn: dNavn, enhedsNummer: dEnhedsNr });
        }
      }
    }
    const direktoer = direktoerNavne.length > 0 ? direktoerNavne.join(', ') : null;

    // P-enheder
    const antalPenheder =
      typeof meta?.antalPenheder === 'number'
        ? meta.antalPenheder
        : typeof (meta as Record<string, unknown>)?.nyesteAntalPenheder === 'number'
          ? ((meta as Record<string, unknown>).nyesteAntalPenheder as number)
          : 0;

    return {
      cvr: relCvr,
      navn,
      form,
      branche,
      adresse,
      postnr,
      by,
      aktiv,
      ansatte,
      ejerandel,
      ejerandelNum,
      stiftet,
      direktoer,
      direktion: direktionList,
      bestyrelse: bestyrelseList,
      antalPenheder,
      antalDatterselskaber: 0,
      ejetAfCvr: null as number | null,
      ejere,
      esEnhedsNummer,
    };
  }

  try {
    // ── Stap 1: Find enhedsNummer for CVR-nummeret ──
    const enhedsQuery = {
      query: { term: { 'Vrvirksomhed.cvrNummer': Number(cvr) } },
      _source: ['Vrvirksomhed.enhedsNummer'],
      size: 1,
    };

    const enhedsRes = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify(enhedsQuery),
      signal: AbortSignal.timeout(8000),
    });

    if (!enhedsRes.ok) {
      const errBody = await enhedsRes.text().catch(() => '');
      logger.error('[cvr-public/related] enhedsQuery fejl:', enhedsRes.status, errBody);
      return NextResponse.json(
        { virksomheder: [], error: `CVR ES fejl: ${enhedsRes.status}` },
        { status: 502 }
      );
    }

    const enhedsData = (await enhedsRes.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
    };
    const enhedsHit = enhedsData.hits?.hits?.[0];
    const enhedsNr = (
      (enhedsHit?._source as Record<string, unknown>)?.Vrvirksomhed as Record<string, unknown>
    )?.enhedsNummer;

    if (typeof enhedsNr !== 'number') {
      return NextResponse.json({ virksomheder: [] });
    }

    // ── Stap 2: Rekursiv søgning — find datterselskaber i op til 3 niveauer ──
    const MAX_DEPTH = 3;
    /** Hits grupperet per runde med de enhedsNummere der blev søgt med */
    const roundResults: { hits: Record<string, unknown>[]; searchedEnhedsNummere: Set<number> }[] =
      [];
    const seenCvr = new Set<number>([Number(cvr)]);
    /** enhedsNr→CVR map (inkl. hovedvirksomheden) */
    const enhedsNrToCvr = new Map<number, number>();
    enhedsNrToCvr.set(enhedsNr, Number(cvr));

    // Første runde: søg med hovedvirksomhedens enhedsNummer
    let nextEnhedsNummere = [enhedsNr];

    for (let depth = 0; depth < MAX_DEPTH && nextEnhedsNummere.length > 0; depth++) {
      const searchSet = new Set(nextEnhedsNummere);
      const hits = await searchByDeltagere(nextEnhedsNummere);
      const roundHits: Record<string, unknown>[] = [];
      const newSubEnhedsNummere: number[] = [];

      for (const hit of hits) {
        const src = (hit._source as Record<string, unknown>)?.Vrvirksomhed as
          | Record<string, unknown>
          | undefined;
        if (!src) continue;
        const hitCvr = typeof src.cvrNummer === 'number' ? src.cvrNummer : null;
        if (!hitCvr || seenCvr.has(hitCvr)) continue;
        seenCvr.add(hitCvr);
        roundHits.push(hit);

        // Saml enhedsNummere for næste runde
        const hitEnhedsNr = typeof src.enhedsNummer === 'number' ? src.enhedsNummer : null;
        if (hitEnhedsNr) {
          enhedsNrToCvr.set(hitEnhedsNr, hitCvr);
          newSubEnhedsNummere.push(hitEnhedsNr);
        }
      }

      roundResults.push({ hits: roundHits, searchedEnhedsNummere: searchSet });
      nextEnhedsNummere = newSubEnhedsNummere;
    }

    // ── Stap 3: Map alle hits til RelateretVirksomhed ──
    // ejerandel sættes kun for ejere der matcher den specifikke rundes søge-enhedsNummere
    // (dvs. bekræftede gruppe-virksomheder med aktivt ejerskab)
    const virksomheder: RelateretVirksomhed[] = roundResults
      .flatMap(({ hits, searchedEnhedsNummere }) =>
        hits.map((hit) => mapHitToVirksomhed(hit, searchedEnhedsNummere, Number(cvr)))
      )
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .sort((a, b) => {
        if (a.aktiv !== b.aktiv) return a.aktiv ? -1 : 1;
        return a.navn.localeCompare(b.navn, 'da');
      });

    // Opdater enhedsNrToCvr med mappede virksomheder
    for (const v of virksomheder) {
      const mapped = v as RelateretVirksomhed & { esEnhedsNummer?: number | null };
      if (mapped.esEnhedsNummer) {
        enhedsNrToCvr.set(mapped.esEnhedsNummer, v.cvr);
      }
    }

    // For hver virksomhed: find den ejer med størst andel der er på listen (ekskl. den valgte)
    // Gruppér under denne virksomhed — dette reflekterer ejerskabs-hierarkiet
    const listeCvr = new Set(virksomheder.map((v) => v.cvr));
    listeCvr.add(Number(cvr)); // Inkluder den valgte
    for (const v of virksomheder) {
      const ejerPaaListen = v.ejere
        .filter((e) => {
          const eCvr = enhedsNrToCvr.get(e.enhedsNummer);
          return (
            e.erVirksomhed &&
            eCvr != null &&
            listeCvr.has(eCvr) &&
            eCvr !== Number(cvr) &&
            eCvr !== v.cvr
          );
        })
        .sort((a, b) => b.ejerandelNum - a.ejerandelNum);
      if (ejerPaaListen.length > 0) {
        // Gruppér under den virksomhed fra listen med størst ejerandel
        const parentCvr = enhedsNrToCvr.get(ejerPaaListen[0].enhedsNummer);
        if (parentCvr) v.ejetAfCvr = parentCvr;
      }
    }

    // ── Post-processing: sæt ejerandel for indirekte datter fra ejere-listen ──
    // Virksomheder fundet i en tidlig runde (via ikke-ejerskabs-relation) har ejerandel=null
    // men kan have en ejer på listen (f.eks. via JAJR Holding 2).
    // Kun hvis parent selv har bekræftet ejerandel (er i gruppen).
    {
      let ppChanged = true;
      while (ppChanged) {
        ppChanged = false;
        for (const v of virksomheder) {
          if (v.ejerandel !== null) continue;
          if (v.ejetAfCvr == null) continue;
          // Bekræft at parent selv har ejerandel (er en bekræftet gruppe-virksomhed)
          const parentVirk = virksomheder.find((p) => p.cvr === v.ejetAfCvr);
          if (!parentVirk || parentVirk.ejerandel === null) continue;
          // Find parent-virksomhedens enhedsNummer
          const parentEnhedsNr = [...enhedsNrToCvr.entries()].find(
            ([, c]) => c === v.ejetAfCvr
          )?.[0];
          if (parentEnhedsNr) {
            const parentEjer = v.ejere.find((e) => e.enhedsNummer === parentEnhedsNr);
            if (parentEjer) {
              v.ejerandel = parentEjer.ejerandel;
              v.ejerandelNum = parentEjer.ejerandelNum;
              ppChanged = true;
            }
          }
        }
      }
    }

    // ── Transitiv ejerskabs-filtrering ──
    // Kun medtag virksomheder der er forbundet via aktivt ejerskab:
    // 1. Direkte ejede af den forespurgte virksomhed (ejerandel !== null)
    // 2. Virksomheder ejet af virksomheder der allerede er inkluderet (via ejetAfCvr)
    const inkluderet = new Set<number>();
    // Trin 1: direkte ejede
    for (const v of virksomheder) {
      if (v.ejerandel !== null) inkluderet.add(v.cvr);
    }
    // Trin 2: transitiv udvidelse — tilføj virksomheder ejet af allerede inkluderede
    let changed = true;
    while (changed) {
      changed = false;
      for (const v of virksomheder) {
        if (inkluderet.has(v.cvr)) continue;
        if (v.ejetAfCvr != null && inkluderet.has(v.ejetAfCvr)) {
          inkluderet.add(v.cvr);
          changed = true;
        }
      }
    }
    // Filtrer listen
    const filtreret = virksomheder.filter((v) => inkluderet.has(v.cvr));

    // Beregn antal datterselskaber for hver virksomhed
    // (antal virksomheder fra listen der har denne som ejetAfCvr)
    for (const v of filtreret) {
      v.antalDatterselskaber = filtreret.filter((c) => c.ejetAfCvr === v.cvr).length;
    }

    // ── Berig ejere med branche via batch CVR ES opslag ──
    // Saml unikke virksomheds-ejere (enhedsNummer) der ikke allerede er i listen
    const ejerEnhedsNummere = new Set<number>();
    for (const v of filtreret) {
      for (const e of v.ejere) {
        if (e.erVirksomhed && !enhedsNrToCvr.has(e.enhedsNummer)) {
          ejerEnhedsNummere.add(e.enhedsNummer);
        }
      }
    }
    // Batch-hent branche for disse virksomheder
    if (ejerEnhedsNummere.size > 0 && CVR_ES_USER) {
      try {
        const ejerQuery = {
          _source: ['Vrvirksomhed.enhedsNummer', 'Vrvirksomhed.hovedbranche'],
          query: { terms: { 'Vrvirksomhed.enhedsNummer': [...ejerEnhedsNummere] } },
          size: ejerEnhedsNummere.size,
        };
        const ejerRes = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
          method: 'POST',
          headers: {
            Authorization:
              'Basic ' + Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64'),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(ejerQuery),
          signal: AbortSignal.timeout(10000),
        });
        if (ejerRes.ok) {
          const ejerJson = await ejerRes.json();
          const ejerHits = ejerJson?.hits?.hits ?? [];
          const brancheMap = new Map<number, string>();
          for (const hit of ejerHits) {
            const src = hit._source?.Vrvirksomhed ?? {};
            const en = src.enhedsNummer as number | undefined;
            const hb = Array.isArray(src.hovedbranche) ? (src.hovedbranche as Periodic[]) : [];
            const gyldigHb = gyldigNu(hb) as Record<string, unknown> | null;
            const brTxt = gyldigHb?.branchetekst as string | undefined;
            if (en && brTxt) brancheMap.set(en, brTxt);
          }
          // Sæt branche på ejere
          for (const v of filtreret) {
            for (const e of v.ejere) {
              if (e.erVirksomhed && brancheMap.has(e.enhedsNummer)) {
                e.branche = brancheMap.get(e.enhedsNummer) ?? null;
              }
            }
          }
        }
      } catch {
        // Ignorer fejl — branche er nice-to-have
      }
    }

    // Fjern intern esEnhedsNummer-felt fra responsen
    const cleaned = filtreret.map(({ ...v }) => {
      delete (v as Record<string, unknown>).esEnhedsNummer;
      return v;
    });

    return NextResponse.json({ virksomheder: cleaned, parentEnhedsNummer: enhedsNr });
  } catch (err) {
    logger.error('[cvr-public/related] Fejl:', err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { virksomheder: [], error: 'Kunne ikke hente relaterede virksomheder' },
      { status: 500 }
    );
  }
}
