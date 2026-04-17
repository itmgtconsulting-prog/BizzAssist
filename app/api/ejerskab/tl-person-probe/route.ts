/**
 * GET /api/ejerskab/tl-person-probe
 *
 * DIAGNOSTISK endpoint — deaktiveret i produktion.
 *
 * Brugt til at teste Tinglysning person-endpoints (se BIZZ-XXX EJF bulk-ingestion).
 * Konklusion: soegpersonbogcvr returnerer kun personbog-UUID (løsøre),
 * ikke ejendom-adkomster. Tinglysning har ikke et person→ejendomme endpoint.
 *
 * Re-aktivering: Se git-historik for fuld probe-implementering.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(
    { error: 'Diagnostic endpoint disabled in production' },
    { status: 410 }
  );
}
