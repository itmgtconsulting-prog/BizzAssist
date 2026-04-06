/**
 * GET /api/tinglysning/summarisk?uuid=XXXXX
 *
 * Henter og parser summariske ejendomsoplysninger fra Tinglysning XML.
 * Udtrækker ejere (adkomsthavere) med navne, CVR, ejerandele.
 *
 * @param uuid - Tinglysnings-UUID fra søgeresultat
 * @returns { ejere: [...], hæftelser: [...], servitutter: [...] }
 */

import { NextRequest, NextResponse } from 'next/server';
import https from 'https';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CERT_PATH = process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD = process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';

export interface TLEjer {
  navn: string;
  cvr: string | null;
  type: 'person' | 'selskab';
  adkomstType: string | null;
  andel: string | null;
  andelTaeller: number | null;
  andelNaevner: number | null;
  overtagelsesdato: string | null;
  tinglysningsdato: string | null;
  koebesum: number | null;
  koebsaftaledato: string | null;
  kontantKoebesum: number | null;
  iAltKoebesum: number | null;
  tinglysningsafgift: number | null;
  anmelderNavn: string | null;
  anmelderEmail: string | null;
  anmelderCvr: string | null;
  skoedeTekst: string | null;
  ejendomKategori: string | null;
  handelKode: string | null;
  adresse: string | null;
  kommunekode: string | null;
  dokumentId: string | null;
  dokumentAlias: string | null;
  dato: string | null;
}

