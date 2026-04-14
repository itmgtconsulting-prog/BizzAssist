/**
 * GET /api/tinglysning/indskannede-akter/download?aktNavn=<aktNavn>
 *
 * Downloader en indskannet akt som PDF fra Tinglysningsrettens HTTP XML API
 * (ElektroniskAkt-service, v53.1.0.1).
 *
 * Flow:
 *   1. Udtræk PEM-nøgle og certifikat fra P12
 *   2. Byg EjendomIndskannetAktHent XML og sign med XMLDSig enveloped signature (obligatorisk jf. XSD)
 *   3. POST til https://[test-]xml-api.tinglysning.dk/ElektroniskAkt/EjendomIndskannetAktHent (mTLS)
 *   4. Parse EjendomIndskannetAktHentResultat → IndskannetDokumentData (base64 PDF)
 *   5. Returnér decoded PDF til klienten
 *
 * Endpoint (ny S2S HTTP-stil, jf. s2s-dokumentation-07):
 *   /ElektroniskAkt/EjendomIndskannetAktHent
 * Schema: http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/
 * Dokumentation: docs/tinglysning/xmlapi/XMLAPI-NOTES.md
 *
 * Bekræftet af Domstolsstyrelsen (e-tl-011@domstol.dk, 2026-04-13):
 * "Akterne kan hentes via EjendomIndskannetAktHent."
 *
 * BLOKER: Kræver S2S-actor registrering hos Tinglysningsretten (ansøgning sendt 2026-04-13).
 * Afventer: godkendelse + upload af cert i S2S SysParam på test.tinglysning.dk.
 *
 * @param aktNavn - Akt-filnavn fra EjendomIndskannetAktSamling i ejdsummarisk (f.eks. "1_H-I_458")
 * @returns PDF-binary hvis download lykkedes, ellers JSON 501 med fejlinfo
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

/**
 * HTTP XML API base.
 * Test: test-xml-api.tinglysning.dk / Prod: xml-api.tinglysning.dk
 * Udledes automatisk fra TINGLYSNING_BASE_URL hvis TINGLYSNING_XML_API_URL ikke er sat eksplicit.
 */
const TL_XML_API_BASE =
  process.env.TINGLYSNING_XML_API_URL ??
  ((process.env.TINGLYSNING_BASE_URL ?? '').includes('test')
    ? 'https://test-xml-api.tinglysning.dk'
    : 'https://xml-api.tinglysning.dk');

const XML_API_SERVICE_PATH = '/ElektroniskAkt/EjendomIndskannetAktHent';

// ─── Namespaces ───────────────────────────────────────────────────────────────

const NS_MSG = 'http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/';
const NS_SCHEMA = 'http://rep.oio.dk/tinglysning.dk/schema/elektroniskakt/1/';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';

// ─── Certificate helpers ──────────────────────────────────────────────────────

/**
 * Loader certifikat som Buffer — foretrækker base64 env var over filsti.
 */
function loadCertBuffer(): Buffer {
  if (CERT_B64) return Buffer.from(CERT_B64, 'base64');
  const certAbsPath = path.resolve(CERT_PATH);
  if (!fs.existsSync(certAbsPath)) {
    throw new Error('Certifikat ikke fundet: ' + certAbsPath);
  }
  return fs.readFileSync(certAbsPath);
}

