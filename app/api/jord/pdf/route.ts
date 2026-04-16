/**
 * GET /api/jord/pdf
 *
 * Server-side proxy der henter Jordforureningsattesten som PDF fra Miljøportalen.
 * jord.miljoeportal.dk/report returnerer en PDF direkte, men kræver browser-lignende
 * headers (User-Agent m.m.) — ellers returnerer serveren en HTML-fejlside.
 * Denne route henter PDF'en server-side med korrekte headers og streamer den videre.
 *
 * Query-parametre:
 *   elav    - Ejerlavkode (fx "12851")
 *   matrnr  - Matrikelnummer (fx "21cn")
 *
 * @param request - Next.js GET request med query-parametre
 * @returns PDF-fil som attachment, eller JSON-fejl ved ugyldig input/timeout
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

export const runtime = 'nodejs';

/** Timeout for fetch til Miljøportalen (ms) */
const FETCH_TIMEOUT_MS = 30000;

/** PDF magic bytes: de første 4 bytes skal være %PDF */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;

/**
 * Tjekker om en ArrayBuffer starter med PDF magic bytes (%PDF).
 *
 * @param buf - ArrayBuffer at validere
 * @returns true hvis bufferen indeholder en gyldig PDF
 */
function erGyldigPdf(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const bytes = new Uint8Array(buf, 0, 4);
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { searchParams } = new URL(request.url);
  const elav = searchParams.get('elav');
  const matrnr = searchParams.get('matrnr');

  if (!elav || !matrnr) {
    return NextResponse.json(
      { fejl: 'Query-parametre elav og matrnr er påkrævet' },
      { status: 400 }
    );
  }

  // Miljøportalens direkte PDF-endpoint (ikke /report som er en PDF.js-viewer HTML-side)
  const kildeSide = `https://jord.miljoeportal.dk/report/generate?elav=${encodeURIComponent(elav)}&matrnr=${encodeURIComponent(matrnr)}`;

  try {
    // Fetch med browser-lignende headers — Miljøportalen afviser server-fetch uden User-Agent
    const res = await fetch(kildeSide, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/pdf,application/octet-stream,*/*',
        'Accept-Language': 'da-DK,da;q=0.9,en;q=0.8',
        Referer: 'https://jord.miljoeportal.dk/',
      },
    });

    if (!res.ok) {
      logger.error(
        `[jord/pdf] Miljøportalen svarede HTTP ${res.status} for elav=${elav} matrnr=${matrnr}`
      );
      return NextResponse.json(
        { fejl: `Miljøportalen svarede med HTTP ${res.status}` },
        { status: 502 }
      );
    }

    const arrayBuf = await res.arrayBuffer();

    // Validér at vi fik en rigtig PDF og ikke en HTML-fejlside
    if (!erGyldigPdf(arrayBuf)) {
      const første = Array.from(new Uint8Array(arrayBuf, 0, Math.min(12, arrayBuf.byteLength)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      logger.error(`[jord/pdf] Ikke en gyldig PDF fra Miljøportalen. Første bytes: ${første}`);
      return NextResponse.json(
        { fejl: 'Miljøportalen returnerede ikke en gyldig PDF' },
        { status: 502 }
      );
    }

    const sikkertMatrnr = matrnr.replace(/[^a-zA-Z0-9æøåÆØÅ]/g, '_');

    return new Response(arrayBuf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Jordforureningsattest_${sikkertMatrnr}.pdf"`,
        // Cache i 24 timer — attesten ændrer sig sjældent
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (err) {
    const besked = err instanceof Error ? err.message : String(err);
    logger.error('[jord/pdf] Fetch fejlede:', besked);
    const body =
      process.env.NODE_ENV === 'development'
        ? { fejl: 'Ekstern API fejl', dev_detail: besked }
        : { fejl: 'Ekstern API fejl' };
    return NextResponse.json(body, { status: 502 });
  }
}
