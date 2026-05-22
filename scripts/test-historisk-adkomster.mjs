/**
 * BIZZ-XXXX: Working PoC for EjendomHistoriskAdkomsterHent (XML API).
 *
 * Calls the Tinglysning XML API (S2S HTTP) to retrieve the FULL historical
 * adkomst-history for a property — including købesum and ejere from cancelled
 * (aflyste) deeds that ejdsummarisk REST API does not return.
 *
 * Usage:
 *   node scripts/test-historisk-adkomster.mjs <BFE>
 *
 * Returns historical price data matching what Resights shows. Confirmed against
 * Søbyvej 26 (BFE 2081244): all 3 historical sales (1964, 2002, 2017) returned
 * with prices and adkomsthaver-names, matching Resights exactly.
 *
 * IMPORTANT — gotchas discovered during PoC (2026-05-15):
 *   1. Use /ElektroniskAkt/<Operation> path (not deprecated /etl/services/...)
 *   2. Required header: Tinglysning-Message-ID: uuid:<lowercase-uuid>
 *   3. xsi:schemaLocation="<NS> <NS><RootName>.xsd" must be on root
 *   4. Signature MUST have Id="Signature-<uuid>" (e-TL requirement)
 *   5. NO Id attribute on the root element (XSD forbids it)
 *   6. Algorithm: RSA-SHA512 + Exclusive C14N + SHA-256 digest
 *   7. Reference URI="" (sign whole doc, no internal Id reference)
 *   8. Compute digest over EXCLUSIVE-C14N output of doc (not raw XML text)
 *   9. EjendomIdentifikator REQUIRES Matrikel-section (CadastralDistrict +
 *      Matrikelnummer) — BestemtFastEjendomNummer alone is rejected
 *  10. Response: each AdkomstSummarisk's AsciiTekst is base64-encoded plain
 *      text containing "Købesum: X.XXX.XXX DKK" + "Adkomsthavere:" lines
 */

import crypto, { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import forge from 'node-forge';
import { ExclusiveCanonicalization } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';

dotenv.config({ path: '.env.local' });

const NS_MSG = 'http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/';
const NS_MODEL = 'http://rep.oio.dk/tinglysning.dk/schema/model/1/';
const NS_KMS = 'http://rep.oio.dk/kms.dk/xml/schemas/2005/03/11/';

const TL_REST_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://www.tinglysning.dk';
const TL_XML_BASE = process.env.TINGLYSNING_XML_API_URL ??
  (TL_REST_BASE.includes('test') ? 'https://test-xml-api.tinglysning.dk' : 'https://xml-api.tinglysning.dk');
const PROXY_URL = process.env.DF_PROXY_URL;
const PROXY_SECRET = process.env.DF_PROXY_SECRET;

function loadCertPemKey() {
  const certPath = process.env.TINGLYSNING_CERT_PATH;
  const password = process.env.TINGLYSNING_CERT_PASSWORD;
  if (!certPath || !password) throw new Error('TINGLYSNING_CERT_PATH/PASSWORD missing');
  const p12Buf = fs.readFileSync(path.resolve(certPath));
  const p12Asn1 = forge.asn1.fromDer(p12Buf.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
  const privateKey = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;
  const cert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0].cert;
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certBase64: Buffer.from(certDer, 'binary').toString('base64'),
  };
}

