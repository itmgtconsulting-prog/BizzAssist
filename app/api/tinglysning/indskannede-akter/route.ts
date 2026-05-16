/**
 * GET /api/tinglysning/indskannede-akter?ejendomId=<uuid>
 *
 * Henter listen over tilgængelige indskannede akter for en ejendom via
 * Tinglysningsrettens S2S XML API (ElektroniskAkt — EjendomStamoplysningerHent).
 *
 * Indskannede akter er pre-digitale dokumenter (typisk fra før 2009) som er
 * scannet ind og gemt i Tinglysningens bilagsbank som PDF-filer.
 *
 * Flow:
 *   1. Udtræk PEM fra P12-certifikat
 *   2. Byg EjendomStamoplysningerHent XML med XMLDSig
 *   3. POST til xml-api.tinglysning.dk/ElektroniskAkt/EjendomStamoplysningerHent (mTLS)
 *   4. Parse EjendomIndskannetAkt-elementer fra response
 *
 * @param ejendomId - Tinglysnings-UUID for ejendommen (fra /api/tinglysning)
 * @returns Liste af indskannede akter med AktNavn, AktType og dato
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';
import { tlFetch as tlFetchShared } from '@/app/lib/tlFetch';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto, { randomUUID } from 'crypto';
import forge from 'node-forge';
import { DOMParser } from '@xmldom/xmldom';
import { ExclusiveCanonicalization } from 'xml-crypto';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Config ──────────────────────────────────────────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';

const TL_XML_API_BASE =
  process.env.TINGLYSNING_XML_API_URL ??
  ((process.env.TINGLYSNING_BASE_URL ?? '').includes('test')
    ? 'https://test-xml-api.tinglysning.dk'
    : 'https://xml-api.tinglysning.dk');

const XML_API_SERVICE_PATH = '/ElektroniskAkt/EjendomStamoplysningerHent';

// ─── Namespaces ───────────────────────────────────────────────────────────────

const NS_MSG = 'http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/';
const NS_MODEL = 'http://rep.oio.dk/tinglysning.dk/schema/model/1/';
const NS_KMS = 'http://rep.oio.dk/kms.dk/xml/schemas/2005/03/11/';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IndskannetAkt {
  /** Akt-navn — bruges som parameter til download-endpointet */
  aktNavn: string;
  /** Menneskelig beskrivelse, fx "SKØDE" eller aktnavnet */
  beskrivelse: string | null;
  /** Tinglysningsdato eller anmeldelsesdato hvis tilgængeligt */
  dato: string | null;
  /** Sekventielt løbenummer (1-baseret position i samlingen) */
  loebNr: number;
}

export interface IndskannedeAkterResponse {
  ejendomId: string;
  akter: IndskannetAkt[];
}

// ─── Certificate helpers ──────────────────────────────────────────────────────

/** Loader certifikat som Buffer — foretrækker base64 env var over filsti. */
function loadCertBuffer(): Buffer {
  if (CERT_B64) return Buffer.from(CERT_B64, 'base64');
  const certAbsPath = path.resolve(CERT_PATH);
  if (!fs.existsSync(certAbsPath)) {
    throw new Error('Certifikat ikke fundet: ' + certAbsPath);
  }
  return fs.readFileSync(certAbsPath);
}

