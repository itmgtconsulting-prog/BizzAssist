/**
 * GET /api/ejere-paa-vej?vej=<vejnavn>&postnr=<4-cifret>[&ejernavn=<filter>][&max=<n>]
 *
 * Finder alle ejendomme på en vej og deres OFFENTLIGE ejere i ét server-side
 * kald. Lukker hullet mod Resights' "hvem ejer ejendommene på vej X" og gør det
 * muligt at finde en navngiven (også privat) ejer via ejendom → ejer — uden at
 * AI-chatten skal loope mange værktøjskald.
 *
 * Pipeline (genbruger eksisterende integrationer):
 *   1. DAR: husnumre på vej+postnr → adgangspunkt-koordinater (EPSG:25832)
 *   2. MAT WFS: lodflade i vejens bbox (én gang) + jordstykke → BFE; punkt-i-
 *      polygon pr. adresse → BFE
 *   3. /api/ejerskab (intern, cookie-forwarded) → ejere pr. BFE (EJF/tinglysning)
 *   4. Valgfrit navne-filter på ejere
 *
 * Databeskyttelse: KUN offentlige ejendoms-/ejerskabsdata (ejendomsejerskab er
 * offentligt pr. ejendom). Ingen persistens. BIZZ-2305.
 *
 * @param request - NextRequest med ?vej, ?postnr, ?ejernavn, ?max
 * @returns { vej, postnr, antalEjendomme, ejendomme: EjendomMedEjere[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { parseQuery } from '@/app/lib/validate';
import { DAR_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Moderniseret entitetsbaseret Matrikel-WFS (apiKey, GeoJSON). */
const MAT_WFS = 'https://wfs.datafordeler.dk/MAT/MAT_WFS/1.0.0/WFS';

/** Zod schema for query-params. */
const schema = z.object({
  vej: z.string().min(2).max(80),
  postnr: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  ejernavn: z.string().max(80).optional(),
  max: z.coerce.number().int().min(1).max(100).optional(),
});

/** En ejer af en ejendom (offentlig EJF/tinglysning-data). */
interface Ejer {
  navn: string | null;
  cvr: string | null;
  ejertype: string | null;
  ejerandel: string | null;
}

/** En ejendom på vejen med dens ejere. */
interface EjendomMedEjere {
  adresse: string;
  bfeNummer: number;
  ejere: Ejer[];
}

