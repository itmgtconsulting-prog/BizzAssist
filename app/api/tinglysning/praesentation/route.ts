/**
 * POST /api/tinglysning/praesentation
 *
 * Konverterer et Tinglysning XML-dokument til PDF via Tinglysningsrettens
 * præsentationsservice. Brugbart til digitale dokumenter (anmeldt efter ca. 2009)
 * hvor man ønsker den officielle PDF-gengivelse frem for vores pdfkit-genererede version.
 *
 * Endpoint-URL: POST /tinglysning/ssl/praesentation
 * Request body: XML-dokument (typisk en DokumentAktuelHentResultat fra /dokaktuel/uuid/<uuid>)
 * Response: PDF binær data
 *
 * Alternativt kan man sende et UUID direkte (query param), hvorefter ruten
 * henter dokumentets XML og sender det videre til præsentationstjenesten.
 *
 * BEMÆRK: Den præcise URL til præsentationsservicen bør verificeres med
 * Domstolsstyrelsen hvis tjenesten ikke svarer korrekt — se e-tl-011@domstol.dk
 *
 * @param uuid - (query, valgfrit) Dokument UUID — hvis angivet hentes XML automatisk
 * @body XML-dokument der skal konverteres til PDF (ignoreres hvis uuid er angivet)
 * @returns PDF-dokument med Content-Disposition header
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';
import { tlFetch as tlFetchShared } from '@/app/lib/tlFetch';
import https from 'https';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const maxDuration = 120;

// ─── Config (kun for POST/binær — GET bruger delt lib) ──────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Loader certifikat som Buffer — bruges kun af POST-varianten */
function loadCert(): Buffer {
  if (CERT_B64) return Buffer.from(CERT_B64, 'base64');
  return fs.readFileSync(path.resolve(CERT_PATH));
}

/** Henter dokument-XML fra Tinglysning via GET (delt lib med proxy-support) */
function tlFetchXml(urlPath: string): Promise<{ status: number; body: string }> {
  return tlFetchShared(urlPath, { accept: 'application/xml, */*', timeout: 20000 });
}

/**
 * Sender et XML-dokument til Tinglysnings præsentationsservice via POST med mTLS.
 * Returnerer PDF-data som Buffer.
 *
 * Endpoint: POST /tinglysning/ssl/praesentation
 * Body: XML-dokument
 *
 * @param xmlBody - XML-string der sendes til præsentationsservicen
 * @returns HTTP status, Content-Type og PDF-data som Buffer
 */
function tlPostPraesentation(
  xmlBody: string
): Promise<{ status: number; buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    try {
      pfx = loadCert();
    } catch (e) {
      reject(e);
      return;
    }

    const bodyBuf = Buffer.from(xmlBody, 'utf-8');
    const url = new URL(TL_BASE + '/tinglysning/ssl/praesentation');

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        pfx,
        passphrase: CERT_PASSWORD,
        rejectUnauthorized: false,
        timeout: 60000,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Length': bodyBuf.byteLength,
          Accept: 'application/pdf, application/octet-stream, */*',
        },
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
      reject(new Error('Timeout fra præsentationsservice'));
    });
    req.write(bodyBuf);
    req.end();
  });
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const limited = await checkRateLimit(req, heavyRateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { error: 'Tinglysning certifikat ikke konfigureret' },
      { status: 503 }
    );
  }

  try {
    // Hvis uuid er angivet som query param — hent XML fra Tinglysning og send til præsentation
    const uuid = req.nextUrl.searchParams.get('uuid');

    let xmlBody: string;

    if (uuid) {
      // UUID tilladte tegn: hex og bindestreg
      if (!/^[0-9a-f-]{30,40}$/i.test(uuid)) {
        return NextResponse.json({ error: 'uuid har ugyldigt format' }, { status: 400 });
      }

      const docRes = await tlFetchXml(`/dokaktuel/uuid/${uuid}`);
      if (docRes.status !== 200) {
        return NextResponse.json({ error: 'Dokument ikke fundet' }, { status: 404 });
      }
      xmlBody = docRes.body;
    } else {
      // Brug request body som XML
      const contentType = req.headers.get('content-type') ?? '';
      if (!contentType.includes('xml') && !contentType.includes('text')) {
        return NextResponse.json(
          { error: 'Content-Type skal være application/xml eller text/xml' },
          { status: 415 }
        );
      }

      const bodyText = await req.text();
      if (!bodyText || bodyText.length < 10) {
        return NextResponse.json({ error: 'XML-body er tom eller for kort' }, { status: 400 });
      }

      // Grundlæggende kontrol af at det ligner XML
      if (!bodyText.trim().startsWith('<')) {
        return NextResponse.json({ error: 'Body er ikke gyldig XML' }, { status: 400 });
      }

      xmlBody = bodyText;
    }

    const res = await tlPostPraesentation(xmlBody);

    if (res.status === 404) {
      return NextResponse.json(
        { error: 'Dokument ikke fundet i præsentationsservicen' },
        { status: 404 }
      );
    }

    if (res.status === 405) {
      // POST ikke understøttet — præsentationsservicens URL er forkert
      logger.error('[praesentation] 405 Method Not Allowed — bekræft URL med Domstolsstyrelsen');
      return NextResponse.json(
        {
          error: 'Præsentationsservice ikke tilgængelig',
          hint: 'Bekræft endpoint-URL med Domstolsstyrelsen (e-tl-011@domstol.dk)',
        },
        { status: 502 }
      );
    }

    if (res.status !== 200) {
      logger.error('[praesentation] Tinglysning HTTP', res.status);
      return NextResponse.json({ error: 'Tinglysning API fejl' }, { status: 502 });
    }

    // Verificer at svaret er en PDF
    if (!res.contentType.includes('pdf') && res.buffer.subarray(0, 5).toString() !== '%PDF-') {
      logger.error(
        '[praesentation] Uventet Content-Type:',
        res.contentType,
        '— første bytes:',
        res.buffer.subarray(0, 20).toString()
      );
      return NextResponse.json(
        { error: 'Præsentationsservice returnerede ikke PDF', contentType: res.contentType },
        { status: 502 }
      );
    }

    const filename = uuid ? `tinglysning-${uuid.slice(0, 8)}.pdf` : `tinglysning-dokument.pdf`;

    return new NextResponse(new Uint8Array(res.buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length': String(res.buffer.byteLength),
        // Ingen offentlig cache — dokumenter kan indeholde fortrolige data
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[praesentation] Fejl:', msg);
    const body =
      process.env.NODE_ENV === 'development'
        ? { error: 'Ekstern API fejl', dev_detail: msg }
        : { error: 'Ekstern API fejl' };
    return NextResponse.json(body, { status: 500 });
  }
}
