/**
 * S2S Client — reusable Tinglysning XML API helper (BIZZ-1507).
 *
 * Extracted from tinglysningHistoriskAdkomster.ts. Provides:
 *   - loadOcesCertAndKey() — load P12 cert + private key
 *   - signXmlBody() — XMLDSig enveloped signature (RSA-SHA512 + Exclusive C14N)
 *   - callS2S() — build, sign, POST to Tinglysning XML API
 *
 * Protocol gotchas (from PoC 2026-05-15):
 *   - Path: /ElektroniskAkt/<Operation>
 *   - Header: Tinglysning-Message-ID: uuid:<lowercase-uuid>
 *   - Signature: RSA-SHA512 + Exclusive C14N + SHA-256 digest
 *   - Signature MUST have Id="Signature-<uuid>"
 *   - Root MUST NOT have Id attribute
 *   - Reference URI="" (sign whole doc)
 *
 * @module app/lib/s2sClient
 */

import crypto, { randomUUID } from 'crypto';
import forge from 'node-forge';
import { ExclusiveCanonicalization } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { logger } from '@/app/lib/logger';

/** Cached cert + key (loaded once per cold start). */
let certCache: { privateKeyPem: string; certBase64: string } | null = null;

/**
 * Load OCES P12 certificate and extract PEM private key + DER cert.
 * Supports both file path (TINGLYSNING_CERT_PATH) and base64 env var (TINGLYSNING_CERT_B64).
 *
 * @returns PEM private key + base64 DER certificate
 */
export function loadOcesCertAndKey(): { privateKeyPem: string; certBase64: string } {
  if (certCache) return certCache;

  const certPath = process.env.TINGLYSNING_CERT_PATH;
  const certB64 = process.env.TINGLYSNING_CERT_B64;
  const password = process.env.TINGLYSNING_CERT_PASSWORD;
  if ((!certPath && !certB64) || !password) {
    throw new Error('TINGLYSNING_CERT_PATH/B64 + PASSWORD required for S2S');
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
 * Sign an XML document body with XMLDSig enveloped signature.
 * Uses RSA-SHA512 signature + Exclusive C14N + SHA-256 digest.
 *
 * @param docXml - Unsigned XML document (without Signature element)
 * @param rootName - Root element name (e.g. "EjendomHistoriskAdkomsterHent")
 * @param privateKeyPem - PEM-encoded private key
 * @param certBase64 - Base64 DER-encoded certificate
 * @returns Signed XML with Signature element inserted before closing root tag
 */
export function signXmlBody(
  docXml: string,
  rootName: string,
  privateKeyPem: string,
  certBase64: string
): string {
  // Compute digest over Exclusive C14N of unsigned doc
  const doc = new DOMParser().parseFromString(docXml, 'application/xml');
  const c14nDoc = new ExclusiveCanonicalization().process(doc.documentElement, {});
  const digestB64 = crypto.createHash('sha256').update(c14nDoc, 'utf8').digest('base64');

  // Build SignedInfo
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

  // Sign over C14N of SignedInfo
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

  return docXml.replace(`</${rootName}>`, `${sigEl}</${rootName}>`);
}

/** Options for callS2S. */
export interface S2SOptions {
  /** Timeout in milliseconds (default 60000). */
  timeoutMs?: number;
}

/**
 * Build, sign and POST a request to the Tinglysning S2S XML API.
 *
 * @param operation - XML API operation name (e.g. "EjendomHistoriskAdkomsterHent")
 * @param unsignedXml - Full unsigned XML document body
 * @param options - Optional timeout
 * @returns Raw response XML body
 * @throws Error on non-200 response
 */
export async function callS2S(
  operation: string,
  unsignedXml: string,
  options?: S2SOptions
): Promise<string> {
  const { privateKeyPem, certBase64 } = loadOcesCertAndKey();

  // Extract root element name from the unsigned XML
  const rootMatch = unsignedXml.match(/^<(\w+)/);
  const rootName = rootMatch ? rootMatch[1] : operation;

  const signedXml = signXmlBody(unsignedXml, rootName, privateKeyPem, certBase64);

  // Resolve target URL
  const tlXmlBase =
    process.env.TINGLYSNING_XML_API_URL ??
    ((process.env.TINGLYSNING_BASE_URL ?? '').includes('test')
      ? 'https://test-xml-api.tinglysning.dk'
      : 'https://xml-api.tinglysning.dk');
  const proxyUrl = process.env.DF_PROXY_URL;
  const proxySecret = process.env.DF_PROXY_SECRET;

  const target = `${tlXmlBase}/ElektroniskAkt/${operation}`;
  const url = proxyUrl ? target.replace('https://', `${proxyUrl}/proxy/`) : target;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      'Tinglysning-Message-ID': `uuid:${randomUUID()}`,
      ...(proxySecret ? { 'X-Proxy-Secret': proxySecret } : {}),
    },
    body: signedXml,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 60_000),
  });

  const body = await res.text();
  if (res.status !== 200) {
    const fault = body.match(/faultstring[^>]*>([^<]+)/)?.[1];
    logger.warn(`[s2sClient] ${operation} failed ${res.status}: ${fault ?? body.slice(0, 200)}`);
    throw new Error(`S2S ${operation} failed: ${res.status} ${fault ?? 'unknown'}`);
  }

  return body;
}

/** XML namespaces used in Tinglysning S2S requests. */
export const NS = {
  MSG: 'http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/',
  MODEL: 'http://rep.oio.dk/tinglysning.dk/schema/model/1/',
  KMS: 'http://rep.oio.dk/kms.dk/xml/schemas/2005/03/11/',
} as const;
