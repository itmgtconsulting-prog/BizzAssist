/**
 * GET /api/ejerskab/filter-probe
 *
 * DIAGNOSTISK endpoint — deaktiveret i produktion.
 *
 * Brugt til at afdække hvilke filter-felter og root-queries EJF Custom
 * GraphQL eksponerer (se BIZZ-XXX EJF bulk-ingestion).
 * Konklusion: kun BFE- og CVR-filtre, ingen person-filter.
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
