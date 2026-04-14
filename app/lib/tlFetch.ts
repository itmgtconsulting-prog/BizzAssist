/**
 * Tinglysning HTTP helper — delt af alle /api/tinglysning/* routes.
 *
 * Bruger Hetzner proxy med mTLS når DF_PROXY_URL er sat (Vercel/cloud),
 * ellers direkte mTLS med client-certifikat (lokal dev).
 *
 * @module app/lib/tlFetch
 */

import https from 'https';
import fs from 'fs';
import path from 'path';

/** Cert config — læses fra env ved kald-tid (undgå Turbopack build-time inlining) */
function getCertConfig() {
  return {
    certPath: process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '',
    certPassword:
      process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '',
    certB64: process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '',
    tlBase: process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk',
    proxyUrl: process.env.DF_PROXY_URL ?? '',
    proxySecret: process.env.DF_PROXY_SECRET ?? '',
  };
}

/**
 * Laver GET request til Tinglysning HTTP API.
 * Bruger proxy når DF_PROXY_URL er sat, ellers direkte mTLS.
 *
 * @param urlPath - Sti under apiPath (f.eks. "/ejendom/100165718")
 * @param options - Valgfri: timeout, Accept header, apiPath (/tinglysning/ssl eller /tinglysning/unsecuressl)
 * @returns { status, body } fra Tinglysning
 */
export function tlFetch(
  urlPath: string,
  options?: { timeout?: number; accept?: string; apiPath?: string }
): Promise<{ status: number; body: string }> {
  const { tlBase, proxyUrl, proxySecret, certB64, certPath, certPassword } = getCertConfig();
  const timeout = options?.timeout ?? 55000;
  const accept = options?.accept ?? 'application/json, application/xml, */*';
  const tlApiPath = options?.apiPath ?? '/tinglysning/ssl';

  // ── Proxy-path: Vercel → Hetzner proxy → Tinglysning (mTLS på proxy) ──
  if (proxyUrl) {
    const targetUrl = `${tlBase}${tlApiPath}${urlPath}`;
    const proxied = targetUrl.replace('https://', `${proxyUrl}/proxy/`);

    return fetch(proxied, {
      method: 'GET',
      headers: {
        Accept: accept,
        ...(proxySecret ? { 'X-Proxy-Secret': proxySecret } : {}),
      },
      signal: AbortSignal.timeout(timeout),
    }).then(async (res) => ({
      status: res.status,
      body: await res.text(),
    }));
  }

  // ── Direkte mTLS-path: lokal dev med certifikat ──
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    if (certB64) {
      pfx = Buffer.from(certB64, 'base64');
    } else {
      const certAbsPath = path.resolve(certPath);
      if (!fs.existsSync(certAbsPath)) {
        reject(new Error('Certifikat ikke fundet: ' + certAbsPath));
        return;
      }
      pfx = fs.readFileSync(certAbsPath);
    }
    const url = new URL(tlBase + tlApiPath + urlPath);

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        pfx,
        passphrase: certPassword,
        rejectUnauthorized: false,
        timeout,
        headers: { Accept: accept },
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
 * Returnerer Tinglysning base URL (test eller prod).
 * Bruges af routes der selv konstruerer URL'er.
 */
export function getTlBase(): string {
  return process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';
}
