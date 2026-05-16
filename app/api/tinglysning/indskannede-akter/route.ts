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
import https from 'https';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { SignedXml } from 'xml-crypto';
import forge from 'node-forge';

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
const NS_SCHEMA = 'http://rep.oio.dk/tinglysning.dk/schema/elektroniskakt/1/';
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
function buildSignedRequest(ejendomUuid: string, privateKeyPem: string, certPem: string): string {
  const safeUuid = ejendomUuid.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const unsignedXml = [
    `<EjendomStamoplysningerHent`,
    ` xmlns="${NS_MSG}"`,
    ` xmlns:eakt="${NS_SCHEMA}"`,
    ` xmlns:ds="${NS_DS}">`,
    `<eakt:EjendomIdentifikator>${safeUuid}</eakt:EjendomIdentifikator>`,
    `</EjendomStamoplysningerHent>`,
  ].join('');

  const signer = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certPem,
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });

  signer.addReference({
    xpath: '/*',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });

  signer.computeSignature(unsignedXml);
  return signer.getSignedXml();
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

/** Kalder ElektroniskAkt XML API med EjendomStamoplysningerHent. */
function callXmlApi(signedXml: string): Promise<{ status: number; buffer: Buffer }> {
  const xmlUrl = new URL(TL_XML_API_BASE + XML_API_SERVICE_PATH);
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

  // Fallback: parse DokumentFilnavnTekst fra EjendomIndskannetAktSamling
  if (akter.length === 0) {
    const samlingStart = xml.indexOf('EjendomIndskannetAktSamling>');
    const samlingEnd = xml.indexOf('/EjendomIndskannetAktSamling>');
    if (samlingStart !== -1 && samlingEnd !== -1) {
      const samlingBlock = xml.substring(samlingStart, samlingEnd);
      const filnavnMatches = [
        ...samlingBlock.matchAll(
          /<(?:[a-zA-Z]+:)?DokumentFilnavnTekst>([^<]+)<\/(?:[a-zA-Z]+:)?DokumentFilnavnTekst>/g
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
      logger.error('[indskannede-akter] P12-parsing fejlede:', certErr);
      return NextResponse.json({ error: 'Certifikat kunne ikke parses' }, { status: 503 });
    }

    // Trin 2: Byg og sign XML
    let signedXml: string;
    try {
      signedXml = buildSignedRequest(ejendomId, privateKeyPem, certPem);
    } catch (signErr) {
      logger.error('[indskannede-akter] XMLDSig signing fejlede:', signErr);
      return NextResponse.json({ error: 'XML signing fejlede' }, { status: 503 });
    }

    // Trin 3: POST til XML API
    logger.log(
      `[indskannede-akter] Kalder S2S XML API: ${TL_XML_API_BASE}${XML_API_SERVICE_PATH} for ejendomId=${ejendomId}`
    );
    const xmlRes = await callXmlApi(signedXml);

    if (xmlRes.status === 200) {
      const responseXml = xmlRes.buffer.toString('utf-8');
      const akter = parseStamoplysningerXml(responseXml);

      logger.log(`[indskannede-akter] Fandt ${akter.length} akter for ejendomId=${ejendomId}`);

      const result: IndskannedeAkterResponse = { ejendomId, akter };
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      });
    }

    // Non-200: log og returner tom liste
    logger.log(
      `[indskannede-akter] XML API HTTP ${xmlRes.status}:`,
      xmlRes.buffer.toString('utf-8').substring(0, 500)
    );

    return NextResponse.json({ ejendomId, akter: [] } satisfies IndskannedeAkterResponse, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[indskannede-akter] Fejl:', msg);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
