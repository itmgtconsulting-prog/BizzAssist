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
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';

export const runtime = 'nodejs';
export const maxDuration = 60;
import { tlFetch } from '@/app/lib/tlFetch';
import { logger } from '@/app/lib/logger';

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

// ─── Helpers ────────────────────────────────────────────────────────────────

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

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  /** Zod schema for tinglysning query params */
  const tinglysningSchema = z.object({
    bfe: z.string().regex(/^\d+$/, 'bfe parameter er påkrævet (numerisk)'),
  });

  const parsed = parseQuery(req, tinglysningSchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bfe parameter er påkrævet (numerisk)' }, { status: 400 });
  }
  const { bfe } = parsed.data;

  const hasCert = !!(
    process.env.TINGLYSNING_CERT_PATH ||
    process.env.NEMLOGIN_DEVTEST4_CERT_PATH ||
    process.env.TINGLYSNING_CERT_B64 ||
    process.env.NEMLOGIN_DEVTEST4_CERT_B64
  );
  const hasProxy = !!process.env.DF_PROXY_URL;
  const hasPassword = !!(
    process.env.TINGLYSNING_CERT_PASSWORD || process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD
  );

  if (!hasProxy && (!hasCert || !hasPassword)) {
    return NextResponse.json(
      { error: 'Tinglysning certifikat ikke konfigureret' },
      { status: 503 }
    );
  }

  try {
    // Trin 1: Søg ejendom med BFE-nummer
    const searchRes = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
    if (searchRes.status !== 200) {
      return NextResponse.json({ error: 'Tinglysning API fejl' }, { status: 502 });
    }

    const searchData = JSON.parse(searchRes.body);
    let items = searchData?.items ?? [];

    /**
     * Test-miljø fallback: Når BFE ikke findes i test.tinglysning.dk,
     * bruger vi et kendt test-BFE (100165718) så UI'et kan vises med rigtige data.
     * Fjernes når TINGLYSNING_BASE_URL skiftes til prod.
     */
    const erTestMiljoe = (process.env.TINGLYSNING_BASE_URL ?? '').includes('test.tinglysning.dk');
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
    logger.error('[tinglysning] Fejl:', msg);
    // Expose actual error in dev so we can diagnose cert/connection issues
    const body =
      process.env.NODE_ENV === 'development'
        ? { error: 'Ekstern API fejl', dev_detail: msg }
        : { error: 'Ekstern API fejl' };
    return NextResponse.json(body, { status: 500 });
  }
}
