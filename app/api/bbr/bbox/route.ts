/**
 * GET /api/bbr/bbox?w=...&s=...&e=...&n=...
 *
 * Henter ejendomme med ejerforholdskode 50 (andelsboligforening) / 60 (almen
 * bolig) i en bounding box — til "ejendomstype"-badge-overlayet (AB/AL) på
 * /dashboard/kort.
 *
 * REDESIGN (Datafordeler-modernisering): Den gamle rute hentede
 * `byg066Ejerforhold` direkte fra BBR-bygnings-WFS'en. Det felt er FJERNET i
 * den moderniserede BBR (ejerforhold er flyttet fra bygningen til en separat
 * entitet `EjendomsRelation`, keyed på BFE — jf. BBR grunddatamodel v2.0).
 * Ny pipeline (spatialt → BFE → ejerforhold):
 *   1) MAT WFS `mat_v001:lodflade_current` i bbox → jordstykke-polygon + id
 *   2) MAT `mat_v001:jordstykke_current` (id IN) → BFE (samletFastEjendomLokalId)
 *   3) BBR GraphQL `BBR_Ejendomsrelation` (bfeNummer IN) → ejendommensEjerforholdskode
 *   4) Filtrér ejerforhold ∈ {50,60}, emit ét punkt pr. ejendom (polygon-centroid)
 *
 * Retention: ingen persistens — ren gennemstillings-proxy af offentlige
 * matrikel-/BBR-data. Ingen PII.
 *
 * @returns JSON array af BBRTypePunkt { id, lng, lat, ejerforholdskode, anvendelse }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { BBR_GQL_ENDPOINT, MAT_GQL_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';

const MAT_WFS = 'https://wfs.datafordeler.dk/MAT/MAT_WFS/1.0.0/WFS';
const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';

/** Et BBR-ejendomspunkt med ejerforhold til kortvisning */
export interface BBRTypePunkt {
  id: string;
  lng: number;
  lat: number;
  /** Ejerforholdskode — "50"=andelsboligforening (AB), "60"=almen bolig (AL) */
  ejerforholdskode: string | null;
  /** Ejendomstype (SFE/EL/BPFG) — erstatter tidligere bygnings-anvendelse */
  anvendelse: string | null;
}

/** Zod schema for BBR bbox query params */
const bbrBboxSchema = z.object({
  w: z.coerce.number(),
  s: z.coerce.number(),
  e: z.coerce.number(),
  n: z.coerce.number(),
});

