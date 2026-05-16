/**
 * XMLDSig enveloped-signature for Tinglysning S2S requests.
 *
 * Tinglysningsrettens XML API kræver at request body er signeret med OCES
 * virksomhedscertifikat via XMLDSig (enveloped signature, RSA-SHA256).
 * Signaturen tilføjes som `<ds:Signature>`-element inde i request-elementet,
 * og dækker hele dokumentet (XPath `/*` med `enveloped-signature` transform).
 *
 * Implementation bruger `xml-crypto` (allerede i deps).
 *
 * Stub-status: kun signatur + factory på plads. Body kommer i BIZZ-XX2 (Fase 1).
 *
 * @module app/lib/etl/xmlSigner
 * Retention: N/A (signering sker in-memory, intet persisteres).
 */

/**
 * Resultatet af en XMLDSig-signering.
 */
export interface SignedXml {
  /** XML-strengen med `<ds:Signature>` indsat. */
  signed: string;
  /** SHA-256 hash af den signerede payload (til audit-log). */
  payloadHash: string;
}

/**
 * Cert + private key læst fra PKCS#12 (PFX) via Vercel env var.
 * Cachet på modul-niveau efter første kald — undgår at parse PFX ved hver request.
 */
const pfxCache: { cert: Buffer; key: Buffer } | null = null;

/**
 * Loader cert + private key fra `TINGLYSNING_CERT_B64` (base64 PKCS#12).
 * Bruger Node's native crypto API (Node 20+) — ingen ekstra deps.
 *
 * @returns DER-encoded cert + PEM-encoded private key (begge buffers)
 * @throws Hvis env vars mangler eller PFX ikke kan parses
 */
function loadOcesCertAndKey(): { cert: Buffer; key: Buffer } {
  if (pfxCache) return pfxCache;

  // TODO BIZZ-XX2: implementer
  // - Læs process.env.TINGLYSNING_CERT_B64 + TINGLYSNING_CERT_PASSWORD
  // - Buffer.from(b64, 'base64') → pfxBuffer
  // - Brug node:crypto.X509Certificate + extractPrivateKey eller node-forge
  //   (afhænger af om node 20's crypto kan håndtere PKCS#12 direkte)
  // - Cache resultatet i pfxCache
  // - Return { cert, key }

  throw new Error('loadOcesCertAndKey: not implemented — see BIZZ-XX2 (Fase 1, ADR 0009)');
}

/**
 * Signerer en XML request-body med XMLDSig enveloped-signature.
 *
 * Signaturkonfiguration (jf. Tinglysning's HTTP XML API specifikation):
 *
 * - Algorithm: `http://www.w3.org/2001/04/xmldsig-more#rsa-sha256`
 * - Canonicalization: `http://www.w3.org/2001/10/xml-exc-c14n#`
 * - Transform: `http://www.w3.org/2000/09/xmldsig#enveloped-signature`
 * - Reference URI: `""` (hele dokumentet)
 * - X509Certificate inkluderet i KeyInfo
 *
 * @param unsignedXml - XML-streng uden `<ds:Signature>` element
 * @param rootElementName - Navnet på root-elementet (fx "EjendomSummariskHent")
 *                          — bruges til at vide hvor signaturen skal indsættes
 * @returns Signeret XML + hash til audit
 * @throws Hvis cert ikke kan loades eller signering fejler
 *
 * @example
 * ```ts
 * const body = `<EjendomSummariskHent xmlns="...">
 *   <eakt:BFEnummerIdentifikator>100165718</eakt:BFEnummerIdentifikator>
 * </EjendomSummariskHent>`;
 * const { signed, payloadHash } = signXmlBody(body, 'EjendomSummariskHent');
 * // signed indeholder nu <ds:Signature>...</ds:Signature> inde i root-elementet
 * ```
 */
export function signXmlBody(unsignedXml: string, rootElementName: string): SignedXml {
  // TODO BIZZ-XX2: implementer
  // - Load cert + key via loadOcesCertAndKey()
  // - Brug xml-crypto's SignedXml-klasse:
  //   const sig = new SignedXml({ privateKey: key });
  //   sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  //   sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  //   sig.addReference({
  //     xpath: '/*',
  //     transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  //                  'http://www.w3.org/2001/10/xml-exc-c14n#'],
  //     digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  //   });
  //   sig.keyInfoProvider = new X509CertificateKeyInfoProvider(cert);
  //   sig.computeSignature(unsignedXml, {
  //     location: { reference: `//*[local-name(.)='${rootElementName}']`, action: 'append' }
  //   });
  // - return { signed: sig.getSignedXml(), payloadHash: sha256(signed) }

  void unsignedXml;
  void rootElementName;
  void loadOcesCertAndKey;

  throw new Error('signXmlBody: not implemented — see BIZZ-XX2 (Fase 1, ADR 0009)');
}

/**
 * Verificerer en indkommende signeret XML mod en given trust-anchor cert
 * (fx Tinglysningsrettens OCES root). Bruges af callback-endpoints
 * (`/api/etl/svar/*`) for at sikre at indkommende svar faktisk kommer fra
 * Tinglysningsretten.
 *
 * @param signedXml - XML modtaget fra Tinglysningsretten
 * @param trustedCert - PEM-encoded cert vi forventer skal have signeret
 * @returns true hvis signaturen er gyldig og fra trusted cert
 */
export function verifyXmlSignature(signedXml: string, trustedCert: string): boolean {
  // BIZZ-1518: Implementeringen ligger i app/lib/s2sClient.ts hvor signering
  // også er. Vi re-eksporterer her så callback-handlers kan importere fra
  // begge moduler under refaktor-perioden.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const impl = require('@/app/lib/s2sClient') as {
    verifyXmlSignature: (xml: string, pem: string) => boolean;
  };
  return impl.verifyXmlSignature(signedXml, trustedCert);
}
