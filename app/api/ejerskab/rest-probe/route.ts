/**
 * GET /api/ejerskab/rest-probe
 *
 * DIAGNOSTISK endpoint — deaktiveret i produktion.
 *
 * Brugt til at teste Datafordeler REST-endpoints og GraphQL endpoint-versioner.
 * Konklusion: ingen REST-variant af EJFCustom virker med vores credentials,
 * og v2/v3 endpoints eksisterer ikke. Kun /flexibleCurrent/v1/ er tilgængelig.
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
