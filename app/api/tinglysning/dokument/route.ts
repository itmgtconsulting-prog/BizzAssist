/**
 * GET /api/tinglysning/dokument?uuid=XXXXX
 *
 * Henter et tinglysningsdokument som XML fra Tinglysning HTTP API,
 * konverterer det til en læsbar PDF med pdfkit, og returnerer PDF'en.
 *
 * @param uuid - Dokument UUID fra Tinglysning
 * @returns PDF-dokument med Content-Disposition header
 */

import { NextRequest, NextResponse } from 'next/server';
import https from 'https';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { tlFetch as tlFetchShared } from '@/app/lib/tlFetch';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Cert config — same pattern as app/lib/tlFetch.ts ──────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';

/** Loads PFX certificate from file path or base64 env var. */
function loadCert(): Buffer {
  if (CERT_B64) return Buffer.from(CERT_B64, 'base64');
  if (CERT_PATH) return fs.readFileSync(CERT_PATH);
  throw new Error('No Tinglysning certificate configured');
}

// ─── XML field labels (DA) ──────────────────────────────────────────────────

const _FIELD_LABELS: Record<string, string> = {
  DokumentAliasIdentifikator: 'Dokumentnummer',
  TinglysningsDato: 'Tinglysningsdato',
  BestemtFastEjendomNummer: 'BFE-nummer',
  Ejerlejlighedsnummer: 'Ejerlejlighed nr.',
  CadastralDistrictName: 'Ejerlav',
  Matrikelnummer: 'Matrikelnummer',
  PrioritetNummer: 'Prioritet',
  HaeftelseType: 'Hæftelsestype',
  ServitutType: 'Servituttype',
  AdkomstType: 'Adkomsttype',
  BeloebVaerdi: 'Beløb',
  ValutaKode: 'Valuta',
  HaeftelseRentePaalydendeSats: 'Rente (pålydende)',
  HaeftelseLaantypeKode: 'Låntype',
  HaeftelseLoebetidMaaneder: 'Løbetid (måneder)',
  HaeftelseTilbagebetalingsmaadeKode: 'Tilbagebetalingsmåde',
  HaeftelseAfdragsfrihedIndikator: 'Afdragsfrihed',
  HaeftelseIndfrielseKonverterbar: 'Konverterbar',
  HaeftelsePantebrevFormularLovpligtigKode: 'Pantebrevformular',
  HaeftelseOprykningsretIndikator: 'Oprykningsret',
  HaeftelseKlausulRektaIndikator: 'Rektaklausul',
  HaeftelseRetsforfoelgningsforbudIndikator: 'Retsforfølgningsforbud',
  PersonName: 'Navn',
  LegalUnitName: 'Virksomhed',
  CVRnumberIdentifier: 'CVR-nummer',
  PersonCivilRegistrationIdentifier: 'CPR (maskeret)',
  RolleTypeIdentifikator: 'Rolle',
  EmailAddressIdentifier: 'Email',
  TelephoneNumberIdentifier: 'Telefon',
  SkoedeOvertagelsesDato: 'Overtagelsesdato',
  KoebsaftaleDato: 'Købsaftaledato',
  KontantKoebesum: 'Købesum (kontant)',
  IAltKoebesum: 'Købesum (i alt)',
  Afgiftsbeloeb: 'Tinglysningsafgift',
  TinglysningAfgiftBetalt: 'Tinglysningsafgift',
  ServitutTekstSummarisk: 'Servituttekst',
  Afsnit: 'Tekst',
  Overskrift: 'Overskrift',
  OgsaaLystPaaAntal: 'Også lyst på antal ejendomme',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Henter dokument-XML fra Tinglysning. Kaster fejl ved ikke-200. */
async function tlFetch(urlPath: string): Promise<string> {
  const result = await tlFetchShared(urlPath, { accept: 'application/xml' });
  if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
  return result.body;
}

/** Parser XML og udtrækker alle felter med læsbare labels */
/**
 * Generisk XML-feltudtrækker — bruges som fallback når specifikke parsers
 * ikke genkender dokumentstrukturen (f.eks. anden hæftelse, servitut).
 * Stripper namespace-præfikser og udtrækker alle leaf text nodes.
 */
function genericXmlExtract(xml: string): { label: string; value: string }[] {
  const cleaned = xml
    .replace(/<\/?[a-zA-Z]+:/g, '<') // strip namespace prefixes
    .replace(/\s[a-zA-Z]+:([a-zA-Z])/g, ' $1'); // strip ns: in attributes
  const fields: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  const skipTags = new Set([
    'Body',
    'Envelope',
    'Header',
    'Fault',
    'faultcode',
    'faultstring',
    'GetResult',
    'HentResultat',
    'Return',
    'Result',
  ]);
  for (const m of cleaned.matchAll(/<(\w+)[^>]*>([^<]{2,500})<\/\1>/g)) {
    const tag = m[1];
    const val = m[2].trim();
    if (!val || val.length < 2) continue;
    if (skipTags.has(tag)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(val)) continue; // skip UUIDs
    const key = `${tag}:${val}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // CamelCase → "Camel Case"
    const label = tag.replace(/([A-Z])/g, ' $1').trim();
    fields.push({ label, value: val });
  }
  return fields;
}

function parseXmlToSections(
  xml: string
): { title: string; fields: { label: string; value: string }[] }[] {
  const sections: { title: string; fields: { label: string; value: string }[] }[] = [];

  // Dokument-type — prøv både med og uden namespace-præfiks
  const docType =
    xml.match(/HaeftelseType[^>]*>([^<]+)/)?.[1] ??
    xml.match(/HaeftelseTypeKode[^>]*>([^<]+)/)?.[1] ??
    xml.match(/AdkomstType[^>]*>([^<]+)/)?.[1] ??
    xml.match(/ServitutType[^>]*>([^<]+)/)?.[1] ??
    xml.match(/DokumentType[^>]*>([^<]+)/)?.[1] ??
    'Tinglysningsdokument';

  const docTypeMap: Record<string, string> = {
    realkreditpantebrev: 'Realkreditpantebrev',
    ejerpantebrev: 'Ejerpantebrev',
    anden: 'Anden hæftelse',
    skoede: 'Skøde',
    andenServitut: 'Servitut',
  };

  const title = docTypeMap[docType] ?? docType;

  // Stamdata
  const stamdata: { label: string; value: string }[] = [];
  const alias = xml.match(/DokumentAliasIdentifikator[^>]*>([^<]+)/)?.[1];
  if (alias) stamdata.push({ label: 'Dokumentnummer', value: alias });
  const tlDato = xml.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1];
  if (tlDato)
    stamdata.push({
      label: 'Tinglysningsdato',
      value: new Date(tlDato.split('+')[0]).toLocaleDateString('da-DK', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    });
  const bfe = xml.match(/BestemtFastEjendomNummer[^>]*>([^<]+)/)?.[1];
  if (bfe) stamdata.push({ label: 'BFE-nummer', value: bfe });
  const ejlNr = xml.match(/Ejerlejlighedsnummer[^>]*>([^<]+)/)?.[1];
  if (ejlNr) stamdata.push({ label: 'Ejerlejlighed nr.', value: ejlNr });
  const matrikel = xml.match(/CadastralDistrictName[^>]*>([^<]+)/)?.[1];
  const matNr = xml.match(/Matrikelnummer[^>]*>([^<]+)/)?.[1];
  if (matrikel && matNr) stamdata.push({ label: 'Matrikel', value: `${matNr}, ${matrikel}` });
  const prioritet = xml.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1];
  if (prioritet) stamdata.push({ label: 'Prioritet', value: prioritet });
  if (stamdata.length > 0) sections.push({ title: 'Stamdata', fields: stamdata });

  // Beløb og vilkår
  const beloeb: { label: string; value: string }[] = [];
  const beloebVal = xml.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1];
  const valuta = xml.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? 'DKK';
  if (beloebVal)
    beloeb.push({
      label: 'Beløb',
      value: `${parseInt(beloebVal, 10).toLocaleString('da-DK')} ${valuta}`,
    });
  const rente = xml.match(/HaeftelseRentePaalydendeSats[^>]*>([^<]+)/)?.[1];
  if (rente) beloeb.push({ label: 'Rente', value: `${parseFloat(rente).toFixed(4)}%` });
  const loebetid = xml.match(/HaeftelseLoebetidMaaneder[^>]*>([^<]+)/)?.[1];
  if (loebetid) beloeb.push({ label: 'Løbetid', value: `${loebetid} måneder` });
  const laantype = xml.match(/HaeftelseLaantypeKode[^>]*>([^<]+)/)?.[1];
  if (laantype) beloeb.push({ label: 'Låntype', value: laantype });
  const formular = xml.match(/HaeftelsePantebrevFormularLovpligtigKode[^>]*>([^<]+)/)?.[1];
  if (formular) beloeb.push({ label: 'Pantebrevformular', value: formular });
  const afgift = xml.match(/(?:Afgiftsbeloeb|TinglysningAfgiftBetalt)[^>]*>(\d+)/)?.[1];
  if (afgift)
    beloeb.push({
      label: 'Tinglysningsafgift',
      value: `${parseInt(afgift, 10).toLocaleString('da-DK')} DKK`,
    });
  // Købesum
  const kontant = xml.match(/KontantKoebesum[^>]*>(\d+)/)?.[1];
  if (kontant)
    beloeb.push({
      label: 'Købesum (kontant)',
      value: `${parseInt(kontant, 10).toLocaleString('da-DK')} DKK`,
    });
  const iAlt = xml.match(/IAltKoebesum[^>]*>(\d+)/)?.[1];
  if (iAlt)
    beloeb.push({
      label: 'Købesum (i alt)',
      value: `${parseInt(iAlt, 10).toLocaleString('da-DK')} DKK`,
    });
  const overtagelse = xml.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1];
  if (overtagelse)
    beloeb.push({
      label: 'Overtagelsesdato',
      value: new Date(overtagelse.split('+')[0]).toLocaleDateString('da-DK', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    });
  if (beloeb.length > 0) sections.push({ title: 'Beløb og vilkår', fields: beloeb });

  // Parter (kreditor, debitor, anmelder)
  const _rolleEntries = [...xml.matchAll(/Rolle[^>]*>([\s\S]*?)<\/[^>]*Rolle/g)];
  const parter: { label: string; value: string }[] = [];
  // Simpel extraktion af alle navne + roller
  const allNames = [...xml.matchAll(/(?:PersonName|LegalUnitName|Navn)[^>]*>([^<]+)/g)];
  const allRoles = [...xml.matchAll(/RolleTypeIdentifikator[^>]*>([^<]+)/g)];
  const allCvrs = [...xml.matchAll(/CVRnumberIdentifier[^>]*>(\d+)/g)];
  const allEmails = [...xml.matchAll(/EmailAddressIdentifier[^>]*>([^<]+)/g)];

  // Deduplicate names
  const seenNames = new Set<string>();
  for (let i = 0; i < allNames.length; i++) {
    const name = allNames[i][1].trim();
    if (seenNames.has(name) || name.length < 3) continue;
    seenNames.add(name);
    parter.push({ label: 'Navn', value: name });
  }
  for (const m of allCvrs) parter.push({ label: 'CVR', value: m[1] });
  for (const m of allRoles) parter.push({ label: 'Rolle', value: m[1] });
  for (const m of allEmails) parter.push({ label: 'Email', value: m[1] });
  if (parter.length > 0) sections.push({ title: 'Parter', fields: parter });

  // Tekst
  const tekster: { label: string; value: string }[] = [];
  const afsnit = [...xml.matchAll(/Afsnit[^>]*>([^<]{5,})/g)];
  for (const m of afsnit) {
    const txt = m[1].trim();
    if (txt.length > 4 && !txt.match(/^[0-9a-f-]{36}$/)) {
      tekster.push({ label: 'Tekst', value: txt });
    }
  }
  if (tekster.length > 0) sections.push({ title: 'Dokumenttekst', fields: tekster });

  // Fallback: hvis ingen specifikke sektioner matches, brug generisk XML-udtræk
  if (sections.length === 0) {
    const fallbackFields = genericXmlExtract(xml);
    if (fallbackFields.length > 0) {
      sections.push({ title: 'Dokumentdata', fields: fallbackFields });
    }
  }

  return [{ title, fields: [] }, ...sections];
}

/**
 * Parser ejdsummarisk XML til sektioner til brug i tingbogsattest-PDF.
 * Udtrækker adkomster, hæftelser, servitutter og matrikeldata.
 */
function parseTingbogsattestXml(
  xml: string
): { title: string; fields: { label: string; value: string }[] }[] {
  const sections: { title: string; fields: { label: string; value: string }[] }[] = [];

  // Stamdata
  const stamdata: { label: string; value: string }[] = [];
  const bfeNr = xml.match(/BestemtFastEjendomNummer[^>]*>([^<]+)/)?.[1];
  if (bfeNr) stamdata.push({ label: 'BFE-nummer', value: bfeNr });
  const ejlNr = xml.match(/Ejerlejlighedsnummer[^>]*>([^<]+)/)?.[1];
  if (ejlNr) stamdata.push({ label: 'Ejerlejlighed nr.', value: ejlNr });
  const hovedNotering = xml.match(/HovedNotering[^>]*>([^<]+)/)?.[1];
  if (hovedNotering) stamdata.push({ label: 'Hovednotering', value: hovedNotering });
  const ftTaeller = xml.match(/<ns7:Taeller>([^<]+)/)?.[1];
  const ftNaevner = xml.match(/<ns7:Naevner>([^<]+)/)?.[1];
  if (ftTaeller && ftNaevner)
    stamdata.push({ label: 'Fordelingstal', value: `${ftTaeller} / ${ftNaevner}` });
  if (stamdata.length > 0) sections.push({ title: 'Ejendomsoplysninger', fields: stamdata });

  // Matrikler
  const matrikler: { label: string; value: string }[] = [];
  const matEntries = [...xml.matchAll(/MatrikelStruktur>([\s\S]*?)<\/ns1:MatrikelStruktur/g)];
  for (const [, m] of matEntries) {
    const dist = m.match(/CadastralDistrictName[^>]*>([^<]+)/)?.[1] ?? '';
    const distId = m.match(/CadastralDistrictIdentifier[^>]*>([^<]+)/)?.[1] ?? '';
    const matNr = m.match(/Matrikelnummer[^>]*>([^<]+)/)?.[1] ?? '';
    const areal = m.match(/SpecificParcelAreaMeasure[^>]*>([^<]+)/)?.[1];
    matrikler.push({
      label: 'Matrikel',
      value: `${distId} ${dist}, ${matNr}${areal ? ` (${parseInt(areal, 10).toLocaleString('da-DK')} m²)` : ''}`,
    });
  }
  if (matrikler.length > 0) sections.push({ title: 'Matrikler', fields: matrikler });

  // Adkomster (ejere)
  const adkomster: { label: string; value: string }[] = [];
  const adkomstEntries = [...xml.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/ns:AdkomstSummarisk/g)];
  for (const [, entry] of adkomstEntries) {
    const type = entry.match(/AdkomstType[^>]*>([^<]+)/)?.[1] ?? '';
    const names = [...entry.matchAll(/<[^\/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)]
      .map((m) => m[1])
      .filter((n) => n.length > 1);
    const navn = names.join(' ').trim();
    const cvr = entry.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1];
    const overtagelse = entry.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1];
    const kontant = entry.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1];
    const iAlt = entry.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1];
    const taeller = entry.match(/Taeller[^>]*>([^<]+)/)?.[1];
    const naevner = entry.match(/Naevner[^>]*>([^<]+)/)?.[1];

    let line = navn;
    if (cvr) line += ` (CVR ${cvr})`;
    if (taeller && naevner)
      line += ` — andel: ${Math.round((parseInt(taeller, 10) / parseInt(naevner, 10)) * 100)}%`;
    if (overtagelse)
      line += ` — overtaget ${new Date(overtagelse.split('+')[0]).toLocaleDateString('da-DK')}`;
    const pris = kontant ?? iAlt;
    if (pris) line += ` — ${parseInt(pris, 10).toLocaleString('da-DK')} DKK`;

    adkomster.push({ label: type || 'Adkomst', value: line });
  }
  if (adkomster.length > 0) sections.push({ title: 'Adkomster', fields: adkomster });

  // Hæftelser
  const haeftelser: { label: string; value: string }[] = [];
  const haeftEntries = [
    ...xml.matchAll(/<ns:HaeftelseSummarisk>([\s\S]*?)<\/ns:HaeftelseSummarisk>/g),
  ];
  for (const [, entry] of haeftEntries) {
    const type = entry.match(/HaeftelseType[^>]*>([^<]+)/)?.[1] ?? 'hæftelse';
    const kreditor =
      entry.match(/LegalUnitName[^>]*>([^<]+)/)?.[1] ??
      entry.match(/PersonName[^>]*>([^<]+)/)?.[1] ??
      '';
    const beloeb = entry.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1];
    const valuta = entry.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? 'DKK';
    const rente = entry.match(/HaeftelseRentePaalydendeSats[^>]*>([^<]+)/)?.[1];
    const dato = entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1];

    let line = kreditor;
    if (beloeb) line += ` — ${parseInt(beloeb, 10).toLocaleString('da-DK')} ${valuta}`;
    if (rente) line += ` — ${parseFloat(rente)}%`;
    if (dato) line += ` — tinglyst ${new Date(dato.split('T')[0]).toLocaleDateString('da-DK')}`;

    haeftelser.push({ label: type, value: line });
  }
  if (haeftelser.length > 0) sections.push({ title: 'Hæftelser', fields: haeftelser });

  // Servitutter
  const servitutter: { label: string; value: string }[] = [];
  const servEntries = [
    ...xml.matchAll(/<ns:ServitutSummarisk>([\s\S]*?)<\/ns:ServitutSummarisk>/g),
  ];
  for (const [, entry] of servEntries) {
    const type = entry.match(/ServitutType[^>]*>([^<]+)/)?.[1] ?? 'servitut';
    const tekst = entry.match(/ServitutTekstSummarisk[^>]*>([^<]+)/)?.[1] ?? '';
    const dato = entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1];

    let line = tekst;
    if (dato) line += ` — tinglyst ${new Date(dato.split('T')[0]).toLocaleDateString('da-DK')}`;

    servitutter.push({ label: type, value: line });
  }
  if (servitutter.length > 0) sections.push({ title: 'Servitutter', fields: servitutter });

  // Noteringer
  const noteringer: { label: string; value: string }[] = [];
  const notEntries = [
    ...xml.matchAll(/MatrikelNoteringTekst>([\s\S]*?)<\/ns7:MatrikelNoteringTekst/g),
  ];
  for (const [, n] of notEntries) {
    const tekst = n.match(/Afsnit[^>]*>([^<]+)/)?.[1] ?? '';
    if (tekst) noteringer.push({ label: 'Notering', value: tekst });
  }
  if (noteringer.length > 0) sections.push({ title: 'Noteringer', fields: noteringer });

  return sections;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const uuid = req.nextUrl.searchParams.get('uuid');
  const bilagId = req.nextUrl.searchParams.get('bilag');

  if (!uuid && !bilagId)
    return NextResponse.json({ error: 'uuid eller bilag er påkrævet' }, { status: 400 });
  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD)
    return NextResponse.json({ error: 'Certifikat ikke konfigureret' }, { status: 503 });

  // ── Original PDF bilag — hent direkte fra Tinglysning ──
  if (bilagId) {
    try {
      const pfx = loadCert();
      const url = new URL(TL_BASE + `/tinglysning/ssl/bilag/${bilagId}`);
      const pdfData = await new Promise<Buffer>((resolve, reject) => {
        const r = https.request(
          {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'GET',
            pfx,
            passphrase: CERT_PASSWORD,
            rejectUnauthorized: false,
            timeout: 55000, // Turbopack dev + test mTLS
            headers: { Accept: 'application/pdf' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () =>
              res.statusCode === 200
                ? resolve(Buffer.concat(chunks))
                : reject(new Error(`HTTP ${res.statusCode}`))
            );
          }
        );
        r.on('error', reject);
        r.on('timeout', () => {
          r.destroy();
          reject(new Error('Timeout'));
        });
        r.end();
      });

      return new NextResponse(new Uint8Array(pdfData), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="tinglysning-bilag-${bilagId.slice(0, 8)}.pdf"`,
        },
      });
    } catch (err) {
      logger.error('[tinglysning/bilag] Fejl:', err instanceof Error ? err.message : String(err));
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }
  }

  // ── Tingbogsattest PDF ──
  const type = req.nextUrl.searchParams.get('type');
  if (type === 'tingbogsattest' && uuid) {
    try {
      // Forsøg at hente officiel tingbogsattest-PDF direkte fra Tinglysning API
      // Prøver kendte endpoint-stier i prioriteret rækkefølge
      const pfx = loadCert();

      /**
       * Prøver alle kendte Tinglysning REST API endpoint-stier for tingbogsattest-PDF.
       * Tinglysning.dk tilbyder tingbogsattest som PDF via mTLS certifikat.
       */
      const candidatePaths = [
        `/tingbogsattest/ejendom/uuid/${uuid}`,
        `/tingbogsattest/ejendom/${uuid}`,
        `/tingbogsattest/${uuid}`,
        `/ejdsummarisk/${uuid}`,
      ];

      /** Accepter både PDF og HTML — nogle endpoints returnerer HTML med PDF-link */
      const acceptHeaders = ['application/pdf', 'application/pdf, application/octet-stream, */*'];

      let officialPdf: Buffer | null = null;

      for (const candidatePath of candidatePaths) {
        for (const accept of acceptHeaders) {
          const result = await new Promise<{
            pdf: Buffer | null;
            status: number;
            contentType: string;
          }>((resolve) => {
            const url = new URL(TL_BASE + '/tinglysning/ssl' + candidatePath);
            const r = https.request(
              {
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: 'GET',
                pfx,
                passphrase: CERT_PASSWORD,
                rejectUnauthorized: false,
                timeout: 20000,
                headers: { Accept: accept },
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (d) => chunks.push(d));
                res.on('end', () => {
                  const buf = Buffer.concat(chunks);
                  resolve({
                    pdf: buf,
                    status: res.statusCode ?? 0,
                    contentType: res.headers['content-type'] ?? '',
                  });
                });
              }
            );
            r.on('error', (err) => {
              logger.log(`[tingbogsattest] Fejl på ${candidatePath}: ${err.message}`);
              resolve({ pdf: null, status: 0, contentType: '' });
            });
            r.on('timeout', () => {
              r.destroy();
              resolve({ pdf: null, status: 0, contentType: '' });
            });
            r.end();
          });

          logger.log(
            `[tingbogsattest] ${candidatePath} (Accept: ${accept}) → HTTP ${result.status}, Content-Type: ${result.contentType}, ${result.pdf?.length ?? 0} bytes, starts: ${result.pdf?.subarray(0, 10).toString() ?? 'null'}`
          );

          // Verificer at svaret er en ægte PDF (starter med %PDF)
          if (
            result.status === 200 &&
            result.pdf &&
            result.pdf.length > 100 &&
            result.pdf.subarray(0, 5).toString() === '%PDF-'
          ) {
            officialPdf = result.pdf;
            logger.log(
              `[tingbogsattest] ✓ Officiel PDF hentet fra ${candidatePath} (${result.pdf.length} bytes)`
            );
            break;
          }
        }
        if (officialPdf) break;
      }

      if (officialPdf) {
        return new NextResponse(new Uint8Array(officialPdf), {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="tingbogsattest-${uuid.slice(0, 8)}.pdf"`,
          },
        });
      }

      // Fallback: generer PDF fra ejdsummarisk XML-data
      logger.log('[tingbogsattest] Officiel PDF ikke tilgængelig — genererer fra XML');
      const xml = await tlFetch(`/ejdsummarisk/${uuid}`);
      const sections = parseTingbogsattestXml(xml);
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: { Title: 'Tingbogsattest', Author: 'BizzAssist' },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));

      doc.fontSize(8).fillColor('#94a3b8').text('BizzAssist — Tingbogsattest', 50, 30);
      doc.fontSize(8).text(
        new Date().toLocaleDateString('da-DK', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }),
        50,
        30,
        { align: 'right' }
      );

      doc.moveDown(1.5);
      doc.fontSize(18).fillColor('#1e293b').text('Tingbogsattest', { align: 'center' });
      doc.moveDown(0.3);
      const bfeNr = xml.match(/BestemtFastEjendomNummer[^>]*>([^<]+)/)?.[1];
      if (bfeNr)
        doc.fontSize(9).fillColor('#64748b').text(`BFE-nummer: ${bfeNr}`, { align: 'center' });
      doc.moveDown(1);

      for (const section of sections) {
        doc.fontSize(12).fillColor('#2563eb').text(section.title);
        doc.moveDown(0.3);
        doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.4);
        for (const field of section.fields) {
          if (doc.y > 750) doc.addPage();
          if (field.value.length > 80) {
            doc
              .fontSize(8)
              .fillColor('#64748b')
              .text(field.label + ':', 50);
            doc.fontSize(9).fillColor('#1e293b').text(field.value, 50, undefined, { width: 495 });
          } else {
            const y = doc.y;
            doc
              .fontSize(9)
              .fillColor('#64748b')
              .text(field.label + ':', 50, y, { width: 160 });
            doc.fontSize(9).fillColor('#1e293b').text(field.value, 220, y, { width: 325 });
          }
          doc.moveDown(0.2);
        }
        doc.moveDown(0.5);
      }

      doc
        .fontSize(7)
        .fillColor('#94a3b8')
        .text('Genereret af BizzAssist — Pecunia IT ApS — CVR 44718502', 50, 780, {
          align: 'center',
        });
      doc.end();

      const pdfBuffer = await new Promise<Buffer>((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
      });

      return new NextResponse(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="tingbogsattest-${bfeNr ?? uuid}.pdf"`,
        },
      });
    } catch (err) {
      logger.error('[tinglysning/attest] Fejl:', err instanceof Error ? err.message : String(err));
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }
  }

  // ── Genereret PDF fra XML-dokument ──
  try {
    const xml = await tlFetch(`/dokaktuel/uuid/${uuid}`);

    // ── Detekter pre-digitale dokumenter (ikke tinglyst digitalt) ──
    // Tinglysning returnerer en XML-fejlbesked for dokumenter der eksisterer
    // i tingbogen men ikke er digitalt indleveret (typisk pre-2009 servitutter).
    const isPreDigital =
      xml.includes('ikke tinglyst digitalt') ||
      xml.includes('ikke digitalt tinglyst') ||
      xml.includes('kan ikke vises her') ||
      xml.includes('forespørgsel i tingbøgerne');

    // NOTE (testet 2026-04-09): /hentakt, /dokument, /akt, /bilag returnerer alle 404
    // for pre-digitale dokumenter via mTLS HTTP API. Scannede PDFs er kun tilgængelige
    // via webportalen (/rest/ + MitID-session). Afventer REST API fra 1. maj 2026.

    if (isPreDigital) {
      // Generér en informativ PDF i stedet for at vise rå XML-indhold
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: { Title: 'Tinglysningsdokument', Author: 'BizzAssist' },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));

      doc.fontSize(8).fillColor('#94a3b8').text('BizzAssist — Tinglysningsdokument', 50, 30);
      doc.fontSize(8).text(
        new Date().toLocaleDateString('da-DK', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        }),
        50,
        30,
        { align: 'right' }
      );
      doc.moveDown(1.5);
      doc.fontSize(18).fillColor('#1e293b').text('Tinglysningsdokument', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor('#64748b').text(`Dokument-ID: ${uuid}`, { align: 'center' });
      doc.moveDown(2);

      // Infobesked
      doc.fontSize(12).fillColor('#2563eb').text('Dokumentet er ikke digitalt tilgængeligt');
      doc.moveDown(0.3);
      doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.6);
      doc
        .fontSize(10)
        .fillColor('#1e293b')
        .text(
          'Dette dokument er registreret i tingbogen, men er ikke tinglyst digitalt og kan derfor ikke hentes via Tinglysnings API.',
          { width: 495 }
        );
      doc.moveDown(0.6);
      doc
        .fontSize(10)
        .fillColor('#475569')
        .text(
          'Dokumentet stammer sandsynligvis fra før den elektroniske tinglysning blev obligatorisk (ca. 2009), og er ikke blevet digitaliseret i Tinglysningens bilagsbank.',
          { width: 495 }
        );
      doc.moveDown(1);
      doc.fontSize(10).fillColor('#1e293b').text('Hvad kan du gøre?', { underline: true });
      doc.moveDown(0.4);
      doc
        .fontSize(10)
        .fillColor('#475569')
        .list(
          [
            'Søg dokumentet på tinglysning.dk under "Søg i tingbogen"',
            'Kontakt Tinglysningsretten for at få en kopi af det fysiske dokument',
            "Fra 1. maj 2026 vil REST API'et potentielt give adgang til ældre tinglyste dokumenter",
          ],
          { width: 495, bulletRadius: 2, textIndent: 15 }
        );
      doc.moveDown(1.5);
      doc
        .fontSize(8)
        .fillColor('#94a3b8')
        .text('Dokument-UUID: ' + uuid, { width: 495 });

      doc
        .fontSize(7)
        .fillColor('#94a3b8')
        .text('Genereret af BizzAssist — Pecunia IT ApS — CVR 44718502', 50, 780, {
          align: 'center',
        });
      doc.end();

      const pdfBuffer = await new Promise<Buffer>((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
      });

      return new NextResponse(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="tinglysning-${uuid?.slice(0, 8)}.pdf"`,
        },
      });
    }

    // Parse XML til sektioner
    const sections = parseXmlToSections(xml);
    const docTitle = sections[0]?.title ?? 'Tinglysningsdokument';

    // Generer PDF med pdfkit
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: docTitle, Author: 'BizzAssist' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    // Header
    doc.fontSize(8).fillColor('#94a3b8').text('BizzAssist — Tinglysningsdokument', 50, 30);
    doc
      .fontSize(8)
      .text(
        new Date().toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' }),
        50,
        30,
        { align: 'right' }
      );

    // Titel
    doc.moveDown(1.5);
    doc.fontSize(18).fillColor('#1e293b').text(docTitle, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#64748b').text(`Dokument-ID: ${uuid}`, { align: 'center' });
    doc.moveDown(1);

    // Sektioner
    for (const section of sections.slice(1)) {
      // Sektion-header
      doc.fontSize(12).fillColor('#2563eb').text(section.title);
      doc.moveDown(0.3);
      doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.4);

      // Felter
      for (const field of section.fields) {
        let y = doc.y;
        if (y > 750) {
          doc.addPage();
          y = doc.y; // reset y efter sideskift — ellers renderes content usynligt under siden
        }

        if (field.label === 'Tekst' && field.value.length > 80) {
          // Længere tekst — fuld bredde
          doc
            .fontSize(8)
            .fillColor('#64748b')
            .text(field.label + ':', 50);
          doc.fontSize(9).fillColor('#1e293b').text(field.value, 50, undefined, { width: 495 });
          doc.moveDown(0.3);
        } else {
          // Label : Value layout
          doc
            .fontSize(9)
            .fillColor('#64748b')
            .text(field.label + ':', 50, y, { width: 160 });
          doc.fontSize(9).fillColor('#1e293b').text(field.value, 220, y, { width: 325 });
          doc.moveDown(0.2);
        }
      }
      doc.moveDown(0.5);
    }

    // Footer
    doc
      .fontSize(7)
      .fillColor('#94a3b8')
      .text('Genereret af BizzAssist — Pecunia IT ApS — CVR 44718502', 50, 780, {
        align: 'center',
      });

    doc.end();

    // Vent på at PDF er færdig
    const pdfBuffer = await new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    const alias = xml.match(/DokumentAliasIdentifikator[^>]*>([^<]+)/)?.[1] ?? uuid;
    const filename = `tinglysning-${alias}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
      },
    });
  } catch (err) {
    logger.error('[tinglysning/dokument] Fejl:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
