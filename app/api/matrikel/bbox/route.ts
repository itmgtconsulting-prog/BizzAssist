/**
 * Matrikel-polygoner (matrikel-skel) for en bounding box — server-side proxy.
 *
 * Datafordeler har moderniseret sine WFS-tjenester: den gamle sammenstillede
 * `services.datafordeler.dk/Matrikel/MatGaeld662/1/WFS` (typeName
 * `mat:Jordstykke_Gaeldende`) er NEDLAGT (HTTP 404), og DAWA-fallbacken
 * (`api.dataforsyningen.dk/jordstykker`) er ligeledes nedlagt (410 Gone) —
 * derfor forsvandt matrikel-skel fra kortet.
 *
 * Ny entitetsbaseret WFS: `wfs.datafordeler.dk/MAT/MAT_WFS/1.0.0/WFS` (apiKey,
 * GeoJSON). Her er geometri og attributter SPLITTET i hver sin feature-type:
 *   - `mat_v001:lodflade_current`   → polygon-geometri + `jordstykkeLokalId`
 *   - `mat_v001:jordstykke_current` → matrikelnummer, areal, BFE, ejerlav-id
 *   - `mat_v001:ejerlav_current`    → ejerlavsnavn
 * Vi henter lodflade i bbox'en og beriger med jordstykke-/ejerlav-attributter
 * via CQL `id_lokalId IN (...)` (chunked), og returnerer én samlet GeoJSON med
 * de felter kortet forventer (matrikelnr, ejerlavsnavn, registreretareal, bfe).
 *
 * Retention: ingen persistens — ren gennemstillings-proxy af offentlige
 * matrikeldata. Ingen PII.
 *
 * GET /api/matrikel/bbox?w=12.5&s=55.6&e=12.6&n=55.7
 * @returns GeoJSON FeatureCollection med matrikel-polygoner
 */
import { NextRequest, NextResponse } from 'next/server';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

/** Moderniseret entitetsbaseret Matrikel-WFS (apiKey-auth, GeoJSON) */
const MAT_WFS = 'https://wfs.datafordeler.dk/MAT/MAT_WFS/1.0.0/WFS';

