/**
 * GET /api/tinglysning/indskannede-akter/download?aktNavn=<aktNavn>
 *
 * Downloader en indskannet akt som PDF via Tinglysningsrettens
 * EjendomIndskannetAktHent endpoint og streamer PDF'en til klienten.
 *
 * Advarsel: Indskannede akter kan være meget store (hundredvis af sider).
 * Downloadtiden kan variere fra sekunder til over et minut.
 *
 * @param aktNavn - Akt-navn fra /api/tinglysning/indskannede-akter
 * @returns PDF-dokument med Content-Disposition: attachment header
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';
import https from 'https';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
/** 5 minutter — store akter kan tage lang tid at hente */
export const maxDuration = 300;

// ─── Config ──────────────────────────────────────────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Loader certifikat som Buffer — foretrækker base64 env var over filsti.
 */
function loadCert(): Buffer {
  if (CERT_B64) return Buffer.from(CERT_B64, 'base64');
  const certAbsPath = path.resolve(CERT_PATH);
  if (!fs.existsSync(certAbsPath)) {
    throw new Error('Certifikat ikke fundet: ' + certAbsPath);
  }
  return fs.readFileSync(certAbsPath);
}

/**
 * Laver HTTPS GET request med client-certifikat (mTLS) og returnerer binær response som Buffer.
 * Bruges til download af PDF-dokumenter fra bilagsbanken.
 *
 * @param urlPath - Sti relativt til /tinglysning/ssl
 * @returns HTTP status, Content-Type header og PDF-data som Buffer
 */
function tlFetchBinary(
  urlPath: string
): Promise<{ status: number; buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    try {
      pfx = loadCert();
    } catch (e) {
      reject(e);
      return;
    }

    const url = new URL(TL_BASE + '/tinglysning/ssl' + urlPath);

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        pfx,
        passphrase: CERT_PASSWORD,
        rejectUnauthorized: false,
        // Store akter kan tage lang tid — 4 minutters timeout
        timeout: 240000,
        headers: { Accept: 'application/pdf, application/octet-stream, */*' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 500,
            buffer: Buffer.concat(chunks),
            contentType: res.headers['content-type'] ?? 'application/octet-stream',
          })
        );
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout — akten er muligvis meget stor'));
    });
    req.end();
  });
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

  // Afvis AktNavn med mistænkelige tegn (path traversal, injection)
  if (!/^[\w\-./]+$/.test(aktNavn)) {
    return NextResponse.json({ error: 'aktNavn har ugyldige tegn' }, { status: 400 });
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { error: 'Tinglysning certifikat ikke konfigureret' },
      { status: 503 }
    );
  }

  try {
    const res = await tlFetchBinary(
      `/ejendomindskannedejakt?aktNavn=${encodeURIComponent(aktNavn)}`
    );

    if (res.status === 404) {
      return NextResponse.json({ error: 'Indskannet akt ikke fundet' }, { status: 404 });
    }

    if (res.status !== 200) {
      logger.error('[indskannede-akter/download] Tinglysning HTTP', res.status);
      return NextResponse.json({ error: 'Tinglysning API fejl' }, { status: 502 });
    }

    // Sæt et sikkert filnavn — aktNavn kan indeholde tegn som ikke er filsystem-sikre
    const safeFilename = aktNavn.replace(/[^a-zA-Z0-9\-_]/g, '_') + '.pdf';

    return new NextResponse(new Uint8Array(res.buffer) as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Content-Length': String(res.buffer.byteLength),
        // Ingen offentlig cache — dokumenter kan indeholde fortrolige data
        'Cache-Control': 'private, no-store',
      },
    });
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