/** DAR GraphQL POST (best-effort). */
async function dar<T>(query: string, key: string): Promise<T | null> {
  try {
    const res = await fetch(proxyUrl(`${DAR_ENDPOINT}?apiKey=${encodeURIComponent(key)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T; errors?: unknown[] };
    if (json.errors?.length) return null;
    return json.data ?? null;
  } catch {
    return null;
  }
}

/** MAT WFS GetFeature (GeoJSON) best-effort. */
async function matWfs(
  params: string,
  key: string
): Promise<{
  features?: Array<{
    geometry?: { type: string; coordinates: unknown } | null;
    properties?: Record<string, unknown> | null;
  }>;
} | null> {
  try {
    const url =
      `${MAT_WFS}?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json` +
      `&apiKey=${encodeURIComponent(key)}&${params}`;
    const res = await fetch(proxyUrl(url), {
      headers: { ...proxyHeaders() },
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      features?: Array<{
        geometry?: { type: string; coordinates: unknown } | null;
        properties?: Record<string, unknown> | null;
      }>;
    };
  } catch {
    return null;
  }
}

/** Parser WKT "POINT (easting northing)" → [easting, northing] (EPSG:25832). */
function parsePoint(wkt?: string): [number, number] | null {
  const m = wkt?.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Ray-casting: er punktet (x,y) i polygon-ydreringen? */
function ringContains(ring: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1],
      xj = ring[j][0],
      yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Yderste ring af en Polygon/MultiPolygon-geometri. */
function outerRings(
  geom: { type: string; coordinates: unknown } | null | undefined
): Array<Array<[number, number]>> {
  if (!geom) return [];
  const polys = (geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates]) as Array<
    Array<Array<[number, number]>>
  >;
  return polys.map((p) => p[0]).filter(Boolean);
}

/** Del et array i chunks. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * GET-handler — ejendomme + ejere på en vej.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, schema);
  if (!parsed.success) return NextResponse.json({ error: 'Ugyldige parametre' }, { status: 400 });
  const { vej, postnr, ejernavn, max = 60 } = parsed.data;

  const key = process.env.DATAFORDELER_API_KEY;
  if (!key) return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });

  const ts = new Date().toISOString();
  // Betegnelsen er "<vejnavn> <husnr>, <postnr> <by>" — startsWith matcher KUN
  // vejnavnet; postnr filtreres separat på hvert husnummer nedenfor.
  const betegnelsePrefix = vej;

  // ── 1) Husnumre på vejen → adgangspunkt-UUIDs ──
  const hnData = await dar<{
    DAR_Husnummer?: {
      nodes?: Array<{ adgangsadressebetegnelse: string; adgangspunkt?: string | null }>;
    };
  }>(
    `{ DAR_Husnummer(first: ${Math.min(max * 2, 200)} virkningstid: "${ts}" registreringstid: "${ts}" where: { adgangsadressebetegnelse: { startsWith: "${betegnelsePrefix.replace(/"/g, '')}" } }) { nodes { adgangsadressebetegnelse adgangspunkt } } }`,
    key
  );
  const husnumre = (hnData?.DAR_Husnummer?.nodes ?? [])
    .filter(
      (n) => n.adgangspunkt && (!postnr || n.adgangsadressebetegnelse.includes(`, ${postnr} `))
    )
    .slice(0, max);
  if (husnumre.length === 0) {
    return NextResponse.json({ vej, postnr: postnr ?? null, antalEjendomme: 0, ejendomme: [] });
  }

  // ── 2) Adgangspunkt-UUIDs → koordinater (EPSG:25832), batched ──
  const apIds = [...new Set(husnumre.map((h) => h.adgangspunkt as string))];
  const coordByAp = new Map<string, [number, number]>();
  for (const ids of chunk(apIds, 50)) {
    const inList = ids.map((i) => `"${i}"`).join(',');
    const apData = await dar<{
      DAR_Adressepunkt?: { nodes?: Array<{ id_lokalId: string; position?: { wkt?: string } }> };
    }>(
      `{ DAR_Adressepunkt(first: 100 virkningstid: "${ts}" registreringstid: "${ts}" where: { id_lokalId: { in: [${inList}] } }) { nodes { id_lokalId position { wkt } } } }`,
      key
    );
    for (const n of apData?.DAR_Adressepunkt?.nodes ?? []) {
      const c = parsePoint(n.position?.wkt);
      if (c) coordByAp.set(n.id_lokalId, c);
    }
  }
  const adresser = husnumre
    .map((h) => ({
      adresse: h.adgangsadressebetegnelse,
      coord: coordByAp.get(h.adgangspunkt as string),
    }))
    .filter((a): a is { adresse: string; coord: [number, number] } => !!a.coord);
  if (adresser.length === 0) {
    return NextResponse.json({ vej, postnr: postnr ?? null, antalEjendomme: 0, ejendomme: [] });
  }

  // ── 3) MAT: lodflade i vejens bbox (én gang) + jordstykke → BFE ──
  const xs = adresser.map((a) => a.coord[0]);
  const ys = adresser.map((a) => a.coord[1]);
  const pad = 30;
  const bbox = `${Math.min(...xs) - pad},${Math.min(...ys) - pad},${Math.max(...xs) + pad},${Math.max(...ys) + pad},urn:ogc:def:crs:EPSG::25832`;
  const lod = await matWfs(
    `typeNames=mat_v001:lodflade_current&srsName=EPSG:25832&bbox=${bbox}&count=2000`,
    key
  );
  const lodFeatures = (lod?.features ?? []).filter(
    (f) => f.geometry && f.properties?.jordstykkeLokalId
  );

  // jordstykkeLokalId → BFE (samletFastEjendomLokalId)
  const jsIds = [...new Set(lodFeatures.map((f) => String(f.properties?.jordstykkeLokalId)))];
  const bfeByJs = new Map<string, number>();
  for (const ids of chunk(jsIds, 100)) {
    const cql = encodeURIComponent(`id_lokalId IN (${ids.map((i) => `'${i}'`).join(',')})`);
    const js = await matWfs(
      `typeNames=mat_v001:jordstykke_current&count=2000&CQL_FILTER=${cql}`,
      key
    );
    for (const f of js?.features ?? []) {
      const id = f.properties?.id_lokalId;
      const bfe = Number(f.properties?.samletFastEjendomLokalId);
      if (typeof id === 'string' && Number.isFinite(bfe)) bfeByJs.set(id, bfe);
    }
  }

  // Punkt-i-polygon: adresse → BFE (dedup)
  const bfeByAdresse = new Map<string, number>();
  for (const a of adresser) {
    for (const f of lodFeatures) {
      if (outerRings(f.geometry).some((ring) => ringContains(ring, a.coord[0], a.coord[1]))) {
        const bfe = bfeByJs.get(String(f.properties?.jordstykkeLokalId));
        if (bfe) bfeByAdresse.set(a.adresse, bfe);
        break;
      }
    }
  }

  // BFE → liste af adresser (dedup ejendomme)
  const adresserByBfe = new Map<number, string[]>();
  for (const [adresse, bfe] of bfeByAdresse) {
    const list = adresserByBfe.get(bfe) ?? [];
    list.push(adresse.replace(postnr ? `, ${postnr} ` : ', ', ', ').trim());
    adresserByBfe.set(bfe, list);
  }
  const bfeNumre = [...adresserByBfe.keys()];

  // ── 4) Ejere pr. BFE via intern /api/ejerskab (cookie-forwarded, parallelt) ──
  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const cookieHeader = request.headers.get('cookie') ?? '';
  const results = await Promise.allSettled(
    bfeNumre.map(async (bfe): Promise<EjendomMedEjere | null> => {
      try {
        const res = await fetch(`${baseUrl}/api/ejerskab?bfeNummer=${bfe}`, {
          headers: cookieHeader ? { cookie: cookieHeader } : {},
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          ejere?: Array<{
            cvr: string | null;
            personNavn: string | null;
            ejertype: string | null;
            ejerandel_taeller: number | null;
            ejerandel_naevner: number | null;
            virksomhedsnavn?: string | null;
          }>;
        };
        const ejere: Ejer[] = (data.ejere ?? []).map((e) => ({
          navn: e.personNavn ?? e.virksomhedsnavn ?? null,
          cvr: e.cvr,
          ejertype: e.ejertype,
          ejerandel:
            e.ejerandel_taeller != null && e.ejerandel_naevner
              ? `${Math.round((e.ejerandel_taeller / e.ejerandel_naevner) * 100)}%`
              : null,
        }));
        const adrList = (adresserByBfe.get(bfe) ?? []).sort();
        return { adresse: adrList[0] ?? String(bfe), bfeNummer: bfe, ejere };
      } catch {
        return null;
      }
    })
  );

  let ejendomme = results
    .filter((r): r is PromiseFulfilledResult<EjendomMedEjere | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is EjendomMedEjere => v !== null);

  // ── 5) Valgfrit navne-filter på ejere ──
  if (ejernavn) {
    const q = ejernavn.toLowerCase();
    ejendomme = ejendomme.filter((e) => e.ejere.some((o) => o.navn?.toLowerCase().includes(q)));
  }

  ejendomme.sort((a, b) => a.adresse.localeCompare(b.adresse, 'da'));
  logger.log(`[ejere-paa-vej] ${vej} → ${ejendomme.length} ejendomme`);
  return NextResponse.json(
    { vej, postnr: postnr ?? null, antalEjendomme: ejendomme.length, ejendomme },
    { headers: { 'Cache-Control': 'private, max-age=300' } }
  );
}
