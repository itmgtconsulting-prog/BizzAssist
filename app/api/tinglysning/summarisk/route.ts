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
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
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

/** In-memory cache for summarisk XML — avoids re-fetching large responses */
const xmlCache = new Map<string, { status: number; body: string; ts: number }>();
const XML_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Exposed for test teardown only — clears the in-memory XML cache. */
export function clearXmlCache(): void {
  xmlCache.clear();
}

/**
 * Run async tasks in parallel batches to avoid overwhelming the external API.
 * @param items - Array of items to process
 * @param fn - Async function to call for each item
 * @param batchSize - Max concurrent calls (default 5)
 */
async function batchParallel<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  batchSize = 5
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.allSettled(items.slice(i, i + batchSize).map(fn));
  }
}

/**
 * @param urlPath - Tinglysning API path
 * @param maxBytes - Stop downloading after this many bytes (0 = no limit).
 *   Used for sectioned calls where we only need part of the XML.
 */
function tlFetch(
  urlPath: string,
  maxBytes = 0
): Promise<{ status: number; body: string; truncated: boolean }> {
  const cached = xmlCache.get(urlPath);
  if (cached && Date.now() - cached.ts < XML_CACHE_TTL) {
    return Promise.resolve({ status: cached.status, body: cached.body, truncated: false });
  }

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
        timeout: 55000,
        headers: { Accept: 'application/xml' },
      },
      (res) => {
        let body = '';
        let truncated = false;
        res.on('data', (d) => {
          body += d;
          // Early termination: stop downloading once we have enough data
          if (maxBytes > 0 && body.length >= maxBytes) {
            truncated = true;
            res.destroy(); // Stop reading
          }
        });
        res.on('end', () => {
          const result = { status: res.statusCode ?? 500, body, truncated: false };
          if (result.status === 200 && !truncated) {
            xmlCache.set(urlPath, { ...result, ts: Date.now() });
          }
          resolve({ ...result, truncated });
        });
        res.on('close', () => {
          if (truncated) {
            resolve({ status: res.statusCode ?? 200, body, truncated: true });
          }
        });
      }
    );
    req.on('error', (err) => {
      // If we truncated intentionally, that's not an error
      if (err.message.includes('aborted')) return;
      reject(err);
    });
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
  /** Rentetype: "Variabel" eller "Fast" */
  renteType: string | null;
  /** Foreløbig rente-indikator */
  renteForeloebig: boolean;
  /** Referencerente-navn, f.eks. "CITA 6", "Nationalbankens indskudsbevisrente" */
  referenceRenteNavn: string | null;
  /** Referencerente-sats, f.eks. -0.4099 */
  referenceRenteSats: number | null;
  /** Rentetillæg-sats i %, f.eks. 0.18 */
  renteTillaeg: number | null;
  /** Tillægstype: "Variabel" eller "Fast" */
  renteTillaegType: string | null;
  laantype: string | null;
  laanevilkaar: string[];
  pantebrevFormular: string | null;
  /** Kreditorbetegnelse, f.eks. "49232603 Kapitalcenter: 1" */
  kreditorbetegnelse: string | null;
  laaneTekst: string | null;
  tinglysningsafgift: number | null;
  prioritet: number | null;
  dokumentId: string | null;
  dokumentAlias: string | null;
  /** Underpant-information (ejerpantebreve) */
  underpant: {
    prioritet: number | null;
    beloeb: number | null;
    valuta: string;
    havere: string[];
  } | null;
  /** Fuldmagtsbestemmelser — navne på fuldmagtshavere */
  fuldmagtsbestemmelser: string[];
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
  /** True hvis servitutten er hentet fra hovedejendommen (for ejerlejligheder) */
  fraHovedejendom?: boolean;
}

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const uuid = req.nextUrl.searchParams.get('uuid');
  if (!uuid) {
    return NextResponse.json({ error: 'uuid parameter er påkrævet' }, { status: 400 });
  }
  /**
   * Optional section filter: ?section=ejere|haeftelser|servitutter
   * When set, only that section is parsed and returned — reduces processing
   * time for large XML responses. Klienten kalder 3 gange i stedet for 1.
   * Uden section returneres alt (bagudkompatibelt).
   */
  const section = req.nextUrl.searchParams.get('section');
  /** Valgfri: BFE for hovedejendom — henter servitutter for BÅDE lejlighed og hovedejendom */
  const hovedBfe = req.nextUrl.searchParams.get('hovedBfe');

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json({
      ejere: [],
      haeftelser: [],
      servitutter: [],
      fejl: 'Certifikat ikke konfigureret',
    });
  }

  try {
    // For ejere/haeftelser sections, limit download to 25KB — enough for adkomst+haeftelser
    // but skips most servitutter (which can be 60KB+ for hovedejendomme).
    // Full download only for servitutter section or no section (backwards compat).
    const needsFullXml = !section || section === 'servitutter';
    const maxBytes = needsFullXml ? 0 : 25_000;
    const res = await tlFetch(`/ejdsummarisk/${uuid}`, maxBytes);
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
    // Paralleliseret i batches af 5 for at undgå at overbelaste Tinglysning API
    await batchParallel(
      ejere.filter((e) => e.dokumentId),
      async (ejer) => {
        try {
          const dokRes = await tlFetch(`/dokaktuel/uuid/${ejer.dokumentId}`);
          if (dokRes.status === 200) {
            const dok = dokRes.body;
            // Anmelder
            const anmelderSection =
              dok.match(/AnmelderInformation[\s\S]*?<\/[^>]*AnmelderInformation/)?.[0] ?? '';
            ejer.anmelderCvr =
              anmelderSection.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;
            ejer.anmelderNavn = anmelderSection.match(/PersonName[^>]*>([^<]+)/)?.[1] ?? null;
            ejer.anmelderEmail =
              anmelderSection.match(/EmailAddressIdentifier[^>]*>([^<]+)/)?.[1] ?? null;
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
    );

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
      // Debitor(er) — XML-strukturen er:
      // <ns:DebitorInformationSamling>
      //   <ns7:RolleInformation>
      //     <ns7:PersonSimpelIdentifikator>
      //       <ns14:PersonName>Navn</ns14:PersonName>
      //     </ns7:PersonSimpelIdentifikator>
      //   </ns7:RolleInformation>
      //   ... (flere RolleInformation for flere debitorer)
      // </ns:DebitorInformationSamling>
      const debitorSamling =
        entry.match(/DebitorInformationSamling>([\s\S]*?)<\/[^>]*DebitorInformationSamling/)?.[1] ??
        '';
      // Hvert RolleInformation-blok er én debitor
      const rolleBlocks = debitorSamling
        ? [...debitorSamling.matchAll(/RolleInformation>([\s\S]*?)<\/[^>]*RolleInformation/g)]
        : [];
      let debitorer: string[];
      if (rolleBlocks.length > 0) {
        debitorer = rolleBlocks
          .map(([, info]) => {
            const allNames = [...info.matchAll(/<[^\/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
            return allNames
              .map((m) => m[1].trim())
              .filter((n) => n.length > 1)
              .join(' ');
          })
          .filter((n) => n.length > 0);
      } else {
        // Fallback: prøv generel name-udtrækning fra hele debitor-blokken
        const allDebNames = [
          ...debitorSamling.matchAll(/<[^\/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g),
        ];
        debitorer = allDebNames.map((m) => m[1].trim()).filter((n) => n.length > 1);
      }
      // Rente — pålydende sats + type + foreløbig + referencerente + tillæg
      // XML-strukturen er: <HaeftelseRente> → <HaeftelseRenteFast> eller <HaeftelseRenteVariabel>
      const renteStr = entry.match(/HaeftelseRentePaalydendeSats[^>]*>([^<]+)/)?.[1];
      const rente = renteStr ? parseFloat(renteStr) : null;
      // Bestem rentetype ud fra XML-tag: HaeftelseRenteFast = "Fast", HaeftelseRenteVariabel = "Variabel"
      const renteType =
        entry.match(/HaeftelseRenteType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
        (entry.match(/HaeftelseRenteVariabel/)
          ? 'Variabel'
          : entry.match(/HaeftelseRenteFast/)
            ? 'Fast'
            : null);
      const renteForeloebig =
        (entry.match(/HaeftelseRenteSatsForeloebigIndikator[^>]*>([^<]+)/)?.[1] ??
          entry.match(/HaeftelseForeloebigRenteIndikator[^>]*>([^<]+)/)?.[1]) === 'true';
      const referenceRenteNavn =
        entry.match(/HaeftelseReferenceRenteNavn[^>]*>([^<]+)/)?.[1] ??
        entry.match(/ReferenceRenteNavn[^>]*>([^<]+)/)?.[1] ??
        null;
      const referenceRenteSatsStr =
        entry.match(/HaeftelseReferenceRenteSats[^>]*>([^<]+)/)?.[1] ??
        entry.match(/ReferenceRenteSats[^>]*>([^<]+)/)?.[1];
      const referenceRenteSats = referenceRenteSatsStr ? parseFloat(referenceRenteSatsStr) : null;
      // Tillæg — prøv mange varianter af tag-navne
      const renteTillaegStr =
        entry.match(/HaeftelseRenteTillaegSats[^>]*>([^<]+)/)?.[1] ??
        entry.match(/RenteTillaegSats[^>]*>([^<]+)/)?.[1] ??
        entry.match(/HaeftelseTillaegSats[^>]*>([^<]+)/)?.[1] ??
        entry.match(/TillaegSats[^>]*>([^<]+)/)?.[1] ??
        entry.match(/Tillaeg[^>]*>([0-9.,]+)/)?.[1] ??
        entry.match(/RenteTillaeg[^>]*>([0-9.,]+)/)?.[1];
      const renteTillaeg = renteTillaegStr ? parseFloat(renteTillaegStr) : null;
      const renteTillaegType =
        entry.match(/HaeftelseRenteTillaegType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
        entry.match(/RenteTillaegType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
        entry.match(/TillaegType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
        null;
      // Låntype + vilkår
      const laantype = entry.match(/HaeftelseLaantypeKode[^>]*>([^<]+)/)?.[1] ?? null;
      const laanevilkaar = [
        ...entry.matchAll(/HaeftelseSaerligeLaanevilkaarstype[^>]*>([^<]+)/g),
      ].map((m) => m[1]);
      const pantebrevFormular =
        entry.match(/HaeftelsePantebrevFormularLovpligtigKode[^>]*>([^<]+)/)?.[1] ?? null;
      // Kreditorbetegnelse
      const kreditorbetegnelse =
        entry.match(/KreditorBetegnelse[^>]*>([^<]+)/)?.[1] ??
        entry.match(/HaeftelseKreditorBetegnelse[^>]*>([^<]+)/)?.[1] ??
        null;
      // Lånetekst — saml alle Afsnit-elementer (kan være flere)
      const laaneTekstAfsnit = [...entry.matchAll(/Afsnit[^>]*>([^<]{5,})/g)]
        .map((m) => m[1].trim())
        .filter((v) => v.length > 0);
      const laaneTekst = laaneTekstAfsnit.length > 0 ? laaneTekstAfsnit.join('\n') : null;
      // Tinglysningsafgift
      const afgiftStr = entry.match(/(?:TinglysningAfgiftBetalt|Afgiftsbeloeb)[^>]*>([^<]+)/)?.[1];
      const tinglysningsafgift = afgiftStr ? parseInt(afgiftStr, 10) : null;
      // Underpant (f.eks. på ejerpantebreve) — XML bruger UnderpantrettighedSamling
      const underpantBlock =
        entry.match(/UnderpantrettighedSamling>([\s\S]*?)<\/[^>]*UnderpantrettighedSamling/)?.[1] ??
        entry.match(/Underpantrettighed>([\s\S]*?)<\/[^>]*Underpantrettighed/)?.[1] ??
        entry.match(/Underpants[aæ]tning\w*>([\s\S]*?)<\/[^>]*Underpants[aæ]tning/)?.[1] ??
        entry.match(/[A-Za-z]*[Uu]nderpant\w*>([\s\S]*?)<\/[^>]*[Uu]nderpant/)?.[1] ??
        null;
      let underpant: TLHaeftelse['underpant'] = null;
      if (underpantBlock) {
        // Prioritet: prøv UnderpantsaetningPrioritet, PrioritetNummer, eller bare Prioritet
        const upPriStr =
          underpantBlock.match(/(?:Underpants[aæ]tning)?Prioritet(?:Nummer)?[^>]*>([^<]+)/)?.[1] ??
          underpantBlock.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1];
        // Beløb: prøv Underpantsaetning-wrapper + BeloebVaerdi, eller direkte
        const upBeloebStr =
          underpantBlock.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1] ??
          underpantBlock.match(/(?:Underpants[aæ]tning)?Beloeb[^>]*>(\d+)/)?.[1];
        const upValuta = underpantBlock.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? 'DKK';
        // Havere: fra UnderpanthavereInformationSamling → RolleInformation → LegalUnitName/PersonName
        // eller direkte navne i blokken
        const havereSamling =
          underpantBlock.match(/Underpanthaver\w*>([\s\S]*?)<\/[^>]*Underpanthaver/)?.[1] ??
          underpantBlock;
        const upHavere = [
          ...havereSamling.matchAll(/(?:LegalUnitName|PersonName|Navn)[^>]*>([^<]+)/g),
        ]
          .map((m) => m[1].trim())
          .filter((n) => n.length > 1);
        underpant = {
          prioritet: upPriStr ? parseInt(upPriStr, 10) : null,
          beloeb: upBeloebStr ? parseInt(upBeloebStr, 10) : null,
          valuta: upValuta,
          havere: upHavere,
        };
      }
      // Fuldmagtsbestemmelser — XML bruger ImplicitFuldmagtSamling → FuldmagtHaverInformation → LegalUnitName/PersonName
      const fuldmagtSamling =
        entry.match(/(?:Implicit)?FuldmagtSamling>([\s\S]*?)<\/[^>]*FuldmagtSamling/)?.[1] ?? '';
      const fuldmagtHavere = fuldmagtSamling
        ? [
            ...fuldmagtSamling.matchAll(
              /FuldmagtHaverInformation>([\s\S]*?)<\/[^>]*FuldmagtHaverInformation/g
            ),
          ]
        : [];
      let fuldmagtsbestemmelser: string[];
      if (fuldmagtHavere.length > 0) {
        fuldmagtsbestemmelser = fuldmagtHavere
          .map(([, info]) => {
            const names = [...info.matchAll(/(?:LegalUnitName|PersonName|Navn)[^>]*>([^<]+)/g)];
            return names
              .map((m) => m[1].trim())
              .filter((n) => n.length > 1)
              .join(' ');
          })
          .filter((n) => n.length > 0);
      } else {
        // Fallback: alle navne direkte i fuldmagt-blokken
        fuldmagtsbestemmelser = [
          ...fuldmagtSamling.matchAll(/(?:LegalUnitName|PersonName|Navn)[^>]*>([^<]+)/g),
        ]
          .map((m) => m[1].trim())
          .filter((n) => n.length > 1);
      }

      haeftelser.push({
        type,
        dato,
        kreditor,
        kreditorCvr,
        debitorer,
        beloeb,
        valuta,
        rente,
        renteType,
        renteForeloebig,
        referenceRenteNavn,
        referenceRenteSats,
        renteTillaeg,
        renteTillaegType,
        laantype,
        laanevilkaar,
        pantebrevFormular,
        kreditorbetegnelse,
        laaneTekst,
        tinglysningsafgift,
        prioritet,
        dokumentId,
        dokumentAlias,
        underpant,
        fuldmagtsbestemmelser,
      });
    }

    // ── Berig hæftelser med dokument-detaljer (rente-detaljer, underpant, fuldmagt, kreditorbetegnelse) ──
    // Dedupliker dokumentId'er og paralleliser i batches af 5
    const enrichedHaeftelseDocs = new Set<string>();
    const haeftelserToEnrich = haeftelser.filter((h) => {
      if (!h.dokumentId || enrichedHaeftelseDocs.has(h.dokumentId)) return false;
      enrichedHaeftelseDocs.add(h.dokumentId);
      return true;
    });
    await batchParallel(haeftelserToEnrich, async (h) => {
      try {
        const dokRes = await tlFetch(`/dokaktuel/uuid/${h.dokumentId}`);
        if (dokRes.status === 200) {
          const dok = dokRes.body;
          // Debitorer (fra dokument hvis summarisk ikke har dem)
          if (h.debitorer.length === 0) {
            // Samme struktur som summarisk: DebitorInformationSamling → RolleInformation → PersonName
            const dokDebitorSamling =
              dok.match(
                /DebitorInformationSamling>([\s\S]*?)<\/[^>]*DebitorInformationSamling/
              )?.[1] ?? '';
            const dokRolleBlocks = dokDebitorSamling
              ? [
                  ...dokDebitorSamling.matchAll(
                    /RolleInformation>([\s\S]*?)<\/[^>]*RolleInformation/g
                  ),
                ]
              : [];
            if (dokRolleBlocks.length > 0) {
              h.debitorer = dokRolleBlocks
                .map(([, info]) => {
                  const allNames = [...info.matchAll(/<[^\/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
                  return allNames
                    .map((m) => m[1].trim())
                    .filter((n) => n.length > 1)
                    .join(' ');
                })
                .filter((n) => n.length > 0);
            } else if (dokDebitorSamling) {
              // Fallback: alle navne i debitor-blokken
              h.debitorer = [
                ...dokDebitorSamling.matchAll(/<[^\/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g),
              ]
                .map((m) => m[1].trim())
                .filter((n) => n.length > 1);
            }
          }
          // Kreditorbetegnelse (fra dokument hvis ikke i summarisk)
          if (!h.kreditorbetegnelse) {
            h.kreditorbetegnelse =
              dok.match(/KreditorBetegnelse[^>]*>([^<]+)/)?.[1] ??
              dok.match(/HaeftelseKreditorBetegnelse[^>]*>([^<]+)/)?.[1] ??
              null;
          }
          // Rente-detaljer (fra dokument hvis ikke i summarisk)
          if (!h.renteType) {
            h.renteType =
              dok.match(/HaeftelseRenteType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
              (dok.match(/HaeftelseRenteVariabel/)
                ? 'Variabel'
                : dok.match(/HaeftelseRenteFast/)
                  ? 'Fast'
                  : null);
          }
          if (!h.renteForeloebig) {
            h.renteForeloebig =
              (dok.match(/HaeftelseRenteSatsForeloebigIndikator[^>]*>([^<]+)/)?.[1] ??
                dok.match(/HaeftelseForeloebigRenteIndikator[^>]*>([^<]+)/)?.[1]) === 'true';
          }
          if (!h.referenceRenteNavn) {
            h.referenceRenteNavn =
              dok.match(/HaeftelseReferenceRenteNavn[^>]*>([^<]+)/)?.[1] ??
              dok.match(/ReferenceRenteNavn[^>]*>([^<]+)/)?.[1] ??
              null;
          }
          if (h.referenceRenteSats == null) {
            const refSatsStr =
              dok.match(/HaeftelseReferenceRenteSats[^>]*>([^<]+)/)?.[1] ??
              dok.match(/ReferenceRenteSats[^>]*>([^<]+)/)?.[1];
            h.referenceRenteSats = refSatsStr ? parseFloat(refSatsStr) : null;
          }
          if (h.renteTillaeg == null) {
            const tillaegStr =
              dok.match(/HaeftelseRenteTillaegSats[^>]*>([^<]+)/)?.[1] ??
              dok.match(/RenteTillaegSats[^>]*>([^<]+)/)?.[1] ??
              dok.match(/HaeftelseTillaegSats[^>]*>([^<]+)/)?.[1] ??
              dok.match(/TillaegSats[^>]*>([^<]+)/)?.[1] ??
              dok.match(/Tillaeg[^>]*>([0-9.,]+)/)?.[1] ??
              dok.match(/RenteTillaeg[^>]*>([0-9.,]+)/)?.[1];
            h.renteTillaeg = tillaegStr ? parseFloat(tillaegStr) : null;
          }
          if (!h.renteTillaegType) {
            h.renteTillaegType =
              dok.match(/HaeftelseRenteTillaegType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
              dok.match(/RenteTillaegType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
              dok.match(/TillaegType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
              null;
          }
          // Underpant (fra dokument hvis ikke i summarisk)
          if (!h.underpant) {
            // Prøv flere mulige tag-navne — Tinglysnings-XML varierer
            const upBlock =
              dok.match(
                /UnderpantrettighedSamling>([\s\S]*?)<\/[^>]*UnderpantrettighedSamling/
              )?.[1] ??
              dok.match(/Underpantrettighed>([\s\S]*?)<\/[^>]*Underpantrettighed/)?.[1] ??
              dok.match(/Underpants[aæ]tning\w*>([\s\S]*?)<\/[^>]*Underpants[aæ]tning/)?.[1] ??
              dok.match(/[A-Za-z]*[Uu]nderpant\w*>([\s\S]*?)<\/[^>]*[Uu]nderpant/)?.[1] ??
              null;
            if (upBlock) {
              const upPriStr =
                upBlock.match(/(?:Underpants[aæ]tning)?Prioritet(?:Nummer)?[^>]*>([^<]+)/)?.[1] ??
                upBlock.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1];
              const upBeloebStr =
                upBlock.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1] ??
                upBlock.match(/(?:Underpants[aæ]tning)?Beloeb[^>]*>(\d+)/)?.[1];
              const upValuta = upBlock.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? 'DKK';
              const havereSamling =
                upBlock.match(/Underpanthavere\w*>([\s\S]*?)<\/[^>]*Underpanthavere/)?.[1] ??
                upBlock;
              const upHavere = [
                ...havereSamling.matchAll(/(?:LegalUnitName|PersonName|Navn)[^>]*>([^<]+)/g),
              ]
                .map((m) => m[1].trim())
                .filter((n) => n.length > 1);
              h.underpant = {
                prioritet: upPriStr ? parseInt(upPriStr, 10) : null,
                beloeb: upBeloebStr ? parseInt(upBeloebStr, 10) : null,
                valuta: upValuta,
                havere: upHavere,
              };
            }
          }
          // Fuldmagtsbestemmelser (fra dokument hvis ikke i summarisk)
          if (h.fuldmagtsbestemmelser.length === 0) {
            const dokFuldmagtSamling =
              dok.match(/(?:Implicit)?FuldmagtSamling>([\s\S]*?)<\/[^>]*FuldmagtSamling/)?.[1] ??
              '';
            const dokFuldmagtHavere = dokFuldmagtSamling
              ? [
                  ...dokFuldmagtSamling.matchAll(
                    /FuldmagtHaverInformation>([\s\S]*?)<\/[^>]*FuldmagtHaverInformation/g
                  ),
                ]
              : [];
            if (dokFuldmagtHavere.length > 0) {
              h.fuldmagtsbestemmelser = dokFuldmagtHavere
                .map(([, info]) => {
                  const names = [
                    ...info.matchAll(/(?:LegalUnitName|PersonName|Navn)[^>]*>([^<]+)/g),
                  ];
                  return names
                    .map((m) => m[1].trim())
                    .filter((n) => n.length > 1)
                    .join(' ');
                })
                .filter((n) => n.length > 0);
            } else if (dokFuldmagtSamling) {
              h.fuldmagtsbestemmelser = [
                ...dokFuldmagtSamling.matchAll(/(?:LegalUnitName|PersonName|Navn)[^>]*>([^<]+)/g),
              ]
                .map((m) => m[1].trim())
                .filter((n) => n.length > 1);
            }
          }
        }
      } catch {
        /* ignore — detaljer er valgfrie */
      }
    });

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
      // Tillægstekst — saml alle Afsnit-elementer (kan være flere linjer)
      const tillaegsTekstAfsnit = [...entry.matchAll(/Afsnit[^>]*>([^<]{3,})/g)]
        .map((m) => m[1].trim())
        .filter((v) => v.length > 0);
      const tillaegsTekst = tillaegsTekstAfsnit.length > 0 ? tillaegsTekstAfsnit.join('\n') : null;
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

    // ── Berig servitutter med tillægstekst fra dokument-detaljer ──
    // Paralleliseret i batches af 5
    await batchParallel(
      servitutter.filter((s) => s.dokumentId),
      async (s) => {
        try {
          const dokRes = await tlFetch(`/dokaktuel/uuid/${s.dokumentId}`);
          if (dokRes.status === 200) {
            const dok = dokRes.body;
            const dokAfsnit = [...dok.matchAll(/Afsnit[^>]*>([^<]{3,})/g)]
              .map((m) => m[1].trim())
              .filter((v) => v.length > 0 && !v.match(/^[0-9a-f-]{36}$/));
            if (dokAfsnit.length > 0) {
              const dokTekst = dokAfsnit.join('\n');
              if (!s.tillaegsTekst || dokTekst.length > s.tillaegsTekst.length) {
                s.tillaegsTekst = dokTekst;
              }
            }
          }
        } catch {
          /* ignore — detaljer er valgfrie */
        }
      }
    );

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

    // ── Indskannede akter (pre-digitale — fra EjendomIndskannetAktSamling) ──
    // Ligger inde i ejdsummarisk XML; hvert element hedder DokumentFilnavnTekst.
    // Bemærk: aktNavn optræder gentagne gange (en gang per dokument der refererer til akten),
    // så vi deduplikerer.
    const indskannedeAkterNavne: string[] = [];
    const aktSamlingStart = xml.indexOf('EjendomIndskannetAktSamling>');
    const aktSamlingEnd = xml.indexOf('/EjendomIndskannetAktSamling>');
    if (aktSamlingStart !== -1 && aktSamlingEnd !== -1) {
      const aktBlock = xml.substring(aktSamlingStart, aktSamlingEnd);
      const aktMatches = [
        ...aktBlock.matchAll(
          /<(?:[a-zA-Z]+:)?DokumentFilnavnTekst>([^<]+)<\/(?:[a-zA-Z]+:)?DokumentFilnavnTekst>/g
        ),
      ];
      for (const [, navn] of aktMatches) {
        const trimmed = navn.trim();
        if (trimmed && !indskannedeAkterNavne.includes(trimmed)) {
          indskannedeAkterNavne.push(trimmed);
        }
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

    // Section-filtered response for incremental loading
    if (section === 'ejere') {
      return NextResponse.json(
        { ejere, tingbogsattest, fejl: null },
        {
          headers: { 'Cache-Control': 'public, s-maxage=3600' },
        }
      );
    }
    if (section === 'haeftelser') {
      return NextResponse.json(
        { haeftelser, bilagRefs, fejl: null },
        {
          headers: { 'Cache-Control': 'public, s-maxage=3600' },
        }
      );
    }
    if (section === 'servitutter') {
      // Hent servitutter fra hovedejendom hvis hovedBfe er angivet (ejerlejligheder)
      if (hovedBfe && /^\d+$/.test(hovedBfe)) {
        try {
          const hovedSearchRes = await tlFetch(
            `/ejendom/hovednoteringsnummer?hovednoteringsnummer=${hovedBfe}`
          );
          if (hovedSearchRes.status === 200) {
            const hovedData = JSON.parse(hovedSearchRes.body);
            const hovedItems = hovedData?.items ?? [];
            if (hovedItems.length > 0 && hovedItems[0].uuid !== uuid) {
              const hovedUuid = hovedItems[0].uuid;
              const hovedXmlRes = await tlFetch(`/ejdsummarisk/${hovedUuid}`);
              if (hovedXmlRes.status === 200) {
                const hovedXml = hovedXmlRes.body;
                const hovedServitutEntries = [
                  ...hovedXml.matchAll(
                    /<ns:ServitutSummarisk>([\s\S]*?)<\/ns:ServitutSummarisk>/g
                  ),
                ];
                for (const [, entry] of hovedServitutEntries) {
                  const type = entry.match(/ServitutType[^>]*>([^<]+)/)?.[1] ?? null;
                  const dato =
                    entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ?? null;
                  const tekst = entry.match(/ServitutTekstSummarisk[^>]*>([^<]+)/)?.[1] ?? null;
                  const prioritet = entry.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1] ?? null;
                  const dokumentId =
                    entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null;
                  // Marker som fra hovedejendom
                  servitutter.push({
                    type: type ?? '',
                    dato,
                    tekst,
                    prioritet: prioritet ? parseInt(prioritet, 10) : null,
                    dokumentId,
                    dokumentAlias: null,
                    tillaegsTekst: null,
                    indholdKoder: [],
                    paataleberettiget: null,
                    paataleberettigetCvr: null,
                    harBetydningForVaerdi: false,
                    tinglysningsafgift: null,
                    bilagRefs: [],
                    ogsaaLystPaa: null,
                    fraHovedejendom: true,
                  });
                }
              }
            }
          }
        } catch (err) {
          logger.warn('[tinglysning/summarisk] Hovedejendom servitut-hentning fejlede:', err);
        }
      }
      return NextResponse.json(
        { servitutter, indskannedeAkterNavne, fejl: null },
        {
          headers: { 'Cache-Control': 'public, s-maxage=3600' },
        }
      );
    }

    // Full response (default — backward compatible)
    return NextResponse.json(
      {
        ejere,
        haeftelser,
        servitutter,
        bilagRefs,
        indskannedeAkterNavne,
        tingbogsattest,
        fejl: null,
      },
      {
        headers: { 'Cache-Control': 'public, s-maxage=3600' },
      }
    );
  } catch (err) {
    // Log for server-side debugging, but never expose err.message to the client.
    logger.error('[tinglysning/summarisk] Fejl:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({
      ejere: [],
      haeftelser: [],
      servitutter: [],
      fejl: 'Ekstern API fejl',
    });
  }
}
