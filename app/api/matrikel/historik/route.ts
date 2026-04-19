/**
 * GET /api/matrikel/historik?bfeNummer=XXXX
 *
 * BIZZ-500: Henter matrikel-historik (udstykninger, sammenlægninger, status-
 * ændringer) via temporale queries mod Datafordeler MAT GraphQL.
 *
 * Strategi: Forespørger MAT_SamletFastEjendom og MAT_Jordstykke UDEN
 * virkningstid/registreringstid-begrænsning for at hente alle bitemporale
 * versioner af matrikeldata. Sammenligner jordstykke-sammensætning over
 * tid for at detektere udstykninger og sammenlægninger.
 *
 * Caching: 24 timer per BFE (historik ændres sjældent).
 *
 * @param request - Next.js request med ?bfeNummer=xxx
 * @returns MatrikelHistorikResponse med tidslinje-events
 *
 * Retention: Cache 24 timer. Ingen persistent lagring.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** En historisk hændelse i matrikel-tidslinjen */
export interface MatrikelHistorikEvent {
  /** ISO-dato for hvornår hændelsen trådte i kraft */
  dato: string;
  /** Type hændelse */
  type: 'oprettelse' | 'udstykning' | 'sammenlægning' | 'arealændring' | 'statusændring';
  /** Kort beskrivelse af hændelsen */
  beskrivelse: string;
  /** Detaljer (f.eks. nyt/gammelt areal, tilføjede/fjernede jordstykker) */
  detaljer?: {
    jordstykkerFoer?: string[];
    jordstykkerEfter?: string[];
    arealFoer?: number;
    arealEfter?: number;
    statusFoer?: string;
    statusEfter?: string;
    forretningshaendelse?: string;
  };
}

