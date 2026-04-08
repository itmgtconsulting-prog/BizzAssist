/**
 * GET /api/tinglysning/personbog?cvr=12345678
 *
 * Henter personbogsdata (virksomhedspant, løsørepant, fordringspant, ejendomsforbehold)
 * for en virksomhed via Tinglysningsrettens HTTP API.
 * Bruger 2-vejs SSL med OCES systemcertifikat (NemID/MitID).
 *
 * @param cvr - CVR-nummer (8 cifre)
 * @returns PersonbogData med hæftelser fra Personbogen
 */

import { NextRequest, NextResponse } from 'next/server';
import https from 'https';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PersonbogHaeftelse {
  /** Hæftelsestype: virksomhedspant, loesoerepant, fordringspant, ejendomsforbehold */
  type: string;
  /** Omfang af virksomhedspant (varelager, driftsinventar, fordringer, immaterielle_rettigheder) */
  pantTyper: string[];
  /** Kreditors navn */
  kreditor: string | null;
  /** Kreditors CVR-nummer */
  kreditorCvr: string | null;
  /** Debitornavne */
  debitorer: string[];
  /** Debitor CVR-numre */
  debitorCvr: string[];
  /** Hovedstol i hele kr. */
  hovedstol: number | null;
  /** Valutakode */
  valuta: string;
  /** Rentesats i % */
  rente: number | null;
  /** "Fast" eller "Variabel" */
  renteType: string | null;
  /** Registreringsdato (ISO) */
  registreringsdato: string | null;
  /** Tinglysningsdato (ISO) */
  tinglysningsdato: string | null;
  /** Tinglysningsafgift i kr. */
  tinglysningsafgift: number | null;
  /** Prioritetsnummer */
  prioritet: number | null;
  /** Dokument-UUID til PDF-download */
  dokumentId: string | null;
  /** Dokumentalias (menneskeligt læsbart ID) */
  dokumentAlias: string | null;
  /** Anmelders navn */
  anmelderNavn: string | null;
  /** Anmelders CVR */
  anmelderCvr: string | null;
  /** Løbetid / udløbsdato */
  loebetid: string | null;
  /** Lånevilkår-beskrivelse */
  vilkaar: string | null;
}

