/**
 * GET /api/tinglysning/indskannede-akter/download?aktNavn=<aktNavn>
 *
 * Downloader en indskannet akt som PDF fra Tinglysningsrettens HTTP XML API.
 *
 * Tre-trins flow (bekræftet via svar fra Domstolsstyrelsen 2026-04-13):
 *   1. GET /ssl/indskannetakt/<aktNavn>
 *      → JSON: { uuid, databaseTabel: "akt", filnavn }
 *   2. GET /ssl/ejendomindskannedakt/<aktNavn>   ← EjendomIndskannetAktHent-operationen
 *      → PDF (bekræftet tilgængeligt via HTTP XML API af Domstolsstyrelsen)
 *   3. GET /ssl/bilag/<uuid>   ← fallback (virker kun for databaseTabel:"bilag")
 *      → PDF
 *
 * Bekræftet af Domstolsstyrelsen (e-tl-011@domstol.dk, 2026-04-13):
 * "Ikke digitale dokumenter kan ofte findes i de indskannede akter. [...]
 *  Akterne kan hentes via EjendomIndskannetAktHent."
 *
 * @param aktNavn - Akt-filnavn fra EjendomIndskannetAktSamling i ejdsummarisk
 * @returns PDF-binary hvis download lykkedes, ellers JSON 501 med metadata
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
export const maxDuration = 60;

// ─── Config ──────────────────────────────────────────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';

// ─── Types ───────────────────────────────────────────────────────────────────

interface IndskannetAktMeta {
  uuid: string;
  databaseTabel: string;
  filnavn: string;
}

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
 * Laver HTTPS GET request med client-certifikat (mTLS).
 *
 * @param urlPath - Sti relativt til /tinglysning/ssl
 * @param accept - Accept-header
 * @returns HTTP status, headers og body som Buffer
 */
function tlFetch(
  urlPath: string,
  accept: string
): Promise<{ status: number; headers: Record<string, string>; buffer: Buffer }> {
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
        timeout: 120000,
        headers: { Accept: accept },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 500,
            headers: res.headers as Record<string, string>,
            buffer: Buffer.concat(chunks),
          })
        );
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
    // Trin 1: Hent metadata (uuid + databaseTabel + filnavn) for aktNavn
    const metaRes = await tlFetch(
      `/indskannetakt/${encodeURIComponent(aktNavn)}`,
      'application/json, */*'
    );

    if (metaRes.status === 404) {
      return NextResponse.json({ error: 'Indskannet akt ikke fundet' }, { status: 404 });
    }

    if (metaRes.status !== 200 || metaRes.buffer.length === 0) {
      logger.error('[indskannede-akter/download] Metadata HTTP', metaRes.status);
      return NextResponse.json({ error: 'Tinglysning API fejl' }, { status: 502 });
    }

    let meta: IndskannetAktMeta;
    try {
      meta = JSON.parse(metaRes.buffer.toString('utf-8')) as IndskannetAktMeta;
    } catch {
      return NextResponse.json({ error: 'Uventet svar fra Tinglysning' }, { status: 502 });
    }

    // Trin 2: EjendomIndskannetAktHent — bekræftet korrekt endpoint af Domstolsstyrelsen 2026-04-13.
    // HTTP-sti: /ssl/ejendomindskannedakt/<aktNavn> (operationsnavn → URL-sti-konvention).
    const aktHentRes = await tlFetch(
      `/ejendomindskannedakt/${encodeURIComponent(aktNavn)}`,
      'application/pdf, application/octet-stream, */*'
    );

    if (aktHentRes.status === 200 && aktHentRes.buffer.subarray(0, 5).toString() === '%PDF-') {
      const safeFilename = aktNavn.replace(/[^a-zA-Z0-9\-_]/g, '_') + '.pdf';
      return new NextResponse(new Uint8Array(aktHentRes.buffer) as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${safeFilename}"`,
          'Content-Length': String(aktHentRes.buffer.byteLength),
          'Cache-Control': 'private, no-store',
        },
      });
    }

    logger.log(
      '[indskannede-akter/download] ejendomindskannedakt HTTP',
      aktHentRes.status,
      '— forsøger /bilag/<uuid> fallback'
    );

    // Trin 3: Fallback — /bilag/<uuid> (virker for databaseTabel:"bilag"-records)
    const bilagRes = await tlFetch(
      `/bilag/${meta.uuid}`,
      'application/pdf, application/octet-stream, */*'
    );

    if (bilagRes.status === 200 && bilagRes.buffer.subarray(0, 5).toString() === '%PDF-') {
      const safeFilename = aktNavn.replace(/[^a-zA-Z0-9\-_]/g, '_') + '.pdf';
      return new NextResponse(new Uint8Array(bilagRes.buffer) as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${safeFilename}"`,
          'Content-Length': String(bilagRes.buffer.byteLength),
          'Cache-Control': 'private, no-store',
        },
      });
    }

    // Trin 4: Alle forsøg fejlede — returner metadata med 501 så UI kan vise korrekt besked.
    logger.log(
      '[indskannede-akter/download] databaseTabel:',
      meta.databaseTabel,
      '— alle download-forsøg fejlede (ejendomindskannedakt + bilag)'
    );

    return NextResponse.json(
      {
        error: 'download_ikke_tilgaengelig',
        aktNavn,
        uuid: meta.uuid,
        filnavn: meta.filnavn,
        databaseTabel: meta.databaseTabel,
        besked:
          'Download-forsøg fejlede for alle kendte endpoints (EjendomIndskannetAktHent + bilag-fallback). Kontrollér korrekt HTTP-sti med Domstolsstyrelsen (e-tl-011@domstol.dk).',
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