/** REST: BFE → { uuid, matrikel: { distName, distId, matNr } } */
async function lookupBfe(bfe) {
  const target = `${TL_REST_BASE}/tinglysning/ssl/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`;
  const proxied = PROXY_URL ? target.replace('https://', `${PROXY_URL}/proxy/`) : target;
  const res = await fetch(proxied, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(PROXY_SECRET ? { 'X-Proxy-Secret': PROXY_SECRET } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) throw new Error(`REST BFE lookup failed ${res.status}`);
  const data = JSON.parse(await res.text());
  const item = data.items?.[0];
  if (!item) throw new Error(`No items for BFE ${bfe}`);
  // Need to fetch summarisk to get Matrikel info (REST search result doesn't include it)
  const summRes = await fetch(
    PROXY_URL
      ? `${TL_REST_BASE}/tinglysning/ssl/ejdsummarisk/${item.uuid}`.replace('https://', `${PROXY_URL}/proxy/`)
      : `${TL_REST_BASE}/tinglysning/ssl/ejdsummarisk/${item.uuid}`,
    { method: 'GET', headers: { Accept: 'application/xml', ...(PROXY_SECRET ? { 'X-Proxy-Secret': PROXY_SECRET } : {}) }, signal: AbortSignal.timeout(30_000) }
  );
  const summXml = await summRes.text();
  const distName = summXml.match(/CadastralDistrictName[^>]*>([^<]+)/)?.[1];
  const distId = summXml.match(/CadastralDistrictIdentifier[^>]*>([^<]+)/)?.[1];
  const matNr = summXml.match(/Matrikelnummer[^>]*>([^<]+)/)?.[1];
  if (!distName || !distId || !matNr) throw new Error('Could not extract Matrikel info from REST');
  return { uuid: item.uuid, matrikel: { distName, distId, matNr } };
}

/**
 * Build, sign, POST EjendomHistoriskAdkomsterHent and return parsed historical adkomster.
 */
async function fetchHistoriskAdkomster(bfe) {
  const { matrikel } = await lookupBfe(bfe);
  const { privateKeyPem, certBase64 } = loadCertPemKey();

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

  // Compute digest over Exclusive-C14N of the doc (no signature yet → enveloped-signature transform is a no-op)
  const doc = new DOMParser().parseFromString(docNoSig, 'application/xml');
  const c14nDoc = new ExclusiveCanonicalization().process(doc.documentElement, {});
  const digestB64 = crypto.createHash('sha256').update(c14nDoc, 'utf8').digest('base64');

  // Build SignedInfo, sign over its C14N form
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
  const signedInfoDoc = new DOMParser().parseFromString(signedInfo, 'application/xml');
  const c14nSI = new ExclusiveCanonicalization().process(signedInfoDoc.documentElement, {});
  const sigVal = crypto.createSign('RSA-SHA512').update(c14nSI, 'utf8').sign(privateKeyPem, 'base64');

  const sigId = `Signature-${randomUUID()}`;
  const sigEl =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#" Id="${sigId}">` +
    `${signedInfo}<SignatureValue>${sigVal}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;
  const finalXml = docNoSig.replace(`</${root}>`, `${sigEl}</${root}>`);

  // POST
  const target = `${TL_XML_BASE}/ElektroniskAkt/EjendomHistoriskAdkomsterHent`;
  const proxied = PROXY_URL ? target.replace('https://', `${PROXY_URL}/proxy/`) : target;
  const res = await fetch(proxied, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      'Tinglysning-Message-ID': `uuid:${randomUUID()}`,
      ...(PROXY_SECRET ? { 'X-Proxy-Secret': PROXY_SECRET } : {}),
    },
    body: finalXml,
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (res.status !== 200) {
    const fault = body.match(/faultstring[^>]*>([^<]+)/)?.[1];
    throw new Error(`XML API ${res.status}: ${fault ?? body.slice(0, 300)}`);
  }
  return parseHistoriskeAdkomster(body);
}

/** Parse <EjendomHistoriskAdkomst> entries from XML response */
function parseHistoriskeAdkomster(xml) {
  const entries = [...xml.matchAll(/EjendomHistoriskAdkomst>([\s\S]*?)<\/[^:]*:?EjendomHistoriskAdkomst>/g)];
  return entries.map(([, entry]) => {
    const dato = entry.match(/HistoriskAdkomstDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
    const type = entry.match(/DokumentTypeTekst[^>]*>([^<]+)/)?.[1] ?? null;
    const asciiB64 = entry.match(/AsciiTekst[^>]*>([^<]+)/)?.[1] ?? null;
    const decoded = asciiB64 ? Buffer.from(asciiB64, 'base64').toString('utf-8') : null;
    const koebesum = decoded?.match(/K[øo]besum:\s*([\d.]+)\s*DKK/i)?.[1]?.replace(/\./g, '');
    const adkomsthavereLines = decoded?.split('\n').slice(2).filter(Boolean) ?? [];
    return {
      dato,
      type,
      koebesumDkk: koebesum ? parseInt(koebesum, 10) : null,
      adkomsthavere: adkomsthavereLines,
      rawText: decoded,
    };
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
const bfe = parseInt(process.argv[2] ?? '2081244', 10);
console.log(`\n=== Historisk adkomster for BFE ${bfe} ===\n`);
console.log(`REST base: ${TL_REST_BASE}`);
console.log(`XML API:   ${TL_XML_BASE}`);
console.log(`Proxy:     ${PROXY_URL ?? '(direct)'}\n`);

const records = await fetchHistoriskAdkomster(bfe);
console.log(`Found ${records.length} historical adkomster:\n`);
for (const r of records) {
  console.log(`── ${r.dato} ${r.type ?? '(ukendt)'}`);
  console.log(`   Købesum: ${r.koebesumDkk ? r.koebesumDkk.toLocaleString('da-DK') + ' DKK' : '–'}`);
  for (const ejer of r.adkomsthavere) console.log(`   ${ejer}`);
  console.log();
}
