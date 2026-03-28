/**
 * GET /api/energimaerke/pdf/[id]
 *
 * Proxy-route der henter en energimærke-PDF fra EMO-servicen med Basic Auth
 * og streamer den til klienten. Klienten behøver ikke kende EMO-credentials.
 *
 * @param params.id - EMO EnergyLabelSerialIdentifier (URL-encoded)
 * @returns PDF stream med Content-Type: application/pdf
 */

import { NextRequest, NextResponse } from 'next/server';

const EMO_BASE = 'https://emoweb.dk/EMOData/EMOData.svc';

/** Bygger HTTP Basic Auth header fra EMO credentials i .env.local */
function basicAuth(): string {
  const u = process.env.EMO_USERNAME ?? '';
  const p = process.env.EMO_PASSWORD ?? '';
  return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!process.env.EMO_USERNAME || !process.env.EMO_PASSWORD) {
    return new NextResponse('EMO credentials mangler', { status: 503 });
  }

  const url = `${EMO_BASE}/GetEnergyLabelPdfToBrowser/${encodeURIComponent(id)}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: basicAuth() },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return new NextResponse(`EMO PDF fejl: HTTP ${res.status}`, { status: res.status });
    }

    const pdfBuffer = await res.arrayBuffer();

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="energimaerke-${id}.pdf"`,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    console.error('[Energimærke PDF] Fejl:', err);
    return new NextResponse('Timeout ved hentning af PDF', { status: 504 });
  }
}