/** Udtrækker privat nøgle og certifikat (PEM) fra P12. */
function extractPemFromP12(
  p12Buffer: Buffer,
  password: string
): { privateKeyPem: string; certPem: string } {
  const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });

  const privateKey =
    keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key ??
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0]?.key;
  const cert = certBags[forge.pki.oids.certBag]?.[0]?.cert;

  if (!privateKey || !cert) {
    throw new Error('Kunne ikke udtrække nøgle/certifikat fra P12');
  }

  return {
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

// ─── XML signing ─────────────────────────────────────────────────────────────

/**
 * Bygger EjendomStamoplysningerHent XML med XMLDSig.
 *
 * @param ejendomUuid - Tinglysning ejendoms-UUID
 * @param privateKeyPem - OCES privat nøgle i PEM
 * @param certPem - OCES certifikat i PEM
 * @returns Signeret XML-string
 */
function buildSignedRequest(
  bfe: string,
  districtName: string,
  districtId: string,
  matrikelnr: string,
  privateKeyPem: string,
  certPem: string
): string {
  const XSD_LOC = `${NS_MSG} http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/EjendomStamoplysningerHent.xsd`;
  const paddedMatNr = matrikelnr.replace(/^(\d+)/, (m) => m.padStart(4, '0'));

  const unsignedXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<EjendomStamoplysningerHent` +
    ` xmlns="${NS_MSG}"` +
    ` xmlns:model="${NS_MODEL}"` +
    ` xmlns:kms="${NS_KMS}"` +
    ` xmlns:ds="${NS_DS}"` +
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` xsi:schemaLocation="${XSD_LOC}">` +
    `<model:EjendomIdentifikator>` +
    `<model:BestemtFastEjendomNummer>${bfe}</model:BestemtFastEjendomNummer>` +
    `<model:Matrikel>` +
    `<kms:CadastralDistrictName>${districtName}</kms:CadastralDistrictName>` +
    `<kms:CadastralDistrictIdentifier>${districtId}</kms:CadastralDistrictIdentifier>` +
    `<model:Matrikelnummer>${paddedMatNr}</model:Matrikelnummer>` +
    `</model:Matrikel>` +
    `</model:EjendomIdentifikator>` +
    `</EjendomStamoplysningerHent>`;

  const doc = new DOMParser().parseFromString(unsignedXml, 'application/xml');
  const c14n = new ExclusiveCanonicalization().process(doc.documentElement, {});
  const digestB64 = crypto.createHash('sha256').update(c14n, 'utf8').digest('base64');

  const signedInfo =
    `<ds:SignedInfo xmlns:ds="${NS_DS}">` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"/>` +
    `<ds:Reference URI="">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue>${digestB64}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>`;

  const siDoc = new DOMParser().parseFromString(signedInfo, 'application/xml');
  const c14nSI = new ExclusiveCanonicalization().process(siDoc.documentElement, {});
  const sigVal = crypto
    .createSign('RSA-SHA512')
    .update(c14nSI, 'utf8')
    .sign(privateKeyPem, 'base64');

  const certB64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');

  const sigEl =
    `<ds:Signature Id="Signature-${randomUUID()}">` +
    signedInfo +
    `<ds:SignatureValue>${sigVal}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
    `</ds:Signature>`;

  return unsignedXml.replace(
    '</EjendomStamoplysningerHent>',
    `${sigEl}</EjendomStamoplysningerHent>`
  );
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/** HTTPS-request med mTLS. */
function tlHttpRequest(
  options: https.RequestOptions,
  body?: Buffer
): Promise<{ status: number; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    try {
      pfx = loadCertBuffer();
    } catch (e) {
      reject(e);
      return;
    }

    const reqOptions: https.RequestOptions = {
      ...options,
      pfx,
      passphrase: CERT_PASSWORD,
      rejectUnauthorized: false,
      timeout: 120_000,
    };

    const req = https.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 500, buffer: Buffer.concat(chunks) })
      );
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Kalder ElektroniskAkt XML API via Hetzner-proxy (Vercel) eller direkte mTLS (lokal dev).
 * Proxyen håndterer mTLS-certifikatet for os.
 */
async function callXmlApi(signedXml: string): Promise<{ status: number; buffer: Buffer }> {
  const proxyUrl = process.env.DF_PROXY_URL ?? '';
  const proxySecret = process.env.DF_PROXY_SECRET ?? '';
  const targetUrl = `${TL_XML_API_BASE}${XML_API_SERVICE_PATH}`;

  // Proxy-path: Vercel → Hetzner proxy → Tinglysning (mTLS på proxy)
  if (proxyUrl) {
    const proxied = targetUrl.replace('https://', `${proxyUrl}/proxy/`);
    try {
      const res = await fetch(proxied, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml',
          'Tinglysning-Message-ID': `uuid:${randomUUID()}`,
          ...(proxySecret ? { 'X-Proxy-Secret': proxySecret } : {}),
        },
        body: signedXml,
        signal: AbortSignal.timeout(120_000),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, buffer: buf };
    } catch (proxyErr) {
      logger.warn('[indskannede-akter] Proxy fejlede, prøver direkte mTLS:', proxyErr);
      // Fall through to direct mTLS
    }
  }

  // Direkte mTLS (lokal dev)
  const xmlUrl = new URL(targetUrl);
  const body = Buffer.from(signedXml, 'utf-8');
  return tlHttpRequest(
    {
      hostname: xmlUrl.hostname,
      port: 443,
      path: xmlUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        'Content-Length': String(body.byteLength),
        'Tinglysning-Message-ID': `uuid:${randomUUID()}`,
      },
    },
    body
  );
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/**
 * Parser EjendomStamoplysningerHentResultat XML for indskannede akter.
 *
 * @param xml - XML-response fra API
 * @returns Liste af IndskannetAkt objekter
 */
function parseStamoplysningerXml(xml: string): IndskannetAkt[] {
  const akter: IndskannetAkt[] = [];

  const aktMatches = [
    ...xml.matchAll(
      /<(?:[a-zA-Z]+:)?EjendomIndskannetAkt>([\s\S]*?)<\/(?:[a-zA-Z]+:)?EjendomIndskannetAkt>/g
    ),
  ];

  for (let i = 0; i < aktMatches.length; i++) {
    const block = aktMatches[i][1];

    const aktNavn =
      block.match(/<(?:[a-zA-Z]+:)?AktNavn[^>]*>([^<]+)/)?.[1]?.trim() ??
      block.match(/<(?:[a-zA-Z]+:)?DokumentFilnavnTekst[^>]*>([^<]+)/)?.[1]?.trim() ??
      null;
    if (!aktNavn) continue;

    const beskrivelse =
      block.match(/<(?:[a-zA-Z]+:)?AktType[^>]*>([^<]+)/)?.[1]?.trim() ??
      block.match(/<(?:[a-zA-Z]+:)?AktBeskrivelse[^>]*>([^<]+)/)?.[1]?.trim() ??
      null;

    const dato =
      block.match(/<(?:[a-zA-Z]+:)?AnmeldelseDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ??
      block.match(/<(?:[a-zA-Z]+:)?TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ??
      block.match(/<(?:[a-zA-Z]+:)?Dato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ??
      null;

    akter.push({ aktNavn, beskrivelse, dato, loebNr: i + 1 });
  }

  // Fallback: parse ALLE DokumentFilnavnTekst i hele XML (S2S response wrapper varierer)
  if (akter.length === 0) {
    const filnavnMatches = [
      ...xml.matchAll(
        /<(?:[a-zA-Z0-9]+:)?DokumentFilnavnTekst[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?DokumentFilnavnTekst>/g
      ),
    ];
    const seen = new Set<string>();
    for (const [, navn] of filnavnMatches) {
      const trimmed = navn.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        akter.push({
          aktNavn: trimmed,
          beskrivelse: null,
          dato: null,
          loebNr: akter.length + 1,
        });
      }
    }
  }

  return akter;
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const limited = await checkRateLimit(req, heavyRateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ejendomId = req.nextUrl.searchParams.get('ejendomId');

  if (!ejendomId) {
    return NextResponse.json({ error: 'ejendomId parameter er påkrævet' }, { status: 400 });
  }

  if (!/^[0-9a-f-]{30,40}$/i.test(ejendomId)) {
    return NextResponse.json({ error: 'ejendomId har ugyldigt format' }, { status: 400 });
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { error: 'Tinglysning certifikat ikke konfigureret' },
      { status: 503 }
    );
  }

  try {
    // Trin 1: Udtræk PEM fra P12
    let privateKeyPem: string;
    let certPem: string;
    try {
      const p12Buffer = loadCertBuffer();
      ({ privateKeyPem, certPem } = extractPemFromP12(p12Buffer, CERT_PASSWORD));
    } catch (certErr) {
      const msg = certErr instanceof Error ? certErr.message : String(certErr);
      return NextResponse.json(
        { ejendomId, akter: [], _debug: { step: 'cert', error: msg } },
        { status: 503 }
      );
    }

    // Trin 2: Hent matrikel-info fra REST (kræves af S2S EjendomIdentifikator)
    const sumRes = await tlFetchShared(`/ejdsummarisk/${ejendomId}`, { accept: 'application/xml' });
    if (sumRes.status !== 200) {
      return NextResponse.json(
        { ejendomId, akter: [], _debug: { step: 'rest', status: sumRes.status } },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const sumXml = sumRes.body;
    const bfe = sumXml.match(/BestemtFastEjendomNummer>(\d+)/)?.[1] ?? '';
    const distName = sumXml.match(/CadastralDistrictName>([^<]+)/)?.[1] ?? '';
    const distId = sumXml.match(/CadastralDistrictIdentifier>([^<]+)/)?.[1] ?? '';
    const matNr = sumXml.match(/Matrikelnummer>([^<]+)/)?.[1] ?? '';

    if (!bfe || !distName || !distId || !matNr) {
      return NextResponse.json(
        { ejendomId, akter: [], _debug: { step: 'matrikel', bfe, distName, distId, matNr } },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Trin 3: Byg og sign XML
    let signedXml: string;
    try {
      signedXml = buildSignedRequest(bfe, distName, distId, matNr, privateKeyPem, certPem);
    } catch (signErr) {
      logger.error('[indskannede-akter] XMLDSig signing fejlede:', signErr);
      return NextResponse.json({ error: 'XML signing fejlede' }, { status: 503 });
    }

    // Trin 4: POST til XML API
    logger.log(
      `[indskannede-akter] Kalder S2S XML API: ${TL_XML_API_BASE}${XML_API_SERVICE_PATH} for BFE=${bfe} mat=${matNr}`
    );
    const xmlRes = await callXmlApi(signedXml);

    if (xmlRes.status === 200) {
      const responseXml = xmlRes.buffer.toString('utf-8');
      const akter = parseStamoplysningerXml(responseXml);

      logger.log(`[indskannede-akter] Fandt ${akter.length} akter for ejendomId=${ejendomId}`);

      return NextResponse.json(
        {
          ejendomId,
          akter,
          _debug: {
            xmlApiStatus: 200,
            bfe,
            distName,
            distId,
            matNr,
            responseLen: responseXml.length,
            hasDokFil: responseXml.includes('DokumentFilnavn'),
          },
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Non-200: log og returner debug-info
    const faultBody = xmlRes.buffer.toString('utf-8').substring(0, 500);
    logger.log(`[indskannede-akter] XML API HTTP ${xmlRes.status}: ${faultBody}`);

    return NextResponse.json(
      {
        ejendomId,
        akter: [],
        _debug: {
          xmlApiStatus: xmlRes.status,
          bfe,
          distName,
          distId,
          matNr,
          fault: faultBody.substring(0, 300),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[indskannede-akter] Fejl:', msg);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
