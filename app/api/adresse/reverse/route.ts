/**
 * Reverse geocoding proxy — finder nærmeste adresse for en koordinat.
 * Erstatter direkte DAWA-kald fra client-side (DAWA lukker 1. juli 2026).
 *
 * GET /api/adresse/reverse?lng=12.57&lat=55.68
 * @returns { adresse: string, id: string | null }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { fetchDawa } from '@/app/lib/dawa';

// const DAR_ENDPOINT = 'https://graphql.datafordeler.dk/DAR/v1';
// TODO(BIZZ-92): DAR GraphQL doesn't support spatial queries yet — enable when it does (before July 2026).

/** Zod schema for reverse geocoding query params */
const reverseSchema = z.object({
  lng: z.coerce.number(),
  lat: z.coerce.number(),
});

/**
 * Reverse geocoder — finder nærmeste adresse for koordinat.
 * Bruger DAWA (falder tilbage til DAR GraphQL når spatial queries understøttes).
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

  // DAWA fallback (virker til 1. juli 2026)
  try {
    const res = await fetchDawa(
      `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${lng}&y=${lat}&struktur=mini`,
      { signal: AbortSignal.timeout(5000) },
      { caller: 'adresse.reverse' }
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
