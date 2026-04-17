/**
 * Reverse geocoding proxy — finder nærmeste adresse for en koordinat.
 *
 * Flow (BIZZ-503):
 *   1. Datafordeler DAR WFS med CQL_FILTER DWITHIN (primær)
 *   2. DAWA /adgangsadresser/reverse (fallback indtil DAWA lukker 2026-07-01)
 *
 * Erstatter direkte DAWA-kald fra client-side så vi ikke skal fjerne alle
 * kald-sites samtidig med DAWA-nedlukningen.
 *
 * GET /api/adresse/reverse?lng=12.57&lat=55.68
 * @returns { adresse: string, id: string | null }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { fetchDawa } from '@/app/lib/dawa';
import { darReverseGeocode } from '@/app/lib/dar';
import { logger } from '@/app/lib/logger';

/** Zod schema for reverse geocoding query params */
const reverseSchema = z.object({
  lng: z.coerce.number(),
  lat: z.coerce.number(),
});

/**
 * Reverse geocoder — finder nærmeste adresse for koordinat.
 *
 * BIZZ-503: Forsøger Datafordeler DAR WFS først; falder tilbage til DAWA
 * (som lukker 1. juli 2026). Fallbacken bevares som safety net indtil
 * DAR-pathen er verificeret i produktion.
 *
 * @param request - NextRequest med lng og lat query params
 * @returns JSON med adresse-streng og DAR id
 */
export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, reverseSchema);
  if (!parsed.success) return NextResponse.json({ adresse: null, id: null }, { status: 400 });
  const { lng, lat } = parsed.data;

  // ── Primær: Datafordeler DAR WFS ────────────────────────────────────────
  const darResult = await darReverseGeocode(lng, lat);
  if (darResult) {
    return NextResponse.json(darResult);
  }

  // ── Fallback: DAWA (logget som deprecated via fetchDawa) ────────────────
  logger.warn(
    '[adresse/reverse] DAR WFS returned no result, falling back to DAWA (deadline 2026-07-01)'
  );
  try {
    const res = await fetchDawa(
      `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${lng}&y=${lat}&struktur=mini`,
      { signal: AbortSignal.timeout(5000) },
      { caller: 'adresse.reverse.fallback' }
    );
    if (!res.ok) return NextResponse.json({ adresse: null, id: null });
    const d = (await res.json()) as Record<string, unknown>;
    const adresse =
      `${d.vejnavn ?? ''} ${d.husnr ?? ''}`.trim() +
      (d.postnr ? `, ${d.postnr} ${d.postnrnavn ?? ''}` : '');
    return NextResponse.json({
      adresse: adresse.replace(/^,\s*/, ''),
      id: typeof d.id === 'string' ? d.id : null,
    });
  } catch {
    return NextResponse.json({ adresse: null, id: null }, { status: 502 });
  }
}
