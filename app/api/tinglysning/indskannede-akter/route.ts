/**
 * GET /api/tinglysning/indskannede-akter?ejendomId=<uuid>
 *
 * Henter listen over tilgængelige indskannede akter for en ejendom via
 * Tinglysningsrettens EjendomStamoplysninger endpoint.
 *
 * Indskannede akter er pre-digitale dokumenter (typisk fra før 2009) som er
 * scannet ind og gemt i Tinglysningens bilagsbank som PDF-filer.
 *
 * @param ejendomId - Tinglysnings-UUID for ejendommen (fra /api/tinglysning)
 * @returns Liste af indskannede akter med AktNavn, AktType og dato
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

export interface IndskannetAkt {
  /** Akt-navn — bruges som parameter til download-endpointet */
  aktNavn: string;
  /** Menneskelig beskrivelse, fx "SKØDE" eller aktnavnet */
  beskrivelse: string | null;
  /** Tinglysningsdato eller anmeldelsesdato hvis tilgængeligt */
  dato: string | null;
  /** Sekventielt løbenummer (1-baseret position i samlingen) */
  loebNr: number;
}

export interface IndskannedeAkterResponse {
  ejendomId: string;
  akter: IndskannetAkt[];
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
 * Laver HTTPS GET request med client-certifikat (mTLS) og returnerer response body som tekst.
 *
 * @param urlPath - Sti relativt til /tinglysning/ssl
 * @returns HTTP status og XML-body
 */
function tlFetch(urlPath: string): Promise<{ status: number; body: string }> {
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
        timeout: 20000,
        headers: { Accept: 'application/xml, */*' },
      },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d.toString('utf-8')));
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
 * Parser XML fra EjendomStamoplysningerHentResultat og udtrækker indskannede akter.
 * Forventer EjendomIndskannetAktSamling → EjendomIndskannetAkt elementer.
 *
 * @param xml - XML-string fra EjendomStamoplysninger endpoint
 * @returns Liste af IndskannetAkt objekter
 */
function parseStamoplysningerXml(xml: string): IndskannetAkt[] {
  const akter: IndskannetAkt[] = [];

  // Find alle EjendomIndskannetAkt blokke
  const aktMatches = [
    ...xml.matchAll(
      /<(?:[a-zA-Z]+:)?EjendomIndskannetAkt>([\s\S]*?)<\/(?:[a-zA-Z]+:)?EjendomIndskannetAkt>/g
    ),
  ];

  for (let i = 0; i < aktMatches.length; i++) {
    const block = aktMatches[i][1];

    // AktNavn er identifikatoren der bruges til download
    const aktNavn = block.match(/<(?:[a-zA-Z]+:)?AktNavn[^>]*>([^<]+)/)?.[1]?.trim() ?? null;
    if (!aktNavn) continue;

    // Beskrivelse — AktType eller AktBeskrivelse
    const aktType =
      block.match(/<(?:[a-zA-Z]+:)?AktType[^>]*>([^<]+)/)?.[1]?.trim() ??
      block.match(/<(?:[a-zA-Z]+:)?AktBeskrivelse[^>]*>([^<]+)/)?.[1]?.trim() ??
      null;

    // Dato — AnmeldelseDato eller TinglysningsDato
    const dato =
      block.match(/<(?:[a-zA-Z]+:)?AnmeldelseDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ??
      block.match(/<(?:[a-zA-Z]+:)?TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ??
      block.match(/<(?:[a-zA-Z]+:)?Dato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ??
      null;

    akter.push({
      aktNavn,
      beskrivelse: aktType,
      dato,
      loebNr: i + 1,
    });
  }

  return akter;
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const limited = await checkRateLimit(req, heavyRateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ejendomId = req.nextUrl.searchParams.get('ejendomId');

  if (!ejendomId) {
    return NextResponse.json({ error: 'ejendomId parameter er påkrævet' }, { status: 400 });
  }

  // Valider UUID-format
  if (!/^[0-9a-f-]{30,40}$/i.test(ejendomId)) {
    return NextResponse.json({ error: 'ejendomId har ugyldigt format' }, { status: 400 });
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { error: 'Tinglysning certifikat ikke konfigureret' },
      { status: 503 }
    );
  }

  try {
    const res = await tlFetch(`/ejendomstamoplysninger?ejendomId=${encodeURIComponent(ejendomId)}`);

    if (res.status === 404) {
      return NextResponse.json({ ejendomId, akter: [] } satisfies IndskannedeAkterResponse, {
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      });
    }

    if (res.status !== 200) {
      logger.error('[indskannede-akter] Tinglysning HTTP', res.status);
      return NextResponse.json({ error: 'Tinglysning API fejl' }, { status: 502 });
    }

    const akter = parseStamoplysningerXml(res.body);

    const result: IndskannedeAkterResponse = { ejendomId, akter };

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[indskannede-akter] Fejl:', msg);
    const body =
      process.env.NODE_ENV === 'development'
        ? { error: 'Ekstern API fejl', dev_detail: msg }
        : { error: 'Ekstern API fejl' };
    return NextResponse.json(body, { status: 500 });
  }
}