/** API-svaret fra denne route */
export interface MatrikelHistorikResponse {
  bfeNummer: number;
  historik: MatrikelHistorikEvent[];
  fejl: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const matrikelHistorikSchema = z.object({
  bfeNummer: z.string().regex(/^\d+$/),
});

const MAT_GQL_URL = 'https://graphql.datafordeler.dk/MAT/v1';
const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';

/** Antal historiske tidspunkter vi prøver (hvert ~5 år tilbage fra nu) */
const HISTORICAL_CHECKPOINTS = [0, 1, 2, 3, 5, 8, 10, 15, 20, 30, 50];

// ─── Raw types ────────────────────────────────────────────────────────────────

interface RawHistoriskJordstykke {
  id_lokalId?: string;
  matrikelnummer?: string;
  registreretAreal?: number;
  ejerlavLokalId?: string;
  virkningFra?: string;
  virkningTil?: string;
  forretningshaendelse?: string;
}

interface RawHistoriskSFE {
  BFEnummer?: number;
  status?: string;
  virkningFra?: string;
  virkningTil?: string;
  forretningshaendelse?: string;
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

/**
 * Sender en GraphQL-forespørgsel til Datafordeler MAT/v1.
 * Returnerer det rå data-objekt, eller null ved fejl.
 */
async function fetchMATGraphQL(
  query: string,
  revalidate = 86400
): Promise<Record<string, unknown> | null> {
  if (!DF_API_KEY) return null;

  const url = proxyUrl(`${MAT_GQL_URL}?apiKey=${DF_API_KEY}`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
      body: JSON.stringify({ query, variables: {} }),
      signal: AbortSignal.timeout(proxyTimeout()),
      next: { revalidate },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown[];
    };
    if (json.errors?.length) {
      logger.error('[MAT historik] GraphQL errors:', JSON.stringify(json.errors).slice(0, 400));
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    logger.error('[MAT historik] Fetch error:', err);
    return null;
  }
}

/**
 * Bygger ISO-timestamp for en dato N år tilbage fra nu.
 */
function timestampYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${hh}:${mm}`
  );
}

/**
 * Hent jordstykker for en BFE ved et bestemt tidspunkt.
 */
function buildSnapshotQuery(bfeNummer: number, timestamp: string): string {
  return `{
    sfe: MAT_SamletFastEjendom(
      first: 1
      virkningstid: "${timestamp}"
      registreringstid: "${timestamp}"
      where: { BFEnummer: { eq: ${bfeNummer} } }
    ) {
      nodes {
        BFEnummer
        status
        virkningFra
        forretningshaendelse
      }
    }
    jord: MAT_Jordstykke(
      first: 100
      virkningstid: "${timestamp}"
      registreringstid: "${timestamp}"
      where: { samletFastEjendomLokalId: { eq: "${bfeNummer}" } }
    ) {
      nodes {
        id_lokalId
        matrikelnummer
        registreretAreal
        ejerlavLokalId
        virkningFra
      }
    }
  }`;
}

interface Snapshot {
  yearsAgo: number;
  timestamp: string;
  status: string | null;
  virkningFra: string | null;
  forretningshaendelse: string | null;
  jordstykker: {
    id: string;
    matrikelnr: string;
    areal: number | null;
  }[];
}

// ─── Route handler ──────────────────────────────────────────────────────────

/**
 * GET /api/matrikel/historik?bfeNummer=XXXX
 *
 * Returnerer matrikel-historik tidslinje for en ejendom.
 * Bruger bitemporale snapshots til at detektere ændringer.
 */
export async function GET(request: NextRequest): Promise<NextResponse<MatrikelHistorikResponse>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<MatrikelHistorikResponse>;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ bfeNummer: 0, historik: [], fejl: 'Unauthorized' }, { status: 401 });
  }

  if (!DF_API_KEY) {
    return NextResponse.json(
      { bfeNummer: 0, historik: [], fejl: 'DATAFORDELER_API_KEY er ikke konfigureret' },
      { status: 200 }
    );
  }

  const parsed = parseQuery(request, matrikelHistorikSchema);
  if (!parsed.success) return parsed.response as NextResponse<MatrikelHistorikResponse>;

  const bfeNummer = parseInt(parsed.data.bfeNummer, 10);

  try {
    // Hent snapshots ved forskellige tidspunkter (parallelt, 3 ad gangen)
    const snapshots: Snapshot[] = [];
    const CONCURRENCY = 3;

    for (let i = 0; i < HISTORICAL_CHECKPOINTS.length; i += CONCURRENCY) {
      const batch = HISTORICAL_CHECKPOINTS.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (yearsAgo) => {
          const ts = timestampYearsAgo(yearsAgo);
          const data = await fetchMATGraphQL(buildSnapshotQuery(bfeNummer, ts));
          if (!data) return null;

          const sfeNodes = (data['sfe'] as { nodes?: RawHistoriskSFE[] } | undefined)?.nodes ?? [];
          const jordNodes =
            (data['jord'] as { nodes?: RawHistoriskJordstykke[] } | undefined)?.nodes ?? [];

          const sfe = sfeNodes[0] ?? null;
          return {
            yearsAgo,
            timestamp: ts,
            status: sfe?.status ?? null,
            virkningFra: sfe?.virkningFra ?? null,
            forretningshaendelse: sfe?.forretningshaendelse ?? null,
            jordstykker: jordNodes
              .filter((j) => j.id_lokalId)
              .map((j) => ({
                id: j.id_lokalId!,
                matrikelnr: j.matrikelnummer ?? '',
                areal: j.registreretAreal ?? null,
              })),
          } satisfies Snapshot;
        })
      );
      for (const r of results) {
        if (r) snapshots.push(r);
      }
    }

    // Sortér snapshots kronologisk (ældste først)
    snapshots.sort((a, b) => b.yearsAgo - a.yearsAgo);

    // Detektér ændringer mellem successive snapshots
    const historik: MatrikelHistorikEvent[] = [];
    let prevSnapshot: Snapshot | null = null;

    for (const snap of snapshots) {
      // Ejendommen eksisterede ikke endnu ved dette tidspunkt
      if (!snap.status && snap.jordstykker.length === 0) {
        prevSnapshot = snap;
        continue;
      }

      // Første gang vi ser ejendommen = oprettelse
      if (!prevSnapshot || (!prevSnapshot.status && prevSnapshot.jordstykker.length === 0)) {
        const dato = snap.virkningFra ?? snap.timestamp;
        historik.push({
          dato,
          type: 'oprettelse',
          beskrivelse: `Matriklen oprettet med ${snap.jordstykker.length} jordstykke${snap.jordstykker.length !== 1 ? 'r' : ''}`,
          detaljer: {
            jordstykkerEfter: snap.jordstykker.map((j) => j.matrikelnr),
            arealEfter: snap.jordstykker.reduce((sum, j) => sum + (j.areal ?? 0), 0),
            statusEfter: snap.status ?? undefined,
            forretningshaendelse: snap.forretningshaendelse ?? undefined,
          },
        });
        prevSnapshot = snap;
        continue;
      }

      // Sammenlign jordstykker
      const prevIds = new Set(prevSnapshot.jordstykker.map((j) => j.id));
      const currIds = new Set(snap.jordstykker.map((j) => j.id));
      const added = snap.jordstykker.filter((j) => !prevIds.has(j.id));
      const removed = prevSnapshot.jordstykker.filter((j) => !currIds.has(j.id));

      if (added.length > 0 || removed.length > 0) {
        const dato = snap.virkningFra ?? snap.timestamp;
        if (added.length > 0 && removed.length === 0) {
          historik.push({
            dato,
            type: 'sammenlægning',
            beskrivelse: `${added.length} jordstykke${added.length !== 1 ? 'r' : ''} tilføjet (sammenlægning)`,
            detaljer: {
              jordstykkerFoer: prevSnapshot.jordstykker.map((j) => j.matrikelnr),
              jordstykkerEfter: snap.jordstykker.map((j) => j.matrikelnr),
              arealFoer: prevSnapshot.jordstykker.reduce((s, j) => s + (j.areal ?? 0), 0),
              arealEfter: snap.jordstykker.reduce((s, j) => s + (j.areal ?? 0), 0),
              forretningshaendelse: snap.forretningshaendelse ?? undefined,
            },
          });
        } else if (removed.length > 0 && added.length === 0) {
          historik.push({
            dato,
            type: 'udstykning',
            beskrivelse: `${removed.length} jordstykke${removed.length !== 1 ? 'r' : ''} udstykket`,
            detaljer: {
              jordstykkerFoer: prevSnapshot.jordstykker.map((j) => j.matrikelnr),
              jordstykkerEfter: snap.jordstykker.map((j) => j.matrikelnr),
              arealFoer: prevSnapshot.jordstykker.reduce((s, j) => s + (j.areal ?? 0), 0),
              arealEfter: snap.jordstykker.reduce((s, j) => s + (j.areal ?? 0), 0),
              forretningshaendelse: snap.forretningshaendelse ?? undefined,
            },
          });
        } else {
          historik.push({
            dato,
            type: 'arealændring',
            beskrivelse: `Jordstykke-sammensætning ændret: ${removed.length} fjernet, ${added.length} tilføjet`,
            detaljer: {
              jordstykkerFoer: prevSnapshot.jordstykker.map((j) => j.matrikelnr),
              jordstykkerEfter: snap.jordstykker.map((j) => j.matrikelnr),
              arealFoer: prevSnapshot.jordstykker.reduce((s, j) => s + (j.areal ?? 0), 0),
              arealEfter: snap.jordstykker.reduce((s, j) => s + (j.areal ?? 0), 0),
              forretningshaendelse: snap.forretningshaendelse ?? undefined,
            },
          });
        }
      }

      // Areal-ændring (samme jordstykker men ændret areal)
      if (added.length === 0 && removed.length === 0) {
        const prevAreal = prevSnapshot.jordstykker.reduce((s, j) => s + (j.areal ?? 0), 0);
        const currAreal = snap.jordstykker.reduce((s, j) => s + (j.areal ?? 0), 0);
        if (prevAreal !== currAreal && prevAreal > 0) {
          historik.push({
            dato: snap.virkningFra ?? snap.timestamp,
            type: 'arealændring',
            beskrivelse: `Samlet areal ændret fra ${prevAreal.toLocaleString('da-DK')} m² til ${currAreal.toLocaleString('da-DK')} m²`,
            detaljer: {
              arealFoer: prevAreal,
              arealEfter: currAreal,
              forretningshaendelse: snap.forretningshaendelse ?? undefined,
            },
          });
        }
      }

      // Status-ændring
      if (prevSnapshot.status && snap.status && prevSnapshot.status !== snap.status) {
        historik.push({
          dato: snap.virkningFra ?? snap.timestamp,
          type: 'statusændring',
          beskrivelse: `Status ændret fra "${prevSnapshot.status}" til "${snap.status}"`,
          detaljer: {
            statusFoer: prevSnapshot.status,
            statusEfter: snap.status,
            forretningshaendelse: snap.forretningshaendelse ?? undefined,
          },
        });
      }

      prevSnapshot = snap;
    }

    // Sortér historik kronologisk (nyeste først for UI)
    historik.sort((a, b) => new Date(b.dato).getTime() - new Date(a.dato).getTime());

    return NextResponse.json(
      { bfeNummer, historik, fejl: null },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    logger.error('[matrikel/historik] Fejl:', err);
    return NextResponse.json(
      { bfeNummer, historik: [], fejl: 'Ekstern API fejl' },
      { status: 200 }
    );
  }
}
