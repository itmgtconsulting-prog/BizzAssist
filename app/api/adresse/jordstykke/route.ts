/**
 * GET /api/adresse/jordstykke?lng=...&lat=...
 * GET /api/adresse/jordstykke?bfe=...
 *
 * Server-side proxy for DAR jordstykke-opslag.
 * Understøtter koordinatbaseret opslag og BFE-nummer opslag.
 *
 * @param request - Next.js request med ?lng=longitude&lat=latitude ELLER ?bfe=BFEnummer
 * @returns DawaJordstykke objekt eller null
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { darHentJordstykke, matHentJordstykkeByBfe } from '@/app/lib/dar';
import { fetchDawa } from '@/app/lib/dawa';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

/** Zod schema for BFE-baseret opslag */
const bfeQuerySchema = z.object({
  bfe: z.string().regex(/^\d{1,10}$/, 'BFE skal være et positivt heltal (max 10 cifre)'),
});

/** Zod schema for koordinatbaseret opslag */
const coordQuerySchema = z.object({
  lng: z.coerce.number(),
  lat: z.coerce.number(),
});

export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const bfe = request.nextUrl.searchParams.get('bfe');

  // BFE-baseret opslag — returnerer jordstykke + første adgangsadresse-UUID
  //
  // BIZZ-505: Flow:
  //   1. MAT GraphQL (MAT_SamletFastEjendom → MAT_Ejerlav) — primær kilde,
  //      løser ejerlavsnavn (som DAWA aldrig gav tilbage konsistent).
  //   2. DAWA /jordstykker — fallback hvis MAT null'er.
  //   3. DAWA /adgangsadresser — adgangsadresseId opslag (samme i begge stier
  //      — endnu en DAR/DAWA-migration, TODO separat ticket).
  if (bfe) {
    const bfeParsed = bfeQuerySchema.safeParse({ bfe });
    if (!bfeParsed.success) {
      return NextResponse.json(null, { status: 400 });
    }

    // Normalised shape we build up and return regardless of which path ran
    let jsOut: {
      matrikelnr: string;
      ejerlav: { kode: number; navn: string | null };
      registreretAreal: number | null;
      vejareal: number | null;
    } | null = null;

    // ── Primær: MAT GraphQL ─────────────────────────────────────────────
    try {
      const mat = await matHentJordstykkeByBfe(Number(bfe));
      if (mat) {
        jsOut = {
          matrikelnr: mat.matrikelnr,
          ejerlav: mat.ejerlav,
          registreretAreal: mat.registreretAreal,
          vejareal: mat.vejareal,
        };
      }
    } catch (err) {
      logger.error('[adresse/jordstykke] MAT lookup threw — falling through to DAWA', err);
    }

    // ── Fallback: DAWA ──────────────────────────────────────────────────
    if (!jsOut) {
      logger.warn(
        '[adresse/jordstykke] MAT returned null, falling back to DAWA (deadline 2026-07-01)'
      );
      try {
        const jsRes = await fetchDawa(
          `https://api.dataforsyningen.dk/jordstykker?bfenummer=${encodeURIComponent(bfe)}`,
          { signal: AbortSignal.timeout(5000) },
          { caller: 'adresse.jordstykke.bfe.fallback' }
        );
        if (!jsRes.ok) return NextResponse.json(null, { status: 200 });
        const jsData = await jsRes.json();
        if (!Array.isArray(jsData) || jsData.length === 0) {
          return NextResponse.json(null, { status: 200 });
        }
        const js = jsData[0] as {
          matrikelnr?: string;
          ejerlav?: { kode?: number; navn?: string };
          registreretareal?: number;
          vejareal?: number;
        };
        jsOut = {
          matrikelnr: String(js.matrikelnr ?? ''),
          ejerlav: {
            kode: Number(js.ejerlav?.kode ?? 0) || 0,
            navn: js.ejerlav?.navn ?? null,
          },
          registreretAreal: typeof js.registreretareal === 'number' ? js.registreretareal : null,
          vejareal: typeof js.vejareal === 'number' ? js.vejareal : null,
        };
      } catch {
        return NextResponse.json(null, { status: 200 });
      }
    }

    if (!jsOut) return NextResponse.json(null, { status: 200 });

    // ── AdgangsadresseId lookup (separat, bruges til "naviger til moder-ejendom" knap) ──
    // Endnu DAWA — kræver egen migration til DAR (se follow-up ticket).
    let adgangsadresseId: string | null = null;
    const ek = jsOut.ejerlav.kode;
    const mn = jsOut.matrikelnr;
    if (ek && mn) {
      try {
        const adgRes = await fetchDawa(
          `https://api.dataforsyningen.dk/adgangsadresser?ejerlavkode=${ek}&matrikelnr=${encodeURIComponent(mn)}&struktur=mini&per_side=1`,
          { signal: AbortSignal.timeout(5000) },
          { caller: 'adresse.jordstykke.ejerlav' }
        );
        if (adgRes.ok) {
          const adgData = (await adgRes.json()) as Array<{ id?: string }>;
          if (Array.isArray(adgData) && adgData.length > 0) {
            adgangsadresseId = adgData[0].id ?? null;
          }
        }
      } catch {
        /* non-fatal — adgangsadresseId stays null */
      }
    }

    return NextResponse.json(
      { ...jsOut, adgangsadresseId },
      {
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  }

  // Koordinatbaseret opslag
  const coordParsed = coordQuerySchema.safeParse({
    lng: request.nextUrl.searchParams.get('lng') ?? '',
    lat: request.nextUrl.searchParams.get('lat') ?? '',
  });

  if (!coordParsed.success) {
    return NextResponse.json(null, { status: 400 });
  }
  const { lng, lat } = coordParsed.data;

  try {
    const jordstykke = await darHentJordstykke(lng, lat);
    return NextResponse.json(jordstykke, {
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
    });
  } catch (err) {
    logger.error('[adresse/jordstykke] Fejl:', err);
    return NextResponse.json(null, { status: 200 });
  }
}