export interface PersonbogData {
  /** CVR-nummer */
  cvr: string;
  /** Personbog-UUID (til videre opslag) */
  uuid: string | null;
  /** Alle hæftelser registreret i Personbogen */
  haeftelser: PersonbogHaeftelse[];
  /** Sandt hvis test-miljø fallback blev brugt */
  testFallback?: boolean;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Laver HTTPS request med client-certifikat (mTLS).
 * Personbogen bruger /tinglysning/unsecuressl/ prefix — ikke /tinglysning/ssl/.
 * Se http_api_beskrivelse v1.12, afsnit 4.4.
 *
 * @param urlPath - Sti relativt til /tinglysning/unsecuressl/ (f.eks. '/soegpersonbogcvr?cvr=...')
 */
function tlFetch(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    if (CERT_B64) {
      pfx = Buffer.from(CERT_B64, 'base64');
    } else {
      const certAbsPath = path.resolve(/*turbopackIgnore: true*/ CERT_PATH);
      if (!fs.existsSync(certAbsPath)) {
        reject(new Error('Certifikat ikke fundet'));
        return;
      }
      pfx = fs.readFileSync(certAbsPath);
    }
    const url = new URL(TL_BASE + '/tinglysning/unsecuressl' + urlPath);

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
        headers: { Accept: 'application/json, application/xml, */*' },
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

/**
 * Laver HTTPS request via /tinglysning/ssl/ prefix — bruges til dokument-opslag
 * (dokaktuel bruger ssl-stien ligesom ejendomssiden).
 */
function tlFetchSsl(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    if (CERT_B64) {
      pfx = Buffer.from(CERT_B64, 'base64');
    } else {
      const certAbsPath = path.resolve(/*turbopackIgnore: true*/ CERT_PATH);
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
        headers: { Accept: 'application/xml, */*' },
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

// ─── XML Parsers ────────────────────────────────────────────────────────────

/**
 * Parser personbog-summarisk XML og udtrækker hæftelser.
 *
 * Personbogens XML-struktur bruger samme navnerum som Tingbogen:
 *   - HaeftelseSummarisk blokke med type, beløb, kreditor, debitor
 *   - VirksomhedspantOmfang med undertyper (varelager, driftsinventar osv.)
 *
 * @param xml - Rå XML fra personsummarisk endpoint
 * @returns Array af PersonbogHaeftelse
 */
function parsePersonbogXml(xml: string): PersonbogHaeftelse[] {
  const haeftelser: PersonbogHaeftelse[] = [];

  // Find alle hæftelse-blokke — personbogen bruger samme HaeftelseSummarisk som tingbogen
  const entries = [
    ...xml.matchAll(
      /<(?:ns:)?(?:Personbogs)?[Hh]aeftelse(?:Summarisk)?>([\s\S]*?)<\/(?:ns:)?(?:Personbogs)?[Hh]aeftelse(?:Summarisk)?>/g
    ),
  ];

  for (const [, entry] of entries) {
    // Type — fra LoesoereHaeftelseTypeSummariskTekst eller HaeftelsePantebrevFormularLovpligtigKode
    const rawType =
      entry.match(/LoesoereHaeftelseTypeSummariskTekst[^>]*>([^<]+)/)?.[1] ??
      entry.match(/HaeftelsePantebrevFormularLovpligtigKode[^>]*>([^<]+)/)?.[1] ??
      entry.match(/(?:Personbogs)?[Hh]aeftelse[Tt]ype[^>]*>([^<]+)/)?.[1] ??
      'ukendt';
    const type = normalizeType(rawType);

    // Omfang (virksomhedspant undertyper)
    const pantTyper: string[] = [];
    const omfangEntries = [...entry.matchAll(/VirksomhedspantOmfang[^>]*>([^<]+)/g)];
    for (const [, omfang] of omfangEntries) {
      pantTyper.push(omfang.trim());
    }
    // Fallback: tjek for specifikke omfang-tags
    if (pantTyper.length === 0) {
      if (entry.includes('Varelager')) pantTyper.push('varelager');
      if (entry.includes('Driftsinventar') || entry.includes('Driftsmateriel'))
        pantTyper.push('driftsinventar');
      if (entry.includes('Fordringer')) pantTyper.push('fordringer');
      if (entry.includes('ImmaterielleRettigheder') || entry.includes('Immaterielle'))
        pantTyper.push('immaterielle_rettigheder');
    }

    // Kreditor — fra KreditorInformationSamling (ikke generel name-match)
    const kreditorSamling =
      entry.match(/KreditorInformationSamling>([\s\S]*?)<\/[^>]*KreditorInformationSamling/)?.[1] ??
      '';
    const kreditor =
      kreditorSamling.match(/LegalUnitName[^>]*>([^<]+)/)?.[1] ??
      kreditorSamling.match(/PersonName[^>]*>([^<]+)/)?.[1] ??
      null;
    const kreditorCvr = kreditorSamling.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;

    // Hovedstol
    const beloebStr = entry.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1];
    const hovedstol = beloebStr ? parseInt(beloebStr, 10) : null;
    const valuta = entry.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? 'DKK';

    // Datoer
    const tinglysningsdato =
      entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? null;
    const registreringsdato =
      entry.match(/RegistreringsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? tinglysningsdato;

    // Prioritet
    const prioritetStr = entry.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1];
    const prioritet = prioritetStr ? parseInt(prioritetStr, 10) : null;

    // Dokument-ID
    const dokumentId = entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null;
    const dokumentAlias =
      entry.match(/DokumentAliasIdentifikator[^>]*>([^<]+)/)?.[1] ??
      entry.match(/AktHistoriskIdentifikator[^>]*>([^<]+)/)?.[1] ??
      null;

    // Debitorer
    const debitorSamling =
      entry.match(
        /DebitorInformation(?:Samling)?>([\s\S]*?)<\/[^>]*DebitorInformation(?:Samling)?/
      )?.[1] ?? '';
    const rolleBlocks = [
      ...debitorSamling.matchAll(/RolleInformation>([\s\S]*?)<\/[^>]*RolleInformation/g),
    ];
    const debitorer: string[] = [];
    const debitorCvr: string[] = [];

    if (rolleBlocks.length > 0) {
      for (const [, info] of rolleBlocks) {
        const allNames = [...info.matchAll(/<[^/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
        const name = allNames
          .map((m) => m[1].trim())
          .filter((n) => n.length > 1)
          .join(' ');
        if (name) debitorer.push(name);
        const cvr = info.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1];
        if (cvr) debitorCvr.push(cvr);
      }
    } else {
      const allNames = [...debitorSamling.matchAll(/<[^/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
      for (const m of allNames) {
        if (m[1].trim().length > 1) debitorer.push(m[1].trim());
      }
    }

    // Rente
    const renteStr = entry.match(/(?:Haeftelse)?RentePaalydendeSats[^>]*>([^<]+)/)?.[1];
    const rente = renteStr ? parseFloat(renteStr) : null;
    const renteType =
      entry.match(/(?:Haeftelse)?RenteType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
      (entry.match(/RenteVariabel/) ? 'Variabel' : entry.match(/RenteFast/) ? 'Fast' : null);

    // Tinglysningsafgift
    const afgiftStr = entry.match(/(?:TinglysningAfgiftBetalt|Afgiftsbeloeb)[^>]*>([^<]+)/)?.[1];
    const tinglysningsafgift = afgiftStr ? parseInt(afgiftStr, 10) : null;

    // Løbetid
    const loebetid = entry.match(/(?:Loebetid|UdloebsDato)[^>]*>([^<]+)/)?.[1] ?? null;

    // Vilkår — saml alle Afsnit-elementer
    const vilkaarAfsnit = [...entry.matchAll(/Afsnit[^>]*>([^<]{5,})/g)]
      .map((m) => m[1].trim())
      .filter((v) => v.length > 0);
    const vilkaar = vilkaarAfsnit.length > 0 ? vilkaarAfsnit.join('\n') : null;

    haeftelser.push({
      type,
      pantTyper,
      kreditor,
      kreditorCvr,
      debitorer,
      debitorCvr,
      hovedstol,
      valuta,
      rente,
      renteType,
      registreringsdato,
      tinglysningsdato,
      tinglysningsafgift,
      prioritet,
      dokumentId,
      dokumentAlias,
      anmelderNavn: null,
      anmelderCvr: null,
      loebetid,
      vilkaar,
    });
  }

  return haeftelser;
}

/**
 * Normaliserer XML-hæftelsestyper til vores standardtyper.
 * Faktiske værdier fra XML: LoesoereHaeftelseTypeSummariskTekst
 *   - "skadesloesbrevLoesoere" → løsørepant/skadesløsbrev
 *   - "skadesloesbrevFordringspant" → fordringspant
 *   - "virksomhedspant" → virksomhedspant
 *   - "ejendomsforbehold" → ejendomsforbehold
 *   - "pantebrevLoesoere" → løsørepant
 */
function normalizeType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('virksomhedspant')) return 'virksomhedspant';
  if (lower.includes('fordringspant')) return 'fordringspant';
  if (lower.includes('ejendomsforbehold')) return 'ejendomsforbehold';
  if (lower.includes('loesoere') || lower.includes('løsøre') || lower.includes('losore'))
    return 'loesoerepant';
  return raw;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const cvr = req.nextUrl.searchParams.get('cvr');

  if (!cvr || !/^\d{8}$/.test(cvr)) {
    return NextResponse.json({ error: 'cvr parameter er påkrævet (8 cifre)' }, { status: 400 });
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json({
      cvr,
      uuid: null,
      haeftelser: [],
      fejl: 'Tinglysning certifikat ikke konfigureret',
    });
  }

  try {
    // Trin 1: Søg i Personbogen med CVR-nummer
    // Endpoint: /tinglysning/unsecuressl/soegpersonbogcvr?cvr=...
    // Se http_api_beskrivelse v1.12, afsnit 4.4.1
    const searchRes = await tlFetch(`/soegpersonbogcvr?cvr=${cvr}`);

    let items: { uuid: string; navn?: string; cvr?: string }[] = [];

    if (searchRes.status === 200) {
      try {
        const searchData = JSON.parse(searchRes.body);
        items = searchData?.items ?? [];
      } catch {
        // Responsen kan være XML — prøv at udtrække UUID'er
        const uuids = [...searchRes.body.matchAll(/uuid[^>]*>([^<]+)/gi)];
        items = uuids.map(([, uuid]) => ({ uuid }));
      }
    }

    // Ingen test-fallback for personbog — det giver ikke mening at vise
    // en anden virksomheds pantdata, da det er misvisende for brugeren.

    if (items.length === 0) {
      const result: PersonbogData = { cvr, uuid: null, haeftelser: [] };
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      });
    }

    // Trin 2: Hent summariske oplysninger for hvert personbog-item
    const allHaeftelser: PersonbogHaeftelse[] = [];
    const primaryUuid = items[0].uuid;

    for (const item of items) {
      // Endpoint: /tinglysning/unsecuressl/personbog/{uuid}
      // Returnerer LoesoereSummariskHentResultat XML
      const detailRes = await tlFetch(`/personbog/${item.uuid}`);
      if (detailRes.status === 200) {
        const parsed = parsePersonbogXml(detailRes.body);

        // Berig med anmelder-info fra dokument-opslag (via ssl-stien)
        for (const h of parsed) {
          if (h.dokumentId) {
            try {
              const dokRes = await tlFetchSsl(`/dokaktuel/uuid/${h.dokumentId}`);
              if (dokRes.status === 200) {
                const dok = dokRes.body;
                const anmelderSection =
                  dok.match(/AnmelderInformation[\s\S]*?<\/[^>]*AnmelderInformation/)?.[0] ?? '';
                h.anmelderCvr =
                  anmelderSection.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;
                h.anmelderNavn =
                  anmelderSection.match(/PersonName[^>]*>([^<]+)/)?.[1] ??
                  anmelderSection.match(/LegalUnitName[^>]*>([^<]+)/)?.[1] ??
                  null;
              }
            } catch {
              /* Detaljer er valgfrie */
            }
          }
        }

        allHaeftelser.push(...parsed);
      }
    }

    const result: PersonbogData = {
      cvr,
      uuid: primaryUuid,
      haeftelser: allHaeftelser,
    };

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    console.error('[tinglysning/personbog] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
