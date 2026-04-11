/**
 * Datafordeler OAuth Certifikat-autentifikation (mTLS).
 *
 * Henter OAuth Bearer token fra Datafordeler ved at præsentere et client-certifikat
 * i TLS-handshake (mutual TLS / mTLS). Bruges til fortrolige data (EJF, VUR, etc.)
 * når OAuth Shared Secret ikke har adgang.
 *
 * Kræver:
 *   - DATAFORDELER_CERT_CLIENT_ID: OAuth Client ID for certifikat-klienten (fra selfservice.datafordeler.dk)
 *   - DATAFORDELER_CERT_PATH: Sti til .p12 certifikatfil (lokal dev)
 *     ELLER DATAFORDELER_CERT_PFX_BASE64: Base64-encodet .p12 indhold (cloud deploy)
 *   - DATAFORDELER_CERT_PASSWORD: Adgangskode til .p12 filen
 *
 * @module app/lib/dfCertAuth
 */

import https from 'node:https';
import fs from 'node:fs';
import { isProxyEnabled } from './dfProxy';
import { logger } from '@/app/lib/logger';

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';
const CERT_CLIENT_ID = process.env.DATAFORDELER_CERT_CLIENT_ID ?? '';
const CERT_PFX_PATH = process.env.DATAFORDELER_CERT_PATH ?? '';
const CERT_PFX_BASE64 = process.env.DATAFORDELER_CERT_PFX_BASE64 ?? '';
const CERT_PASSPHRASE = process.env.DATAFORDELER_CERT_PASSWORD ?? '';

// ─── Token cache ─────────────────────────────────────────────────────────────

let _cachedCertToken: { token: string; expiresAt: number } | null = null;

/**
 * Returnerer true hvis certifikat-auth er konfigureret.
 *
 * @returns true hvis alle nødvendige env vars er sat
 */
export function isCertAuthConfigured(): boolean {
  return !!(CERT_CLIENT_ID && (CERT_PFX_PATH || CERT_PFX_BASE64) && CERT_PASSPHRASE);
}

/**
 * Henter PFX-buffer fra enten filsti eller base64-encodet env var.
 *
 * @returns Buffer med .p12 certifikatindhold, eller null
 */
function getPfxBuffer(): Buffer | null {
  // Base64 har prioritet (cloud deploy)
  if (CERT_PFX_BASE64) {
    try {
      return Buffer.from(CERT_PFX_BASE64, 'base64');
    } catch {
      logger.error('[dfCertAuth] Kunne ikke decode DATAFORDELER_CERT_PFX_BASE64');
      return null;
    }
  }

  // Fallback: fil-sti (lokal dev)
  if (CERT_PFX_PATH) {
    try {
      return fs.readFileSync(CERT_PFX_PATH);
    } catch (err) {
      logger.error('[dfCertAuth] Kunne ikke læse certifikat fra', CERT_PFX_PATH, err);
      return null;
    }
  }

  return null;
}

/**
 * Henter OAuth Bearer token via mTLS certifikat-autentifikation.
 * Cacher tokenet i serverprocessen — fornyer automatisk 60 sek. inden udløb.
 *
 * @returns Bearer token som streng, eller null ved fejl
 */
export async function getCertOAuthToken(): Promise<string | null> {
  // Return cached token if still valid
  if (_cachedCertToken && Date.now() < _cachedCertToken.expiresAt - 60_000) {
    return _cachedCertToken.token;
  }

  if (!isCertAuthConfigured()) return null;

  const pfx = getPfxBuffer();
  if (!pfx) return null;

  // Hvis proxy er aktiv, kan vi ikke bruge mTLS direkte
  // (proxyen skal håndtere certifikatet)
  if (isProxyEnabled()) {
    logger.warn(
      '[dfCertAuth] mTLS via proxy er ikke understøttet endnu — brug direkte forbindelse'
    );
    return null;
  }

  try {
    const tokenBody = `grant_type=client_credentials&client_id=${encodeURIComponent(CERT_CLIENT_ID)}`;

    const token = await new Promise<string | null>((resolve) => {
      const url = new URL(TOKEN_URL);

      const agent = new https.Agent({
        pfx,
        passphrase: CERT_PASSPHRASE,
        // Tillad self-signed certs fra Datafordeler auth server (normalt ikke nødvendigt)
        rejectUnauthorized: true,
      });

      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          agent,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(tokenBody),
          },
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              logger.error(
                '[dfCertAuth] Token request failed:',
                res.statusCode,
                data.slice(0, 300)
              );
              resolve(null);
              return;
            }
            try {
              const json = JSON.parse(data) as { access_token: string; expires_in: number };
              _cachedCertToken = {
                token: json.access_token,
                expiresAt: Date.now() + json.expires_in * 1000,
              };
              resolve(json.access_token);
            } catch {
              logger.error('[dfCertAuth] Kunne ikke parse token response');
              resolve(null);
            }
          });
        }
      );

      req.on('error', (err) => {
        logger.error('[dfCertAuth] Token request error:', err.message);
        resolve(null);
      });

      req.on('timeout', () => {
        logger.error('[dfCertAuth] Token request timeout');
        req.destroy();
        resolve(null);
      });

      req.write(tokenBody);
      req.end();
    });

    return token;
  } catch (err) {
    logger.error('[dfCertAuth] Unexpected error:', err instanceof Error ? err.message : err);
    return null;
  }
}
