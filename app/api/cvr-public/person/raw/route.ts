/**
 * GET /api/cvr-public/person/raw?enhedsNummer=<N>
 *
 * DIAGNOSTISK endpoint — deaktiveret i produktion.
 *
 * Brugt til at inspicere CVR ES Vrdeltagerperson-record for at finde ud af
 * hvilke felter (specielt foedselsdato) der er tilgængelige.
 * Konklusion: CVR ES eksponerer ikke foedselsdato for personer.
 * Beliggenhedsadresse og virksomhedsrelationer er dog tilgængelige.
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