/** Del et array i chunks (til IN-batching). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Centroid (simpelt gennemsnit) af en polygon-ydrering [[lng,lat],…]. */
function ringCentroid(ring: Array<[number, number]>): [number, number] | null {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let x = 0,
    y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

/**
 * MAT WFS GetFeature (GeoJSON) gennem df-proxyen. Best-effort (kaster aldrig).
 *
 * @param params - Ekstra query-parametre (typeNames, bbox/CQL …)
 * @returns Parsed GeoJSON eller null
 */
async function matWfs(
  params: string
): Promise<{
  features?: Array<{
    geometry?: { coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
  }>;
} | null> {
  const url =
    `${MAT_WFS}?service=WFS&version=2.0.0&request=GetFeature` +
    `&outputFormat=application/json&apiKey=${encodeURIComponent(DF_API_KEY)}&${params}`;
  try {
    const res = await fetch(proxyUrl(url), {
      headers: { ...proxyHeaders() },
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    if (!res.ok) {
      logger.warn(`[bbr/bbox] MAT WFS ${res.status}`);
      return null;
    }
    return (await res.json()) as {
      features?: Array<{
        geometry?: { coordinates?: unknown } | null;
        properties?: Record<string, unknown> | null;
      }>;
    };
  } catch (err) {
    logger.warn('[bbr/bbox] MAT WFS fejl:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Datafordeler GraphQL POST (BBR eller MAT) gennem df-proxyen. Best-effort.
 *
 * @param endpoint - Fuldt GraphQL-endpoint (BBR_GQL_ENDPOINT / MAT_GQL_ENDPOINT)
 * @param query - GraphQL-query-streng
 * @returns `data`-objektet eller null
 */
async function dfGql<T>(endpoint: string, query: string): Promise<T | null> {
  try {
    const res = await fetch(proxyUrl(`${endpoint}?apiKey=${encodeURIComponent(DF_API_KEY)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T; errors?: unknown[] };
    if (json.errors?.length) {
      logger.warn('[bbr/bbox] GraphQL errors:', JSON.stringify(json.errors).slice(0, 300));
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    logger.warn('[bbr/bbox] GraphQL fejl:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** ISO-tidsstempel til DAR/MAT/BBR virknings-/registreringstid. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * GET handler — ejendomme med ejerforhold 50/60 i en bounding box.
 *
 * @param request - NextRequest med w, s, e, n query params
 * @returns JSON array af BBRTypePunkt
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, bbrBboxSchema);
  if (!parsed.success) return NextResponse.json([], { status: 400 });
  const { w, s, e, n } = parsed.data;

  const empty = NextResponse.json([] as BBRTypePunkt[], {
    headers: { 'Cache-Control': 'public, s-maxage=60' },
  });
  if (!DF_API_KEY) return empty;

  // Begræns bbox-størrelse (overlayet vises kun ved zoom ≥ 15 = lille bbox).
  const maxDelta = 0.05 * 4; // ~zoom 13-14-loft
  if (Math.abs(e - w) > maxDelta || Math.abs(n - s) > maxDelta) return empty;

  try {
    const ts = nowIso();

    // ── 1) Jordstykke-polygoner i bbox (geometri + jordstykke-id) ──────────
    const bbox = `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;
    const lod = await matWfs(
      `typeNames=mat_v001:lodflade_current&srsName=EPSG:4326&bbox=${bbox}&count=1000`
    );
    const lodFeatures = (lod?.features ?? []).filter((f) => f.geometry);
    if (lodFeatures.length === 0) {
      return NextResponse.json([] as BBRTypePunkt[], {
        headers: { 'Cache-Control': 'public, s-maxage=3600' },
      });
    }

    // ── 2) jordstykke-id → BFE (MAT_Jordstykke) ────────────────────────────
    const jsIds = [
      ...new Set(
        lodFeatures
          .map((f) => f.properties?.jordstykkeLokalId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
      ),
    ];
    const bfeByJs = new Map<string, number>();
    await Promise.all(
      chunk(jsIds, 100).map(async (ids) => {
        const inList = ids.map((i) => `"${i}"`).join(',');
        const d = await dfGql<{
          MAT_Jordstykke?: {
            nodes?: Array<{ id_lokalId?: string; samletFastEjendomLokalId?: string }>;
          };
        }>(
          MAT_GQL_ENDPOINT,
          `{ MAT_Jordstykke(first: 1000 virkningstid: "${ts}" registreringstid: "${ts}" where: { id_lokalId: { in: [${inList}] } }) { nodes { id_lokalId samletFastEjendomLokalId } } }`
        );
        for (const j of d?.MAT_Jordstykke?.nodes ?? []) {
          if (j.id_lokalId && j.samletFastEjendomLokalId) {
            const bfe = Number(j.samletFastEjendomLokalId);
            if (Number.isFinite(bfe)) bfeByJs.set(j.id_lokalId, bfe);
          }
        }
      })
    );

    // ── 3) BFE → ejerforholdskode (BBR_Ejendomsrelation) ───────────────────
    const bfes = [...new Set([...bfeByJs.values()])];
    const efByBfe = new Map<number, string>();
    await Promise.all(
      chunk(bfes, 100).map(async (ids) => {
        const d = await dfGql<{
          BBR_Ejendomsrelation?: {
            nodes?: Array<{ bfeNummer?: number; ejendommensEjerforholdskode?: string }>;
          };
        }>(
          BBR_GQL_ENDPOINT,
          `{ BBR_Ejendomsrelation(first: 1000 virkningstid: "${ts}" registreringstid: "${ts}" where: { bfeNummer: { in: [${ids.join(',')}] } }) { nodes { bfeNummer ejendommensEjerforholdskode } } }`
        );
        for (const r of d?.BBR_Ejendomsrelation?.nodes ?? []) {
          if (typeof r.bfeNummer === 'number' && r.ejendommensEjerforholdskode) {
            efByBfe.set(r.bfeNummer, r.ejendommensEjerforholdskode);
          }
        }
      })
    );

    // ── 4) Emit ét punkt pr. 50/60-ejendom (polygon-centroid, dedup på BFE) ─
    const seen = new Set<number>();
    const punkter: BBRTypePunkt[] = [];
    for (const f of lodFeatures) {
      const jsId = f.properties?.jordstykkeLokalId as string | undefined;
      const bfe = jsId ? bfeByJs.get(jsId) : undefined;
      if (!bfe || seen.has(bfe)) continue;
      const ef = efByBfe.get(bfe);
      if (ef !== '50' && ef !== '60') continue;
      const coords = (f.geometry?.coordinates as Array<Array<[number, number]>> | undefined)?.[0];
      const c = coords ? ringCentroid(coords) : null;
      if (!c) continue;
      seen.add(bfe);
      punkter.push({
        id: String(bfe),
        lng: c[0],
        lat: c[1],
        ejerforholdskode: ef,
        anvendelse: null,
      });
    }

    return NextResponse.json(punkter, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error('[bbr/bbox] Fejl:', err instanceof Error ? err.message : String(err));
    return empty;
  }
}
