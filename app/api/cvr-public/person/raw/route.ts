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
  // BIZZ-598: Stub endpoint returnerer altid 410 Gone, men tilføj try/catch
  // så eventuel uforudset build-time eller runtime-fejl ikke bryder
  // deployet (fx hvis diagnostic senere genaktiveres med external fetch).
  try {
    return NextResponse.json(
      { error: 'Diagnostic endpoint disabled in production' },
      { status: 410 }
    );
  } catch {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
