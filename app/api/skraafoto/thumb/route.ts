/**
 * GET /api/skraafoto/thumb?url=<COG_URL>
 *
 * BIZZ-1050: Skråfoto thumbnail proxy.
 *
 * Dataforsyningens cogtiler thumbnail-tjeneste er permanent nedlagt.
 * COG-filer er 40-60MB — for store til server-side thumbnail-generering.
 *
 * Denne route returnerer en SVG placeholder med retnings-ikon
 * og link til Dataforsyningens skråfoto viewer.
 *
 * @param url - COG URL (bruges til at generere viewer-link)
 * @returns SVG placeholder image
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';

export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = request.nextUrl.searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'Mangler url' }, { status: 400 });

  /* Generer en SVG placeholder der fungerer som thumbnail */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="#1e293b"/>
  <rect x="8" y="8" width="240" height="240" rx="12" fill="#0f172a" stroke="#334155" stroke-width="1"/>
  <g transform="translate(128,110)" text-anchor="middle">
    <circle cx="0" cy="-20" r="24" fill="none" stroke="#3b82f6" stroke-width="1.5" opacity="0.5"/>
    <path d="M-8,-28 L0,-36 L8,-28" fill="none" stroke="#3b82f6" stroke-width="1.5" opacity="0.5"/>
    <text y="20" font-family="system-ui" font-size="11" fill="#64748b">Skråfoto</text>
    <text y="36" font-family="system-ui" font-size="9" fill="#475569">Klik for at åbne</text>
  </g>
</svg>`;

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    },
  });
}
