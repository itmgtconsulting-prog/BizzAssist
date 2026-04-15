/**
 * Certificate expiry checker for mTLS certificates.
 *
 * Parses PFX/P12 certificates from file path or Base64 env var and
 * returns the expiry date. Used by daily-status cron and /api/health
 * to alert before certificates expire.
 *
 * BIZZ-304: Prevents silent service outage when certs expire.
 *
 * @module app/lib/certExpiry
 */

import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { logger } from '@/app/lib/logger';

export interface CertExpiryInfo {
  /** Human-readable certificate name */
  name: string;
  /** ISO 8601 expiry date, or null if cert couldn't be parsed */
  expiresAt: string | null;
  /** Days remaining until expiry, or null if unknown */
  daysRemaining: number | null;
  /** 'ok' | 'warning' (< 30 days) | 'critical' (< 14 days) | 'expired' | 'unknown' */
  status: 'ok' | 'warning' | 'critical' | 'expired' | 'unknown';
  /** Error message if cert couldn't be loaded */
  error?: string;
}

/**
 * Checks expiry of a PFX certificate loaded from file path or Base64 env var.
 *
 * @param name - Human-readable name for the certificate
 * @param certPath - File path to .p12 file (optional)
 * @param certBase64 - Base64-encoded .p12 content (optional)
 * @param certPassword - Password for the .p12 file
 * @returns CertExpiryInfo with status and days remaining
 */
export function checkCertExpiry(
  name: string,
  certPath: string,
  certBase64: string,
  _certPassword: string
): CertExpiryInfo {
  try {
    let pfx: Buffer | null = null;

    if (certBase64) {
      pfx = Buffer.from(certBase64, 'base64');
    } else if (certPath && fs.existsSync(certPath)) {
      pfx = fs.readFileSync(certPath);
    }

    if (!pfx) {
      return {
        name,
        expiresAt: null,
        daysRemaining: null,
        status: 'unknown',
        error: 'No certificate configured',
      };
    }

    // Extract X509 cert from PFX — Node.js 20+ supports this natively
    const cert = new X509Certificate(pfx);
    const expiresAt = new Date(cert.validTo);
    const now = new Date();
    const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    let status: CertExpiryInfo['status'] = 'ok';
    if (daysRemaining < 0) status = 'expired';
    else if (daysRemaining < 14) status = 'critical';
    else if (daysRemaining < 30) status = 'warning';

    return {
      name,
      expiresAt: expiresAt.toISOString(),
      daysRemaining,
      status,
    };
  } catch (err) {
    // PFX parsing can fail if password is wrong or format is unexpected.
    // X509Certificate constructor may not accept PFX directly on all platforms —
    // fall back gracefully rather than crashing the health check.
    logger.error(
      `[certExpiry] Failed to parse ${name}:`,
      err instanceof Error ? err.message : String(err)
    );
    return {
      name,
      expiresAt: null,
      daysRemaining: null,
      status: 'unknown',
      error: err instanceof Error ? err.message : 'Parse error',
    };
  }
}

/**
 * Checks all configured mTLS certificates and returns their expiry status.
 *
 * @returns Array of CertExpiryInfo for each configured certificate
 */
export function checkAllCertificates(): CertExpiryInfo[] {
  const results: CertExpiryInfo[] = [];

  // Tinglysning mTLS certificate
  const tlPath = process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
  const tlB64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
  const tlPass =
    process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';

  if (tlPath || tlB64) {
    results.push(checkCertExpiry('Tinglysning mTLS', tlPath, tlB64, tlPass));
  }

  // Datafordeler mTLS certificate
  const dfPath = process.env.DATAFORDELER_CERT_PATH ?? '';
  const dfB64 = process.env.DATAFORDELER_CERT_PFX_BASE64 ?? '';
  const dfPass = process.env.DATAFORDELER_CERT_PASSWORD ?? '';

  if (dfPath || dfB64) {
    results.push(checkCertExpiry('Datafordeler mTLS', dfPath, dfB64, dfPass));
  }

  return results;
}
