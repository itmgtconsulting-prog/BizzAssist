/**
 * Reverse geocoding proxy — finder nærmeste adresse for en koordinat.
 * Erstatter direkte DAWA-kald fra client-side (DAWA lukker 1. juli 2026).
 *
 * GET /api/adresse/reverse?lng=12.57&lat=55.68
 * @returns { adresse: string, id: string | null }
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';

// const DAR_ENDPOINT = 'https://graphql.datafordeler.dk/DAR/v1';
// TODO(BIZZ-92): DAR GraphQL doesn't support spatial queries yet — enable when it does (before July 2026).

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
  const { searchParams } = new URL(request.url);
  const lng = parseFloat(searchParams.get('lng') ?? '');
  const lat = parseFloat(searchParams.get('lat') ?? '');

  if (isNaN(lng) || isNaN(lat)) {
    return NextResponse.json({ adresse: null, id: null }, { status: 400 });
  }

  // DAWA fallback (virker til 1. juli 2026)
  try {
    const res = await fetch(
      `https://api.dataforsyningen.dk/adgangsadresser/reverse?x=${lng}&y=${lat}&struktur=mini`,
      { signal: AbortSignal.timeout(5000) }
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
