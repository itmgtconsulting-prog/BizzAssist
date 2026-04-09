/**
 * GET /api/tinglysning?bfe=100165718
 *
 * Henter tingbogsdata for en ejendom via Tinglysningsrettens HTTP API.
 * Bruger 2-vejs SSL med OCES systemcertifikat (NemID/MitID).
 *
 * Miljøer:
 *   Test: https://test.tinglysning.dk/tinglysning/ssl/
 *   Prod: https://www.tinglysning.dk/tinglysning/ssl/
 *
 * @param bfe - BFE-nummer (Bestemt Fast Ejendom)
 * @returns TinglysningData objekt
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 60;
import https from 'https';
import fs from 'fs';
import path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TinglysningData {
  /** BFE-nummer */
  bfe: number;
  /** Tinglysnings-UUID (til opslag) */
  uuid: string;
  /** Fuld adresse */
  adresse: string;
  /** Matrikel-info */
  vedroerende: string;
  /** Ejendomstype (ejerlejlighed, grund, etc.) */
  ejendomstype: string | null;
  /** Ejerlejlighedsnummer */
  ejerlejlighedNr: number | null;
  /** Tinglyst areal i kvm (fra tingbogen) */
  tinglystAreal: number | null;
  /** Fordelingstal (tæller/nævner) */
  fordelingstal: { taeller: number; naevner: number } | null;
  /** Ejendomsvurdering */
  ejendomsVurdering: number | null;
  /** Grundværdi */
  grundVaerdi: number | null;
  /** Vurderingsdato */
  vurderingsDato: string | null;
  /** Ejendomsnummer */
  ejendomsnummer: string | null;
  /** Kommunenummer */
  kommuneNummer: string | null;
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** Cert path + password fra env — brug TINGLYSNING_CERT_* for produktion, NEMLOGIN_DEVTEST4_CERT_* for test */
const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
/** Base64-encodet certifikat — bruges i serverless (Vercel) hvor filsystemet ikke er tilgængeligt */
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';