/** Minimal GeoJSON-feature fra WFS'en (kun de felter vi bruger). */
interface WfsFeature {
  geometry?: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/**
 * Kør en WFS GetFeature (GeoJSON) mod MAT_WFS gennem df-proxyen.
 *
 * @param params - Ekstra query-parametre (typeNames, bbox/CQL_FILTER, count …)
 * @returns Parsed GeoJSON eller null ved fejl (best-effort, kaster aldrig)
 */
async function wfsJson(params: string): Promise<{ features?: WfsFeature[] } | null> {
  const apiKey = process.env.DATAFORDELER_API_KEY ?? '';
  const url =
    `${MAT_WFS}?service=WFS&version=2.0.0&request=GetFeature` +
    `&outputFormat=application/json&apiKey=${encodeURIComponent(apiKey)}&${params}`;
  try {
    const res = await fetch(proxyUrl(url), {
      headers: { ...proxyHeaders() },
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    if (!res.ok) {
      logger.warn(`[matrikel/bbox] WFS ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as { features?: WfsFeature[] };
  } catch (err) {
    logger.warn('[matrikel/bbox] WFS fejl:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Del et array i chunks af en given størrelse (til CQL IN-batching).
 *
 * @param arr - Input-array
 * @param size - Max elementer pr. chunk
 * @returns Array af chunks
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Byg et CQL `id_lokalId IN ('a','b',…)`-filter og URL-encode det.
 *
 * @param ids - Liste af lokalId-strenge
 * @returns URL-encoded CQL_FILTER-værdi
 */
function cqlIdIn(ids: string[]): string {
  return encodeURIComponent(`id_lokalId IN (${ids.map((i) => `'${i}'`).join(',')})`);
}

/**
 * GET-handler: henter matrikel-skel for en bbox og beriger med attributter.
 *
 * @param request - NextRequest med w, s, e, n (WGS84 bbox)
 * @returns GeoJSON FeatureCollection
 */
export async function GET(request: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const w = parseFloat(searchParams.get('w') ?? '');
  const s = parseFloat(searchParams.get('s') ?? '');
  const e = parseFloat(searchParams.get('e') ?? '');
  const n = parseFloat(searchParams.get('n') ?? '');

  const emptyFc = { type: 'FeatureCollection', features: [] as unknown[] };

  if ([w, s, e, n].some(isNaN)) {
    return NextResponse.json(emptyFc, { status: 400 });
  }
  // Guard: afvis for store bbox'er — store områder giver langsomme/fejlende WFS-kald
  if (Math.abs(e - w) > 0.5 || Math.abs(n - s) > 0.5) {
    return NextResponse.json(
      { error: 'Bbox for stor — zoom ind for at se matrikeldata', features: [] },
      { status: 413 }
    );
  }
  if (!process.env.DATAFORDELER_API_KEY) return NextResponse.json(emptyFc);

  // ── 1) Polygon-geometri (lodflade) i bbox ────────────────────────────────
  // EPSG:4326 urn → akse-rækkefølge s,w,n,e (lat,lon). GeoServer-GeoJSON
  // leverer koordinater som [lon,lat] (verificeret), klar til Mapbox.
  const bbox = `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;
  const lod = await wfsJson(
    `typeNames=mat_v001:lodflade_current&srsName=EPSG:4326&bbox=${bbox}&count=1000`
  );
  const lodFeatures = (lod?.features ?? []).filter((f) => f.geometry);
  if (lodFeatures.length === 0) return NextResponse.json(emptyFc);

  // ── 2) Jordstykke-attributter (matrikelnr, areal, BFE, ejerlav-id) ───────
  const jsIds = [
    ...new Set(
      lodFeatures
        .map((f) => f.properties?.jordstykkeLokalId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
    ),
  ];
  const attrByJs = new Map<string, Record<string, unknown>>();
  await Promise.all(
    chunk(jsIds, 100).map(async (ids) => {
      const j = await wfsJson(
        `typeNames=mat_v001:jordstykke_current&count=1000&CQL_FILTER=${cqlIdIn(ids)}`
      );
      for (const f of j?.features ?? []) {
        const p = f.properties ?? {};
        const id = p.id_lokalId;
        if (typeof id === 'string') attrByJs.set(id, p);
      }
    })
  );

  // ── 3) Ejerlavsnavne (best-effort — degraderer til tom streng) ───────────
  const ejerlavIds = [
    ...new Set(
      [...attrByJs.values()]
        .map((p) => p.ejerlavLokalId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
    ),
  ];
  const ejerlavNavn = new Map<string, string>();
  await Promise.all(
    chunk(ejerlavIds, 100).map(async (ids) => {
      const ej = await wfsJson(
        `typeNames=mat_v001:ejerlav_current&count=1000&CQL_FILTER=${cqlIdIn(ids)}`
      );
      for (const f of ej?.features ?? []) {
        const p = f.properties ?? {};
        const id = p.id_lokalId;
        const navn = (p.ejerlavsnavn ?? p.navn) as string | undefined;
        if (typeof id === 'string' && navn) ejerlavNavn.set(id, navn);
      }
    })
  );

  // ── 4) Saml GeoJSON med de felter kortet forventer ───────────────────────
  const features = lodFeatures.map((f) => {
    const jsId = f.properties?.jordstykkeLokalId as string | undefined;
    const attr = (jsId && attrByJs.get(jsId)) || {};
    const ejerlavId = attr.ejerlavLokalId as string | undefined;
    const bfeRaw = attr.samletFastEjendomLokalId;
    return {
      type: 'Feature' as const,
      geometry: f.geometry,
      properties: {
        matrikelnr: typeof attr.matrikelnummer === 'string' ? attr.matrikelnummer : '',
        ejerlavsnavn: (ejerlavId && ejerlavNavn.get(ejerlavId)) || '',
        registreretareal: typeof attr.registreretAreal === 'number' ? attr.registreretAreal : null,
        bfe:
          typeof bfeRaw === 'string' ? Number(bfeRaw) : typeof bfeRaw === 'number' ? bfeRaw : null,
      },
    };
  });

  return NextResponse.json(
    { type: 'FeatureCollection', features },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } }
  );
}
