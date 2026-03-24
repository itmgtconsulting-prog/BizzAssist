/**
 * GET /api/ejerskab
 *
 * Henter ejeroplysninger (Ejerfortegnelsen) fra Datafordeler for en given
 * ejendom identificeret ved BFEnummer.
 *
 * Returnerer aktuelle ejere med navn, CVR/CPR-type, ejerandel og overtagelsesdato.
 * For selskabsejere returneres CVR-nummer (offentlig data).
 * For private personer returneres kun navn (CPR returneres IKKE uden separat adgang).
 *
 * Authentication: DATAFORDELER_API_KEY i .env.local
 *
 * @param request - Next.js request med ?bfeNummer=xxx
 * @returns { ejere: EjerData[], fejl: string | null, manglerNoegle: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Types ───────────────────────────────────────────────────────────────────

/** En enkelt ejer fra Ejerfortegnelsen */
export interface EjerData {
  navn: string;
  /** CVR-nummer hvis selskabsejer — ellers null */
  cvr: string | null;
  /** Ejerandel i procent (0–100) */
  ejerandel: number | null;
  /** Dato for overtagelse (ISO 8601) */
  overtagelsesdato: string | null;
  /** "selskab" | "person" | "ukendt" */
  ejertype: 'selskab' | 'person' | 'ukendt';
  /** Ejendomsadministrator */
  administrator: boolean;
}

/** API-svaret fra denne route */
export interface EjerskabResponse {
  bfeNummer: number | null;
  ejere: EjerData[];
  fejl: string | null;
  manglerNoegle: boolean;
}

// ─── Datafordeler endpoint ───────────────────────────────────────────────────

const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';
const DF_USERNAME = process.env.DATAFORDELER_USERNAME ?? '';
const DF_PASSWORD = process.env.DATAFORDELER_PASSWORD ?? '';
const DF_BASE = 'https://services.datafordeler.dk/EBR/Ejerfortegnelsen/1/REST/HentEjendom';

// ─── Rå typer fra Datafordeler Ejerfortegnelse ───────────────────────────────

interface RawEjer {
  Navn?: string;
  CVRNummer?: string;
  Ejerandel?: number;
  Overtagelsesdato?: string;
  EjertypeKode?: string;
  ErAdministrator?: boolean;
}

interface RawEjendomResponse {
  Ejere?: RawEjer[];
  BFENummer?: number;
}

// ─── Hjælpefunktion ──────────────────────────────────────────────────────────

/**
 * Bestemmer ejertype ud fra EjertypeKode fra Datafordeler.
 * @param kode - Datafordeler EjertypeKode
 */
export function parseEjertype(kode?: string): 'selskab' | 'person' | 'ukendt' {
  if (!kode) return 'ukendt';
  const k = kode.toUpperCase();
  if (k === 'S' || k === 'SELSKAB' || k === 'K') return 'selskab';
  if (k === 'P' || k === 'PERSON' || k === 'F') return 'person';
  return 'ukendt';
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<EjerskabResponse>> {
  // Kræver enten API-nøgle eller username/password (Datafordeler Ejerfortegnelsen)
  const hasAuth = DF_API_KEY || (DF_USERNAME && DF_PASSWORD);
  if (!hasAuth) {
    return NextResponse.json(
      { bfeNummer: null, ejere: [], fejl: null, manglerNoegle: true },
      { status: 200 }
    );
  }

  const { searchParams } = request.nextUrl;
  const bfeNummerStr = searchParams.get('bfeNummer');

  if (!bfeNummerStr || !/^\d+$/.test(bfeNummerStr)) {
    return NextResponse.json(
      {
        bfeNummer: null,
        ejere: [],
        fejl: 'Ugyldigt eller manglende bfeNummer',
        manglerNoegle: false,
      },
      { status: 400 }
    );
  }

  const bfeNummer = parseInt(bfeNummerStr, 10);

  // Brug username/password hvis tilgængeligt, ellers API-nøgle
  const authParams =
    DF_USERNAME && DF_PASSWORD
      ? `username=${encodeURIComponent(DF_USERNAME)}&password=${encodeURIComponent(DF_PASSWORD)}`
      : `apiKey=${DF_API_KEY}`;
  const url = `${DF_BASE}?BFENummer=${bfeNummer}&${authParams}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json(
        {
          bfeNummer,
          ejere: [],
          fejl: `Datafordeler svarede ${res.status}: ${text.slice(0, 200)}`,
          manglerNoegle: false,
        },
        { status: 200 }
      );
    }

    const json = (await res.json()) as RawEjendomResponse | RawEjendomResponse[];
    const raw: RawEjendomResponse | null = Array.isArray(json) ? (json[0] ?? null) : json;

    if (!raw || !raw.Ejere?.length) {
      return NextResponse.json(
        { bfeNummer, ejere: [], fejl: null, manglerNoegle: false },
        { status: 200 }
      );
    }

    const ejere: EjerData[] = raw.Ejere.map((e) => ({
      navn: e.Navn ?? 'Ukendt',
      cvr: e.CVRNummer ?? null,
      ejerandel: e.Ejerandel ?? null,
      overtagelsesdato: e.Overtagelsesdato ?? null,
      ejertype: parseEjertype(e.EjertypeKode),
      administrator: e.ErAdministrator ?? false,
    }));

    return NextResponse.json(
      { bfeNummer, ejere, fejl: null, manglerNoegle: false },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    return NextResponse.json(
      { bfeNummer, ejere: [], fejl: `Netværksfejl: ${msg}`, manglerNoegle: false },
      { status: 200 }
    );
  }
}
