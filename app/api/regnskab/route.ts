/**
 * GET /api/regnskab?cvr=XXXXXXXX
 *
 * Server-side proxy til Erhvervsstyrelsens offentliggørelser ElasticSearch.
 * Henter regnskaber (årsrapporter) for et givent CVR-nummer, sorteret nyeste først.
 *
 * Endpoint: http://distribution.virk.dk/offentliggoerelser/_search (ES 6.8.16)
 * Auth:     HTTP Basic Auth (gratis konto på https://datacvr.virk.dk/data/login)
 * Env:      CVR_ES_USER + CVR_ES_PASS i .env.local
 *
 * @param cvr - 8-cifret CVR-nummer
 * @returns { regnskaber: Regnskab[], tokenMangler: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Et dokument tilknyttet en offentliggjort regnskab */
export interface RegnskabDokument {
  dokumentUrl: string;
  dokumentType: string;
  dokumentMimeType: string;
}

/** En offentliggjort regnskab normaliseret fra ElasticSearch */
export interface Regnskab {
  sagsNummer: string;
  /** ISO-dato for offentliggørelse */
  offentliggjort: string;
  /** ISO-dato for regnskabsperiodens start, null hvis ikke angivet */
  periodeStart: string | null;
  /** ISO-dato for regnskabsperiodens slut, null hvis ikke angivet */
  periodeSlut: string | null;
  /** Array af dokumenter (XBRL, PDF m.m.) tilknyttet regnskabet */
  dokumenter: RegnskabDokument[];
}

/** Shape af GET /api/regnskab response */
export interface RegnskabResponse {
  regnskaber: Regnskab[];
  tokenMangler: boolean;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const ES_BASE = 'http://distribution.virk.dk/offentliggoerelser/_search';

const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mapper et råt ElasticSearch-hit fra offentliggørelser til en Regnskab.
 * Returnerer null hvis sagsNummer eller offentliggørelsestidspunkt mangler.
 *
 * @param hit - Rå ES-hit med _source fra offentliggørelser-indekset
 */
function mapESHit(hit: Record<string, unknown>): Regnskab | null {
  const src = hit._source as Record<string, unknown> | undefined;
  if (!src) return null;

  const sagsNummer = typeof src.sagsNummer === 'string' ? src.sagsNummer : '';
  if (!sagsNummer) return null;

  const offentliggjort =
    typeof src.offentliggoerelsesTidspunkt === 'string' ? src.offentliggoerelsesTidspunkt : '';
  if (!offentliggjort) return null;

  // Regnskabsperiode — kan være nested under regnskab eller direkte på source
  const regnskab = src.regnskab as Record<string, unknown> | undefined;
  const periodeStart =
    typeof regnskab?.regnskabsperiode === 'object' && regnskab?.regnskabsperiode !== null
      ? typeof (regnskab.regnskabsperiode as Record<string, unknown>).startDato === 'string'
        ? ((regnskab.regnskabsperiode as Record<string, unknown>).startDato as string)
        : null
      : null;
  const periodeSlut =
    typeof regnskab?.regnskabsperiode === 'object' && regnskab?.regnskabsperiode !== null
      ? typeof (regnskab.regnskabsperiode as Record<string, unknown>).slutDato === 'string'
        ? ((regnskab.regnskabsperiode as Record<string, unknown>).slutDato as string)
        : null
      : null;

  // Dokumenter — array af filer tilknyttet offentliggørelsen
  const rawDokumenter = Array.isArray(src.dokumenter) ? src.dokumenter : [];
  const dokumenter: RegnskabDokument[] = rawDokumenter
    .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
    .map((d) => ({
      dokumentUrl: typeof d.dokumentUrl === 'string' ? d.dokumentUrl : '',
      dokumentType: typeof d.dokumentType === 'string' ? d.dokumentType : '',
      dokumentMimeType: typeof d.dokumentMimeType === 'string' ? d.dokumentMimeType : '',
    }))
    .filter((d) => d.dokumentUrl !== '');

  return {
    sagsNummer,
    offentliggjort,
    periodeStart,
    periodeSlut,
    dokumenter,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const cvr = searchParams.get('cvr') ?? '';

  // Valider CVR-format (8 cifre)
  if (!cvr || !/^\d{8}$/.test(cvr)) {
    return NextResponse.json({ regnskaber: [], tokenMangler: false }, { status: 200 });
  }

  // Returner tokenMangler-flag hvis credentials ikke er sat
  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ regnskaber: [], tokenMangler: true }, { status: 200 });
  }

  // ── Byg ElasticSearch query — regnskaber for CVR, nyeste først ──
  const esQuery = {
    query: {
      bool: {
        must: [
          { term: { cvrNummer: parseInt(cvr, 10) } },
          { term: { offentliggoerelsestype: 'regnskab' } },
        ],
      },
    },
    sort: [{ offentliggoerelsesTidspunkt: { order: 'desc' } }],
    size: 100,
  };

  try {
    const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

    const res = await fetch(ES_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      console.error('[Regnskab] ES returned', res.status, await res.text().catch(() => ''));
      return NextResponse.json({ regnskaber: [], tokenMangler: false }, { status: 200 });
    }

    const data = (await res.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
    };

    const hits = data.hits?.hits ?? [];
    const regnskaber = hits.map(mapESHit).filter((r): r is Regnskab => r !== null);

    return NextResponse.json(
      { regnskaber, tokenMangler: false },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
        },
      }
    );
  } catch (err) {
    console.error('[Regnskab] Fetch error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ regnskaber: [], tokenMangler: false }, { status: 200 });
  }
}
