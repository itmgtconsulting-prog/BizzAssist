/**
 * Tinglysning Historisk Adkomster — BIZZ-1494 (Trin 1)
 *
 * Henter FULD historisk adkomst-historik fra Tinglysning XML API (S2S).
 * REST /ejdsummarisk returnerer kun AKTIV adkomst — historiske skøder
 * forsvinder. Denne helper kalder EjendomHistoriskAdkomsterHent via
 * XMLDSig-signeret S2S-kald og returnerer alle historiske handler med
 * købesummer.
 *
 * Protokol-gotchas (fra PoC 2026-05-15):
 *   - Path: /ElektroniskAkt/<Operation>
 *   - Header: Tinglysning-Message-ID: uuid:<lowercase-uuid>
 *   - Signature: RSA-SHA512 + Exclusive C14N + SHA-256 digest
 *   - Signature MUST have Id="Signature-<uuid>"
 *   - Root MUST NOT have Id attribute
 *   - Reference URI="" (sign whole doc)
 *   - EjendomIdentifikator kræver Matrikel (ikke kun BFE)
 *   - Response AsciiTekst er base64-encoded plain text
 *
 * @module app/lib/tinglysningHistoriskAdkomster
 */

import crypto, { randomUUID } from 'crypto';
import forge from 'node-forge';
import { ExclusiveCanonicalization } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { LruCache } from '@/app/lib/lruCache';
import { logger } from '@/app/lib/logger';
import { tlFetch } from '@/app/lib/tlFetch';

/** Shape af en historisk adkomst-entry. */
export interface HistoriskAdkomstRow {
  /** ISO YYYY-MM-DD — dato for adkomsten */
  dato: string | null;
  /** DokumentTypeTekst — fx "ENDELIGTSKOEDE", "SKOEDE" */
  dokumentType: string | null;
  /** Købesum i DKK (parsed fra AsciiTekst) */
  koebesumDkk: number | null;
  /** Adkomsthavere med navn, CPR (maskeret), ejerandel */
  adkomsthavere: AdkomsthaverInfo[];
  /** Rå base64-decoded tekst fra AsciiTekst (til debugging) */
  rawText: string | null;
}

/** Parsed adkomsthaver. */
export interface AdkomsthaverInfo {
  /** Fuldt navn */
  navn: string;
  /** CPR (maskeret med XXXX) */
  cpr: string | null;
  /** Ejerandel tæller */
  andelTaeller: number | null;
  /** Ejerandel nævner */
  andelNaevner: number | null;
}

const NS_MSG = 'http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/';
const NS_MODEL = 'http://rep.oio.dk/tinglysning.dk/schema/model/1/';
const NS_KMS = 'http://rep.oio.dk/kms.dk/xml/schemas/2005/03/11/';

const cache = new LruCache<number, HistoriskAdkomstRow[]>({
  maxSize: 150,
  ttlMs: 3_600_000,
});

/** Cached P12 cert + private key (loaded once). */
let certCache: { privateKeyPem: string; certBase64: string } | null = null;

/**
 * Load OCES P12 certificate and extract PEM key + DER cert.
 */
function loadCertPemKey(): { privateKeyPem: string; certBase64: string } {
  if (certCache) return certCache;

  // Support both file path and base64-encoded env var
  const certPath = process.env.TINGLYSNING_CERT_PATH;
  const certB64 = process.env.TINGLYSNING_CERT_B64;
  const password = process.env.TINGLYSNING_CERT_PASSWORD;
  if ((!certPath && !certB64) || !password) {
    throw new Error('TINGLYSNING_CERT_PATH/B64 + PASSWORD required');
  }

  let p12Buf: Buffer;
  if (certB64) {
    p12Buf = Buffer.from(certB64, 'base64');
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    p12Buf = fs.readFileSync(path.resolve(certPath!));
  }

  const p12Asn1 = forge.asn1.fromDer(p12Buf.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
  const keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag });
  const privateKey = keyBag[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key;
  const cert = certBag[forge.pki.oids.certBag]?.[0]?.cert;
  if (!privateKey || !cert) throw new Error('Could not extract key/cert from P12');

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  certCache = {
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certBase64: Buffer.from(certDer, 'binary').toString('base64'),
  };
  return certCache;
}

