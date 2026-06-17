/**
 * GET /api/dmr/regnr/[regnr]
 *
 * BIZZ-2144: DMR-berigelse af bilforsikringspolicer.
 *
 * Proxy til tjekbil.dk's offentlige v3-API (køretøjsdata fra Motorregistret).
 * Returnerer normaliseret DmrData for ét registreringsnummer, så frontend og
 * gap-motor kan krydstjekke en bilforsikringspolice mod den faktiske
 * registrerings- og forsikringsstatus i DMR.
 *
 * Input:   path-param `regnr` (valideres mod dansk regnr-format før opslag)
 * Output:  DmrData (200) | { dmr: null } (200, ingen data) | fejl-objekt
 *
 * Auth:    kræver gyldig tenant-session (resolveTenantId → 401).
 * GDPR:    sender kun registreringsnummer (køretøjsdata, ikke person-PII) til
 *          tjekbil.dk. Ingen lokal persistering. tjekbil.dk er under-databehandler
 *          (app/privacy/page.tsx). 24-timers in-memory LRU-cache i dmr-lib.
 *
 * @module api/dmr/regnr/[regnr]
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';
import { fetchDmrByRegnr, normalizeRegnr, erGyldigtRegnr } from '@/app/lib/forsikring/dmr';

/**
 * Hent normaliseret DMR-data for et registreringsnummer.
 *
 * @param _request - Next.js request (ubrugt)
 * @param context - Route-kontekst med async params (regnr)
 * @returns DmrData som JSON, eller { dmr: null } hvis intet køretøj fundet
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ regnr: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { regnr } = await context.params;
  const norm = normalizeRegnr(regnr);
  if (!erGyldigtRegnr(norm)) {
    return NextResponse.json({ error: 'Ugyldigt registreringsnummer' }, { status: 400 });
  }

  try {
    const dmr = await fetchDmrByRegnr(norm);
    return NextResponse.json({ dmr });
  } catch (err) {
    // Log uden PII (registreringsnummer er køretøjsdata, men hold logs rene)
    logger.error('[dmr/regnr GET] opslag fejlede', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
