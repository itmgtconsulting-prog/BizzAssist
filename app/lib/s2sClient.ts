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
import { ExclusiveCanonicalization, SignedXml } from 'xml-crypto';
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

/**
 * Verify XMLDSig signature on an incoming XML document (BIZZ-1518).
 *
 * Bruges af /api/etl/svar/* callback-endpoints til at sikre at indkommende
 * svar fra Tinglysningsretten faktisk er signeret af deres OCES root og
 * ikke spoofed af en angriber.
 *
 * Sikkerhedsfeatures:
 *   - **XSW (XML Signature Wrapping) defense**: Afviser hvis Reference URI
 *     ikke er tom — Tinglysning bruger altid URI="" (sign hele dokumentet),
 *     så non-empty Reference URI er attack indicator
 *   - **Cert byte-match**: X509Certificate i KeyInfo skal matche
 *     `trustedCertPem` præcist (DER-bytes). Forhindrer at en angriber
 *     bruger en cert der er signed af samme CA men ikke er Tinglysning's
 *   - **Performance**: ~10-50ms per verifikation (xml-crypto + en
 *     enkelt sha256-digest + RSA-verify)
 *
 * @param signedXml - XML modtaget fra Tinglysningsretten (med Signature element)
 * @param trustedCertPem - PEM-encoded forventet signer-cert (fx fra env
 *   TINGLYSNING_RESPONSE_TRUST_CERT). Skal være den eksakte cert Tinglysning
 *   bruger til at signere callbacks.
 * @returns true hvis signaturen er gyldig og cert matcher
 */
export function verifyXmlSignature(signedXml: string, trustedCertPem: string): boolean {
  if (!signedXml || !trustedCertPem) return false;

  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser().parseFromString(signedXml, 'application/xml');
  } catch (err) {
    logger.warn('[s2sClient] verifyXmlSignature: ugyldig XML', err);
    return false;
  }

  // Find <Signature>-element (xmldsig namespace)
  const sigNodes = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  if (!sigNodes || sigNodes.length === 0) {
    logger.warn('[s2sClient] verifyXmlSignature: ingen Signature-element fundet');
    return false;
  }
  if (sigNodes.length > 1) {
    // Multiple signatures = potential XSW attack
    logger.warn('[s2sClient] verifyXmlSignature: multiple Signature-elementer (XSW indicator)');
    return false;
  }
  const sigNode = sigNodes[0];

  // Extract X509Certificate fra KeyInfo. xml-crypto returnerer PEM-wrappet
  // string (med BEGIN/END markers).
  const certPem = SignedXml.getCertFromKeyInfo(sigNode);
  if (!certPem) {
    logger.warn('[s2sClient] verifyXmlSignature: ingen X509Certificate i KeyInfo');
    return false;
  }

  // ─── Cert byte-match — vigtigste sikkerheds-check ────────────────────
  // Selv hvis signaturen er kryptografisk gyldig, må vi kun acceptere
  // den cert vi explicit har trusted. Forhindrer at en angriber bruger
  // en anden gyldig cert (fx fra samme CA).
  if (!certBytesMatch(certPem, trustedCertPem)) {
    logger.warn('[s2sClient] verifyXmlSignature: X509Certificate matcher IKKE trusted cert');
    return false;
  }

  // XSW-defense: præcis 1 Reference, og URI skal være "" eller same-document
  // fragment ("#<id>"). Eksterne URLs eller multiple references er attack
  // indicators (XML Signature Wrapping). Tinglysning bruger URI="" per
  // protokol; xml-crypto's standard-output bruger URI="#_0" — begge accepteres.
  const referenceUris = extractReferenceUris(sigNode);
  if (referenceUris.length !== 1) {
    logger.warn(
      '[s2sClient] verifyXmlSignature: forventede 1 Reference, fandt ' + referenceUris.length,
      { uris: referenceUris }
    );
    return false;
  }
  const refUri = referenceUris[0];
  if (refUri !== '' && !refUri.startsWith('#')) {
    logger.warn('[s2sClient] verifyXmlSignature: ekstern Reference URI (XSW indicator)', {
      uri: refUri,
    });
    return false;
  }

  // ─── Verifikation via xml-crypto ─────────────────────────────────────
  try {
    const sig = new SignedXml({ publicCert: certPem });
    sig.loadSignature(sigNode);
    return sig.checkSignature(signedXml);
  } catch (err) {
    logger.warn('[s2sClient] verifyXmlSignature: checkSignature kastede', err);
    return false;
  }
}

/**
 * Normaliser begge cert-strenge (PEM eller raw base64) til DER-bytes og
 * sammenlign timing-safe. Forhindrer at formatering (newlines, headers)
 * påvirker matchet.
 */
function certBytesMatch(certA: string, certB: string): boolean {
  try {
    const derA = certToDer(certA);
    const derB = certToDer(certB);
    if (derA.length !== derB.length) return false;
    return crypto.timingSafeEqual(derA, derB);
  } catch {
    return false;
  }
}

/** Konverter PEM eller raw base64 til DER-buffer */
function certToDer(cert: string): Buffer {
  const b64 = cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, '');
  return Buffer.from(b64, 'base64');
}

/** Find alle Reference URI-attributter i Signature-elementet */
function extractReferenceUris(sigNode: Node): string[] {
  const uris: string[] = [];
  const el = sigNode as unknown as Element;
  const refs = el.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Reference');
  for (let i = 0; i < refs.length; i++) {
    const uri = refs[i].getAttribute('URI');
    uris.push(uri ?? '');
  }
  return uris;
}

/** XML namespaces used in Tinglysning S2S requests. */
export const NS = {
  MSG: 'http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/',
  MODEL: 'http://rep.oio.dk/tinglysning.dk/schema/model/1/',
  KMS: 'http://rep.oio.dk/kms.dk/xml/schemas/2005/03/11/',
} as const;