function tlFetch(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    if (CERT_B64) {
      pfx = Buffer.from(CERT_B64, 'base64');
    } else {
      const certAbsPath = path.resolve(CERT_PATH);
      if (!fs.existsSync(certAbsPath)) {
        reject(new Error('Certifikat ikke fundet'));
        return;
      }
      pfx = fs.readFileSync(certAbsPath);
    }
    const url = new URL(TL_BASE + '/tinglysning/ssl' + urlPath);

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        pfx,
        passphrase: CERT_PASSWORD,
        rejectUnauthorized: false,
        timeout: 15000,
        headers: { Accept: 'application/xml' },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

export interface TLHaeftelse {
  type: string;
  dato: string | null;
  kreditor: string | null;
  kreditorCvr: string | null;
  /** Alle debitorer på hæftelsen — kan være flere ved fælles lån */
  debitorer: string[];
  beloeb: number | null;
  valuta: string;
  rente: number | null;
  laantype: string | null;
  laanevilkaar: string[];
  pantebrevFormular: string | null;
  laaneTekst: string | null;
  tinglysningsafgift: number | null;
  prioritet: number | null;
  dokumentId: string | null;
  dokumentAlias: string | null;
}

export interface TLServitut {
  type: string;
  dato: string | null;
  tekst: string | null;
  prioritet: number | null;
  indholdKoder: string[];
  tillaegsTekst: string | null;
  paataleberettiget: string | null;
  paataleberettigetCvr: string | null;
  harBetydningForVaerdi: boolean;
  tinglysningsafgift: number | null;
  dokumentId: string | null;
  dokumentAlias: string | null;
  /** Original PDF bilagsreferencer (UUID'er der kan hentes via /bilag/{id}) */
  bilagRefs: string[];
  ogsaaLystPaa: number | null;
}

export async function GET(req: NextRequest) {
  const uuid = req.nextUrl.searchParams.get('uuid');
  if (!uuid) {
    return NextResponse.json({ error: 'uuid parameter er påkrævet' }, { status: 400 });
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json({
      ejere: [],
      haeftelser: [],
      servitutter: [],
      fejl: 'Certifikat ikke konfigureret',
    });
  }

  try {
    const res = await tlFetch(`/ejdsummarisk/${uuid}`);
    if (res.status !== 200) {
      return NextResponse.json({
        ejere: [],
        haeftelser: [],
        servitutter: [],
        fejl: `HTTP ${res.status}`,
      });
    }

    const xml = res.body;

    // ── Parse ejere (adkomsthavere) ──
    const ejere: TLEjer[] = [];
    const adkomstSection =
      xml.match(/AdkomstSummariskSamling[\s\S]*?<\/ns:AdkomstSummariskSamling/)?.[0] ?? '';
    const adkomstEntries = [
      ...adkomstSection.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/ns:AdkomstSummarisk/g),
    ];

    for (const [, entry] of adkomstEntries) {
      const adkomstType = entry.match(/AdkomstType[^>]*>([^<]+)/)?.[1] ?? null;

      // Fælles dato-felter for denne adkomst-entry
      const tinglysningsdato =
        entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? null;
      const overtagelsesdato =
        entry.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ?? null;
      const kontantKoebesumStr = entry.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1];
      const iAltKoebesumStr = entry.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1];
      const kontantKoebesum = kontantKoebesumStr ? parseInt(kontantKoebesumStr, 10) : null;
      const iAltKoebesum = iAltKoebesumStr ? parseInt(iAltKoebesumStr, 10) : null;
      const koebesum = kontantKoebesum ?? iAltKoebesum;
      const tinglysningsafgiftStr = entry.match(
        /(?:TinglysningAfgiftBetalt|Afgiftsbeloeb)[^>]*>([^<]+)/
      )?.[1];
      const tinglysningsafgift = tinglysningsafgiftStr ? parseInt(tinglysningsafgiftStr, 10) : null;
      const koebsaftaledato =
        entry.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ?? null;
      const dokumentId = entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null;
      const dokumentAlias =
        entry.match(/DokumentAliasIdentifikator[^>]*>([^<]+)/)?.[1] ??
        entry.match(/AktHistoriskIdentifikator[^>]*>([^<]+)/)?.[1] ??
        null;

      // Find alle adkomsthavere i denne entry
      const havere = [...entry.matchAll(/Adkomsthaver>([\s\S]*?)<\/ns:Adkomsthaver/g)];
      for (const [, haver] of havere) {
        // Navn — PersonName eller sammensatte dele
        const allNames = [...haver.matchAll(/<[^\/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
        const nameStr = allNames
          .map((m) => m[1])
          .filter((n) => n.length > 1)
          .join(' ');

        // CVR
        const cvr = haver.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;

        // Ejerandel
        const taellerStr = haver.match(/Taeller[^>]*>([^<]+)/)?.[1];
        const naevnerStr = haver.match(/Naevner[^>]*>([^<]+)/)?.[1];
        const taeller = taellerStr ? parseInt(taellerStr, 10) : null;
        const naevner = naevnerStr ? parseInt(naevnerStr, 10) : null;
        const andel =
          taeller != null && naevner != null && naevner > 0
            ? `${Math.round((taeller / naevner) * 100)}%`
            : null;

        // Adresse fra adkomsthaver
        const streetName = haver.match(/StreetName[^>]*>([^<]+)/)?.[1];
        const houseNr = haver.match(/StreetBuildingIdentifier[^>]*>([^<]+)/)?.[1];
        const postCode = haver.match(/PostCodeIdentifier[^>]*>([^<]+)/)?.[1];
        const district = haver.match(/DistrictName[^>]*>([^<]+)/)?.[1];
        const kommunekode = haver.match(/MunicipalityCode[^>]*>([^<]+)/)?.[1] ?? null;
        const adresse =
          streetName && houseNr
            ? `${streetName} ${houseNr}${postCode ? `, ${postCode}` : ''}${district ? ` ${district}` : ''}`
            : null;

        if (nameStr) {
          ejere.push({
            navn: nameStr.trim(),
            cvr,
            type: cvr ? 'selskab' : 'person',
            adkomstType,
            andel,
            andelTaeller: taeller,
            andelNaevner: naevner,
            overtagelsesdato,
            tinglysningsdato,
            koebesum: isNaN(koebesum ?? NaN) ? null : koebesum,
            koebsaftaledato,
            kontantKoebesum,
            iAltKoebesum,
            tinglysningsafgift,
            anmelderNavn: null, // Udfyldes fra dokument-opslag nedenfor
            anmelderEmail: null,
            anmelderCvr: null,
            skoedeTekst: null,
            ejendomKategori: null,
            handelKode: null,
            adresse,
            kommunekode,
            dokumentId,
            dokumentAlias,
            dato: tinglysningsdato,
          });
        }
      }
    }

    // ── Berig adkomst med dokument-detaljer (anmelder, skødetekst, kategori) ──
    for (const ejer of ejere) {
      if (!ejer.dokumentId) continue;
      try {
        const dokRes = await tlFetch(`/dokaktuel/uuid/${ejer.dokumentId}`);
        if (dokRes.status === 200) {
          const dok = dokRes.body;
          // Anmelder
          const anmelderSection =
            dok.match(/AnmelderInformation[\s\S]*?<\/[^>]*AnmelderInformation/)?.[0] ?? '';
          ejer.anmelderCvr = anmelderSection.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;
          ejer.anmelderNavn = anmelderSection.match(/PersonName[^>]*>([^<]+)/)?.[1] ?? null;
          ejer.anmelderEmail =
            anmelderSection.match(/EmailAddressIdentifier[^>]*>([^<]+)/)?.[1] ?? null;
          // Lookup anmelder company name from CVR if we have it
          if (ejer.anmelderCvr && !ejer.anmelderNavn) {
            ejer.anmelderNavn = `CVR ${ejer.anmelderCvr}`;
          }
          // Skødetekst
          const skoedeTekst = dok
            .match(/SkoedeTekst[\s\S]*?Afsnit[^>]*>([\s\S]*?)<\/[^>]*Afsnit/)?.[1]
            ?.trim();
          ejer.skoedeTekst = skoedeTekst ?? null;
          // Ejendomskategori
          const katTag = dok.match(/EjendomKategori(\w+)\//)?.[1];
          ejer.ejendomKategori = katTag ?? null;
          // Handelskode
          ejer.handelKode = dok.match(/AdkomstHandelKode[^>]*>([^<]+)/)?.[1] ?? null;
          // Købeaftaledato (fra dokument hvis ikke i summarisk)
          if (!ejer.koebsaftaledato) {
            ejer.koebsaftaledato =
              dok.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ?? null;
          }
        }
      } catch {
        /* ignore — detaljer er valgfrie */
      }
    }

    // ── Parse hæftelser ──
    const haeftelser: TLHaeftelse[] = [];
    const haeftelseEntries = [
      ...xml.matchAll(/<ns:HaeftelseSummarisk>([\s\S]*?)<\/ns:HaeftelseSummarisk>/g),
    ];
    for (const [, entry] of haeftelseEntries) {
      const type = entry.match(/HaeftelseType[^>]*>([^<]+)/)?.[1] ?? 'ukendt';
      const dato = entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? null;
      const kreditor =
        entry.match(/LegalUnitName[^>]*>([^<]+)/)?.[1] ??
        entry.match(/PersonName[^>]*>([^<]+)/)?.[1] ??
        null;
      const kreditorCvr = entry.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;
      const beloebStr = entry.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1];
      const beloeb = beloebStr ? parseInt(beloebStr, 10) : null;
      const valuta = entry.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? 'DKK';
      const dokumentId = entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null;
      const dokumentAlias =
        entry.match(/DokumentAliasIdentifikator[^>]*>([^<]+)/)?.[1] ??
        entry.match(/AktHistoriskIdentifikator[^>]*>([^<]+)/)?.[1] ??
        null;

      const prioritetStr = entry.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1];
      const prioritet = prioritetStr ? parseInt(prioritetStr, 10) : null;
      // Debitor(er) — find alle DebitorInformation-blokke; én hæftelse kan have flere debitorer
      const debitorBlocks = [
        ...entry.matchAll(/DebitorInformation>([\s\S]*?)<\/[^>]*DebitorInformation/g),
      ];
      const debitorer = debitorBlocks
        .map(
          ([, info]) =>
            info.match(/LegalUnitName[^>]*>([^<]+)/)?.[1] ??
            info.match(/PersonName[^>]*>([^<]+)/)?.[1] ??
            ''
        )
        .filter((n) => n.length > 0);
      // Rente
      const renteStr = entry.match(/HaeftelseRentePaalydendeSats[^>]*>([^<]+)/)?.[1];
      const rente = renteStr ? parseFloat(renteStr) : null;
      // Låntype + vilkår
      const laantype = entry.match(/HaeftelseLaantypeKode[^>]*>([^<]+)/)?.[1] ?? null;
      const laanevilkaar = [
        ...entry.matchAll(/HaeftelseSaerligeLaanevilkaarstype[^>]*>([^<]+)/g),
      ].map((m) => m[1]);
      const pantebrevFormular =
        entry.match(/HaeftelsePantebrevFormularLovpligtigKode[^>]*>([^<]+)/)?.[1] ?? null;
      // Lånetekst
      const laaneTekst = entry.match(/Afsnit[^>]*>([^<]{5,})/)?.[1]?.trim() ?? null;
      // Tinglysningsafgift
      const afgiftStr = entry.match(/TinglysningAfgiftBetalt[^>]*>([^<]+)/)?.[1];
      const tinglysningsafgift = afgiftStr ? parseInt(afgiftStr, 10) : null;

      haeftelser.push({
        type,
        dato,
        kreditor,
        kreditorCvr,
        debitorer,
        beloeb,
        valuta,
        rente,
        laantype,
        laanevilkaar,
        pantebrevFormular,
        laaneTekst,
        tinglysningsafgift,
        prioritet,
        dokumentId,
        dokumentAlias,
      });
    }

    // ── Parse servitutter ──
    const servitutter: TLServitut[] = [];
    const servitutEntries = [
      ...xml.matchAll(/<ns:ServitutSummarisk>([\s\S]*?)<\/ns:ServitutSummarisk>/g),
    ];
    for (const [, entry] of servitutEntries) {
      const type = entry.match(/ServitutType[^>]*>([^<]+)/)?.[1] ?? 'ukendt';
      const dato = entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? null;
      const tekst = entry.match(/ServitutTekstSummarisk[^>]*>([^<]+)/)?.[1] ?? null;
      const dokumentId = entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null;
      const dokumentAlias =
        entry.match(/DokumentAliasIdentifikator[^>]*>([^<]+)/)?.[1] ??
        entry.match(/AktHistoriskIdentifikator[^>]*>([^<]+)/)?.[1] ??
        null;
      const ogsaaLystPaaStr = entry.match(/OgsaaLystPaaAntal[^>]*>([^<]+)/)?.[1];
      const ogsaaLystPaa = ogsaaLystPaaStr ? parseInt(ogsaaLystPaaStr, 10) : null;

      const prioritetStr = entry.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1];
      const prioritet = prioritetStr ? parseInt(prioritetStr, 10) : null;
      // Indhold-koder
      const indholdKoder = [
        ...entry.matchAll(
          /ServitutIndholdAndetKode[^>]*>([^<]+)|ServitutIndholdLedningerKode[^>]*>([^<]+)|ServitutIndholdAnvendelseKode[^>]*>([^<]+)/g
        ),
      ]
        .map((m) => (m[1] || m[2] || m[3]).trim())
        .filter((k) => k.length > 1);
      // Tillægstekst
      const tillaegsTekst = entry.match(/Afsnit[^>]*>([^<]{3,})/)?.[1]?.trim() ?? null;
      // Påtaleberettiget
      const paataleberettiget =
        entry.match(/PaataleberettigetSamling[\s\S]*?LegalUnitName[^>]*>([^<]+)/)?.[1] ?? null;
      const paataleberettigetCvr =
        entry.match(/PaataleberettigetSamling[\s\S]*?CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ??
        null;
      // Har betydning for værdi
      const harBetydning =
        entry.match(/ServitutHarBetydningForEjendommensVaerdiIndikator[^>]*>([^<]+)/)?.[1] ===
        'true';
      // Afgift
      const afgiftStr = entry.match(/TinglysningAfgiftBetalt[^>]*>([^<]+)/)?.[1];
      const tinglysningsafgift = afgiftStr ? parseInt(afgiftStr, 10) : null;

      // Bilagsreferencer — UUID'er der kan hentes som original PDF via /bilag/{id}
      const bilagRefs = [
        ...entry.matchAll(
          /Bilagsreference[^>]*>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g
        ),
      ].map((m) => m[1]);
      // Også fra Afsnit-felter der indeholder UUIDs (bilagsreferencer i tillægstekster)
      const afsnittBilag = [
        ...entry.matchAll(
          /Afsnit[^>]*>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g
        ),
      ].map((m) => m[1]);
      const allBilag = [...new Set([...bilagRefs, ...afsnittBilag])];

      servitutter.push({
        type,
        dato,
        tekst,
        prioritet,
        indholdKoder,
        tillaegsTekst,
        paataleberettiget,
        paataleberettigetCvr,
        harBetydningForVaerdi: harBetydning,
        tinglysningsafgift,
        dokumentId,
        dokumentAlias,
        bilagRefs: allBilag,
        ogsaaLystPaa,
      });
    }

    // ── Parse tingbogsattest stamoplysninger ──
    const bfeNr = xml.match(/BestemtFastEjendomNummer[^>]*>([^<]+)/)?.[1] ?? null;
    const ejlNr = xml.match(/Ejerlejlighedsnummer[^>]*>([^<]+)/)?.[1] ?? null;
    const hovedNotering = xml.match(/HovedNotering[^>]*>([^<]+)/)?.[1] ?? null;
    const fordelingTaeller = xml.match(/<ns7:Taeller>([^<]+)/)?.[1] ?? null;
    const fordelingNaevner = xml.match(/<ns7:Naevner>([^<]+)/)?.[1] ?? null;

    // Matrikler
    const matrikler: {
      districtName: string;
      districtId: string;
      matrikelnr: string;
      areal: number | null;
      vejAreal: number | null;
      regDato: string | null;
    }[] = [];
    const matrikelEntries = [
      ...xml.matchAll(/MatrikelStruktur>([\s\S]*?)<\/ns1:MatrikelStruktur/g),
    ];
    for (const [, m] of matrikelEntries) {
      matrikler.push({
        districtName: m.match(/CadastralDistrictName[^>]*>([^<]+)/)?.[1] ?? '',
        districtId: m.match(/CadastralDistrictIdentifier[^>]*>([^<]+)/)?.[1] ?? '',
        matrikelnr: m.match(/Matrikelnummer[^>]*>([^<]+)/)?.[1] ?? '',
        areal: parseInt(m.match(/SpecificParcelAreaMeasure[^>]*>([^<]+)/)?.[1] ?? '', 10) || null,
        vejAreal: parseInt(m.match(/RoadAreaMeasure[^>]*>([^<]+)/)?.[1] ?? '', 10) || null,
        regDato: m.match(/LandParcelRegistrationDate[^>]*>([^<]+)/)?.[1]?.split('+')[0] ?? null,
      });
    }

    // Noteringstekster
    const noteringer: { tekst: string; dato: string | null }[] = [];
    const noteringEntries = [
      ...xml.matchAll(/MatrikelNoteringTekst>([\s\S]*?)<\/ns7:MatrikelNoteringTekst/g),
    ];
    for (const [, n] of noteringEntries) {
      noteringer.push({
        tekst: n.match(/Afsnit[^>]*>([^<]+)/)?.[1] ?? '',
        dato: n.match(/Dato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ?? null,
      });
    }

    // Tillægstekster
    const tillaegstekster: { overskrift: string | null; tekst: string | null }[] = [];
    const tillaegEntries = [...xml.matchAll(/TekstAngivelse>([\s\S]*?)<\/ns7:TekstAngivelse/g)];
    for (const [, t] of tillaegEntries) {
      const overskrift = t.match(/Overskrift[^>]*>([^<]+)/)?.[1] ?? null;
      const afsnit = t.match(/Afsnit[^>]*>([^<]+)/)?.[1] ?? null;
      if (overskrift || afsnit) {
        tillaegstekster.push({ overskrift, tekst: afsnit });
      }
    }

    // ── Saml alle bilagsreferencer (UUIDs der kan hentes som original PDF) ──
    const bilagRefs: { id: string; tekst: string }[] = [];
    for (const t of tillaegEntries) {
      const entry = t[1];
      const overskrift = entry.match(/Overskrift[^>]*>([^<]+)/)?.[1] ?? '';
      if (overskrift.toLowerCase().includes('bilagsreference')) {
        const afsnit = entry.match(/Afsnit[^>]*>([^<]+)/)?.[1] ?? '';
        // UUID kan være i afsnit-teksten
        const uuidMatch = afsnit.match(
          /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
        );
        if (uuidMatch) {
          const beskrivelse = afsnit
            .replace(uuidMatch[0], '')
            .replace(/^\s*-\s*/, '')
            .trim();
          bilagRefs.push({ id: uuidMatch[1], tekst: beskrivelse || 'Bilag' });
        }
      }
    }

    const tingbogsattest = {
      bfeNr,
      ejerlejlighedNr: ejlNr,
      hovedNotering,
      fordelingstal:
        fordelingTaeller && fordelingNaevner
          ? { taeller: parseInt(fordelingTaeller, 10), naevner: parseInt(fordelingNaevner, 10) }
          : null,
      matrikler,
      noteringer,
      tillaegstekster,
    };

    return NextResponse.json(
      { ejere, haeftelser, servitutter, bilagRefs, tingbogsattest, fejl: null },
      {
        headers: { 'Cache-Control': 'public, s-maxage=3600' },
      }
    );
  } catch (err) {
    return NextResponse.json({
      ejere: [],
      haeftelser: [],
      servitutter: [],
      fejl: err instanceof Error ? err.message : 'Fejl',
    });
  }
}