/**
 * Udtrækker privat nøgle og certifikat (PEM) fra P12/PKCS#12-fil til brug ved XMLDSig.
 *
 * @returns privateKeyPem og certPem
 */
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
    throw new Error('Kunne ikke udtrække nøgle/certifikat fra P12 — tjek adgangskode og format');
  }

  return {
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

// ─── XML signing ─────────────────────────────────────────────────────────────

/**
 * Bygger EjendomIndskannetAktHent XML og signerer med XMLDSig enveloped signature.
 *
 * XMLDSig er OBLIGATORISK ifølge XSD-schema (ds:Signature er minOccurs=1).
 * Bruges RSA-SHA256 + C14N + SHA-256 digest (OCES3-kompatibelt).
 *
 * @param aktNavn - Akt-filnavn (DokumentFilnavnTekst)
 * @param privateKeyPem - OCES privat nøgle i PEM-format
 * @param certPem - OCES certifikat i PEM-format
 * @returns Signeret XML-string
 */
function buildSignedRequest(aktNavn: string, privateKeyPem: string, certPem: string): string {
  // Undgå XML-injection i aktNavn (validering sker allerede i route handler)
  const safeAktNavn = aktNavn
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const unsignedXml = [
    `<EjendomIndskannetAktHent`,
    ` xmlns="${NS_MSG}"`,
    ` xmlns:eakt="${NS_SCHEMA}"`,
    ` xmlns:ds="${NS_DS}">`,
    `<eakt:DokumentFilnavnTekst>${safeAktNavn}</eakt:DokumentFilnavnTekst>`,
    `</EjendomIndskannetAktHent>`,
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

/**
 * Laver HTTPS-request med mTLS (client-certifikat).
 *
 * @param options - Node.js https.RequestOptions
 * @param body - Request body som Buffer (til POST)
 * @returns HTTP status, headers og body som Buffer
 */
function tlHttpRequest(
  options: https.RequestOptions,
  body?: Buffer
): Promise<{ status: number; headers: Record<string, string>; buffer: Buffer }> {
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
        resolve({
          status: res.statusCode ?? 500,
          headers: res.headers as Record<string, string>,
          buffer: Buffer.concat(chunks),
        })
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
 * Kalder ElektroniskAkt XML API med EjendomIndskannetAktHent-operationen.
 *
 * @param signedXml - Signeret XML-request
 * @returns HTTP status og response body som Buffer
 */
function callXmlApi(
  signedXml: string
): Promise<{ status: number; headers: Record<string, string>; buffer: Buffer }> {
  const xmlUrl = new URL(TL_XML_API_BASE + XML_API_SERVICE_PATH);
  const body = Buffer.from(signedXml, 'utf-8');

  return tlHttpRequest(
    {
      hostname: xmlUrl.hostname,
      port: 443,
      path: xmlUrl.pathname,
      method: 'POST',
      headers: {
        // Ny S2S HTTP-stil (s2s-dokumentation-07): application/xml, ingen SOAPAction
        'Content-Type': 'application/xml',
        'Content-Length': String(body.byteLength),
        // Header-navn og format bekræftet af e-TL XML API (400-svar ved forkert format)
        'Tinglysning-Message-ID': `uuid:${randomUUID()}`,
      },
    },
    body
  );
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/**
 * Parser EjendomIndskannetAktHentResultat XML og udtrækker IndskannetDokumentData (base64).
 *
 * @param xml - XML-response fra ElektroniskAkt XML API
 * @returns base64-decoded dokumentindhold som Buffer, eller null ved parse-fejl
 */
function parseXmlApiResponse(xml: string): Buffer | null {
  // IndskannetDokumentData er base64-encoded filindhold jf. XSD
  const match = xml.match(
    /<(?:[^:>]+:)?IndskannetDokumentData[^>]*>([\s\S]+?)<\/(?:[^:>]+:)?IndskannetDokumentData>/
  );
  if (!match?.[1]) return null;
  const b64 = match[1].replace(/\s/g, '');
  if (!b64) return null;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/**
 * Udtrækker MIME-type fra IndskannetDokumentDataBinaer-elementet.
 *
 * @param xml - XML-response fra ElektroniskAkt XML API
 * @returns MIME-type eller 'application/octet-stream' som fallback
 */
function parseMimeType(xml: string): string {
  const match = xml.match(
    /<(?:[^:>]+:)?MimetypeKodeTekst[^>]*>([\s\S]+?)<\/(?:[^:>]+:)?MimetypeKodeTekst>/
  );
  return match?.[1]?.trim() ?? 'application/octet-stream';
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const limited = await checkRateLimit(req, heavyRateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const aktNavn = req.nextUrl.searchParams.get('aktNavn');

  if (!aktNavn) {
    return NextResponse.json({ error: 'aktNavn parameter er påkrævet' }, { status: 400 });
  }

  // Afvis aktNavn med path traversal-tegn
  if (!/^[\w\-.]+$/.test(aktNavn)) {
    return NextResponse.json({ error: 'aktNavn har ugyldige tegn' }, { status: 400 });
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { error: 'Tinglysning certifikat ikke konfigureret' },
      { status: 503 }
    );
  }

  try {
    // Trin 1: Udtræk PEM-nøgle og -certifikat fra P12 til XMLDSig
    // (Metadata-opslag via HTTP REST er fjernet — /ssl/indskannetakt/<aktNavn> eksisterer ikke)
    let privateKeyPem: string;
    let certPem: string;
    try {
      const p12Buffer = loadCertBuffer();
      ({ privateKeyPem, certPem } = extractPemFromP12(p12Buffer, CERT_PASSWORD));
    } catch (certErr) {
      logger.error('[indskannede-akter/download] P12-parsing fejlede:', certErr);
      return NextResponse.json(
        { error: 'Certifikat kunne ikke parses — tjek TINGLYSNING_CERT_PATH og -PASSWORD' },
        { status: 503 }
      );
    }

    // Trin 2: Byg og sign XML-request (XMLDSig enveloped signature — obligatorisk jf. XSD)
    let signedXml: string;
    try {
      signedXml = buildSignedRequest(aktNavn, privateKeyPem, certPem);
    } catch (signErr) {
      logger.error('[indskannede-akter/download] XMLDSig signing fejlede:', signErr);
      return NextResponse.json({ error: 'XML signing fejlede' }, { status: 503 });
    }

    // Trin 3: POST til HTTP XML API (ElektroniskAkt-service, mTLS)
    logger.log(
      `[indskannede-akter/download] Kalder XML API: ${TL_XML_API_BASE}${XML_API_SERVICE_PATH} for aktNavn=${aktNavn}`
    );
    const xmlRes = await callXmlApi(signedXml);

    if (xmlRes.status === 200) {
      const responseXml = xmlRes.buffer.toString('utf-8');

      const pdfBuffer = parseXmlApiResponse(responseXml);
      if (pdfBuffer && pdfBuffer.length > 0) {
        const mimeType = parseMimeType(responseXml);
        const safeFilename =
          aktNavn.replace(/[^a-zA-Z0-9\-_]/g, '_') + (mimeType === 'application/pdf' ? '.pdf' : '');
        return new NextResponse(new Uint8Array(pdfBuffer) as unknown as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': mimeType,
            'Content-Disposition': `attachment; filename="${safeFilename}"`,
            'Content-Length': String(pdfBuffer.byteLength),
            'Cache-Control': 'private, no-store',
          },
        });
      }

      // HTTP 200 men ingen IndskannetDokumentData — log response for debugging
      logger.log(
        '[indskannede-akter/download] XML API svarede 200 men uden IndskannetDokumentData. Response:',
        responseXml.substring(0, 500)
      );
    } else {
      logger.log(
        `[indskannede-akter/download] XML API HTTP ${xmlRes.status}:`,
        xmlRes.buffer.toString('utf-8').substring(0, 500)
      );
    }

    // Trin 4: Alle forsøg fejlede — returnér 501 med info til UI
    logger.log(
      '[indskannede-akter/download] XML API-kald fejlede. HTTP status:',
      xmlRes.status,
      'aktNavn:',
      aktNavn
    );

    return NextResponse.json(
      {
        error: 'download_ikke_tilgaengelig',
        aktNavn,
        xmlApiStatus: xmlRes.status,
        besked:
          'EjendomIndskannetAktHent (HTTP XML API) returnerede ikke et gyldigt dokument. ' +
          'Kontrollér at aktNavn er korrekt og at S2S-actor er registreret hos Tinglysningsretten.',
      },
      { status: 501 }
    );
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[indskannede-akter/download] Fejl:', msg);
    const body =
      process.env.NODE_ENV === 'development'
        ? { error: 'Ekstern API fejl', dev_detail: msg }
        : { error: 'Ekstern API fejl' };
    return NextResponse.json(body, { status: 500 });
  }
}