/** Base URL — test vs prod */
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';
const TL_API_PATH = '/tinglysning/ssl';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Laver HTTPS request med client-certifikat (mTLS) */
function tlFetch(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    if (CERT_B64) {
      pfx = Buffer.from(CERT_B64, 'base64');
    } else {
      const certAbsPath = path.resolve(CERT_PATH);
      if (!fs.existsSync(certAbsPath)) {
        reject(new Error('Certifikat ikke fundet: ' + certAbsPath));
        return;
      }
      pfx = fs.readFileSync(certAbsPath);
    }
    const url = new URL(TL_BASE + TL_API_PATH + urlPath);

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        pfx,
        passphrase: CERT_PASSWORD,
        rejectUnauthorized: false,
        // test.tinglysning.dk kan svare langsomt (op til 6-7s) — 20s timeout giver margin.
        // Prod-miljøet er væsentligt hurtigere.
        timeout: 20000,
        headers: { Accept: 'application/json, application/xml, */*' },
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

/** Parser XML-respons fra ejdsummarisk og udtrækker nøgledata */
function parseEjdsummariskXml(xml: string): Partial<TinglysningData> {
  const result: Partial<TinglysningData> = {};

  // Ejerlejlighedsnummer
  const ejlNr = xml.match(/Ejerlejlighedsnummer[^>]*>(\d+)/);
  if (ejlNr) result.ejerlejlighedNr = parseInt(ejlNr[1], 10);

  // Ejendomstype
  if (xml.includes('<ns7:Ejerlejlighed>') || xml.includes('Ejerlejlighed')) {
    result.ejendomstype = 'Ejerlejlighed';
  }

  // Tinglyst areal — findes som tekst: "Ejerlejlighedens tinglyste areal" → "72 kvm"
  const arealMatch = xml.match(/tinglyste?\s+areal[^<]*<[^>]*>[^<]*<[^>]*>(\d+)\s*kvm/i);
  if (arealMatch) {
    result.tinglystAreal = parseInt(arealMatch[1], 10);
  }

  // Fordelingstal
  const taellerMatch = xml.match(/<ns7:Taeller>(\d+)<\/ns7:Taeller>/);
  const naevnerMatch = xml.match(/<ns7:Naevner>(\d+)<\/ns7:Naevner>/);
  if (taellerMatch && naevnerMatch) {
    result.fordelingstal = {
      taeller: parseInt(taellerMatch[1], 10),
      naevner: parseInt(naevnerMatch[1], 10),
    };
  }

  return result;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const limited = await checkRateLimit(req, heavyRateLimit);
  if (limited) return limited;

  const bfe = req.nextUrl.searchParams.get('bfe');

  if (!bfe || !/^\d+$/.test(bfe)) {
    return NextResponse.json({ error: 'bfe parameter er påkrævet (numerisk)' }, { status: 400 });
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { error: 'Tinglysning certifikat ikke konfigureret' },
      { status: 503 }
    );
  }

  try {
    // Trin 1: Søg ejendom med BFE-nummer
    const searchRes = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
    if (searchRes.status !== 200) {
      return NextResponse.json(
        { error: `Tinglysning søgning fejlede: ${searchRes.status}` },
        { status: searchRes.status }
      );
    }

    const searchData = JSON.parse(searchRes.body);
    let items = searchData?.items ?? [];

    /**
     * Test-miljø fallback: Når BFE ikke findes i test.tinglysning.dk,
     * bruger vi et kendt test-BFE (100165718) så UI'et kan vises med rigtige data.
     * Fjernes når TINGLYSNING_BASE_URL skiftes til prod.
     */
    const erTestMiljoe = TL_BASE.includes('test.tinglysning.dk');
    let erTestFallback = false;
    if (items.length === 0 && erTestMiljoe) {
      const TEST_BFE = '100165718';
      const fallbackRes = await tlFetch(
        `/ejendom/hovednoteringsnummer?hovednoteringsnummer=${TEST_BFE}`
      );
      if (fallbackRes.status === 200) {
        const fallbackData = JSON.parse(fallbackRes.body);
        items = fallbackData?.items ?? [];
        erTestFallback = true;
      }
    }

    if (items.length === 0) {
      return NextResponse.json({ error: 'Ejendom ikke fundet i tingbogen' }, { status: 404 });
    }

    const item = items[0];
    const uuid = item.uuid;

    // Trin 2: Hent summariske oplysninger med UUID
    const detailRes = await tlFetch(`/ejdsummarisk/${uuid}`);
    let extraData: Partial<TinglysningData> = {};
    if (detailRes.status === 200) {
      extraData = parseEjdsummariskXml(detailRes.body);
    }

    const result: TinglysningData & { testFallback?: boolean } = {
      bfe: parseInt(bfe, 10),
      uuid,
      adresse: item.adresse ?? '',
      vedroerende: item.vedroerende ?? '',
      ejendomstype: extraData.ejendomstype ?? null,
      ejerlejlighedNr: extraData.ejerlejlighedNr ?? null,
      tinglystAreal: extraData.tinglystAreal ?? null,
      fordelingstal: extraData.fordelingstal ?? null,
      ejendomsVurdering: item.ejendomsVurdering ?? null,
      grundVaerdi: item.grundVaerdi ?? null,
      vurderingsDato: item.vurderingsDato ?? null,
      ejendomsnummer: item.ejendomsnummer ?? null,
      kommuneNummer: item.kommuneNummer ?? null,
      ...(erTestFallback && { testFallback: true }),
    };

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[tinglysning] Fejl:', msg);
    // Expose actual error in dev so we can diagnose cert/connection issues
    const body =
      process.env.NODE_ENV === 'development'
        ? { error: 'Ekstern API fejl', dev_detail: msg }
        : { error: 'Ekstern API fejl' };
    return NextResponse.json(body, { status: 500 });
  }
}