/**
 * REST lookup: BFE → matrikel-info (districtName, districtId, matrikelnummer).
 * Kræves fordi XML API afviser BFE-only identifikation.
 */
async function lookupMatrikel(bfe: number): Promise<{
  distName: string;
  distId: string;
  matNr: string;
}> {
  // Step 1: BFE → UUID
  const searchRes = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`, {
    timeout: 15000,
  });
  if (searchRes.status !== 200) throw new Error(`BFE lookup failed: ${searchRes.status}`);
  let uuid: string | null = null;
  try {
    const data = JSON.parse(searchRes.body);
    uuid = data?.items?.[0]?.uuid ?? null;
  } catch {
    /* */
  }
  if (!uuid) throw new Error(`No UUID for BFE ${bfe}`);

  // Step 2: UUID → summarisk XML → matrikel
  const summRes = await tlFetch(`/ejdsummarisk/${uuid}`, {
    timeout: 15000,
    accept: 'application/xml',
  });
  if (summRes.status !== 200) throw new Error(`Summarisk failed: ${summRes.status}`);
  const xml = summRes.body;
  const distName = xml.match(/CadastralDistrictName[^>]*>([^<]+)/)?.[1];
  const distId = xml.match(/CadastralDistrictIdentifier[^>]*>([^<]+)/)?.[1];
  const matNr = xml.match(/Matrikelnummer[^>]*>([^<]+)/)?.[1];
  if (!distName || !distId || !matNr) throw new Error('Could not extract Matrikel from summarisk');
  return { distName, distId, matNr };
}

/**
 * Build XMLDSig-signeret EjendomHistoriskAdkomsterHent request.
 */
function buildSignedRequest(
  bfe: number,
  matrikel: { distName: string; distId: string; matNr: string },
  privateKeyPem: string,
  certBase64: string
): string {
  const root = 'EjendomHistoriskAdkomsterHent';
  const inner =
    `<model:EjendomIdentifikator>` +
    `<model:BestemtFastEjendomNummer>${bfe}</model:BestemtFastEjendomNummer>` +
    `<model:Matrikel>` +
    `<kms:CadastralDistrictName>${matrikel.distName}</kms:CadastralDistrictName>` +
    `<kms:CadastralDistrictIdentifier>${matrikel.distId}</kms:CadastralDistrictIdentifier>` +
    `<model:Matrikelnummer>${matrikel.matNr}</model:Matrikelnummer>` +
    `</model:Matrikel>` +
    `</model:EjendomIdentifikator>`;

  const docNoSig =
    `<${root} xmlns="${NS_MSG}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` xsi:schemaLocation="${NS_MSG} ${NS_MSG}${root}.xsd"` +
    ` xmlns:model="${NS_MODEL}" xmlns:kms="${NS_KMS}">${inner}</${root}>`;

  // Digest over Exclusive C14N of doc (before signature)
  const doc = new DOMParser().parseFromString(docNoSig, 'application/xml');
  const c14nDoc = new ExclusiveCanonicalization().process(doc.documentElement, {});
  const digestB64 = crypto.createHash('sha256').update(c14nDoc, 'utf8').digest('base64');

  // SignedInfo → sign over its C14N form
  const signedInfo =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"/>` +
    `<Reference URI="">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<DigestValue>${digestB64}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`;

  const siDoc = new DOMParser().parseFromString(signedInfo, 'application/xml');
  const c14nSI = new ExclusiveCanonicalization().process(siDoc.documentElement, {});
  const sigVal = crypto
    .createSign('RSA-SHA512')
    .update(c14nSI, 'utf8')
    .sign(privateKeyPem, 'base64');

  const sigId = `Signature-${randomUUID()}`;
  const sigEl =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#" Id="${sigId}">` +
    `${signedInfo}<SignatureValue>${sigVal}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;

  return docNoSig.replace(`</${root}>`, `${sigEl}</${root}>`);
}

/**
 * Parse en adkomsthaver-linje fra AsciiTekst.
 * Format: "Bo Ivan Dalgaard Ottosen 050284-XXXX Ejerandel: 1/2"
 *
 * @param line - Rå linje fra decoded AsciiTekst
 */
export function parseAdkomsthaverLine(line: string): AdkomsthaverInfo {
  const trimmed = line.trim();
  const andelMatch = trimmed.match(/Ejerandel:\s*(\d+)\/(\d+)/i);
  const cprMatch = trimmed.match(/(\d{6}-[X\d]{4})/);
  let navn = trimmed;
  if (andelMatch) navn = navn.replace(andelMatch[0], '').trim();
  if (cprMatch) navn = navn.replace(cprMatch[0], '').trim();
  return {
    navn,
    cpr: cprMatch?.[1] ?? null,
    andelTaeller: andelMatch ? parseInt(andelMatch[1], 10) : null,
    andelNaevner: andelMatch ? parseInt(andelMatch[2], 10) : null,
  };
}

/**
 * Parse XML response fra EjendomHistoriskAdkomsterHent.
 */
function parseHistoriskeAdkomster(xml: string): HistoriskAdkomstRow[] {
  const entries = [
    ...xml.matchAll(/EjendomHistoriskAdkomst>([\s\S]*?)<\/[^:]*:?EjendomHistoriskAdkomst>/g),
  ];
  return entries.map(([, entry]) => {
    const dato = entry.match(/HistoriskAdkomstDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
    const type = entry.match(/DokumentTypeTekst[^>]*>([^<]+)/)?.[1] ?? null;
    const asciiB64 = entry.match(/AsciiTekst[^>]*>([^<]+)/)?.[1] ?? null;
    const decoded = asciiB64 ? Buffer.from(asciiB64, 'base64').toString('utf-8') : null;

    // Parse købesum fra decoded tekst
    const koebMatch = decoded?.match(/K[øo]besum:\s*([\d.]+)\s*DKK/i);
    const koebesumDkk = koebMatch ? parseInt(koebMatch[1].replace(/\./g, ''), 10) : null;

    // Parse adkomsthavere (linjer efter "Adkomsthavere:")
    const lines = decoded?.split('\n') ?? [];
    const ahStart = lines.findIndex((l) => /adkomsthavere/i.test(l));
    const ahLines = ahStart >= 0 ? lines.slice(ahStart + 1).filter(Boolean) : [];
    const adkomsthavere = ahLines.map(parseAdkomsthaverLine);

    return { dato, dokumentType: type, koebesumDkk, adkomsthavere, rawText: decoded };
  });
}

/**
 * Hent fuld historisk adkomst-historik for et BFE-nummer.
 * Cached 1 time. Returnerer [] ved fejl.
 *
 * @param bfe - BFE-nummer
 */
export async function fetchHistoriskAdkomsterByBfe(bfe: number): Promise<HistoriskAdkomstRow[]> {
  if (!Number.isFinite(bfe) || bfe <= 0) return [];
  const cached = cache.get(bfe);
  if (cached) return cached;

  try {
    const { privateKeyPem, certBase64 } = loadCertPemKey();
    const matrikel = await lookupMatrikel(bfe);
    const signedXml = buildSignedRequest(bfe, matrikel, privateKeyPem, certBase64);

    // POST til XML API
    const tlXmlBase =
      process.env.TINGLYSNING_XML_API_URL ??
      ((process.env.TINGLYSNING_BASE_URL ?? '').includes('test')
        ? 'https://test-xml-api.tinglysning.dk'
        : 'https://xml-api.tinglysning.dk');
    const proxyUrl = process.env.DF_PROXY_URL;
    const proxySecret = process.env.DF_PROXY_SECRET;

    const target = `${tlXmlBase}/ElektroniskAkt/EjendomHistoriskAdkomsterHent`;
    const url = proxyUrl ? target.replace('https://', `${proxyUrl}/proxy/`) : target;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        'Tinglysning-Message-ID': `uuid:${randomUUID()}`,
        ...(proxySecret ? { 'X-Proxy-Secret': proxySecret } : {}),
      },
      body: signedXml,
      signal: AbortSignal.timeout(60_000),
    });

    const body = await res.text();
    if (res.status !== 200) {
      const fault = body.match(/faultstring[^>]*>([^<]+)/)?.[1];
      logger.warn(`[historiskAdkomster] XML API ${res.status}: ${fault ?? body.slice(0, 200)}`);
      cache.set(bfe, []);
      return [];
    }

    const rows = parseHistoriskeAdkomster(body);
    cache.set(bfe, rows);
    return rows;
  } catch (err) {
    logger.warn(
      '[historiskAdkomster] failed for BFE',
      bfe,
      err instanceof Error ? err.message : err
    );
    cache.set(bfe, []);
    return [];
  }
}
