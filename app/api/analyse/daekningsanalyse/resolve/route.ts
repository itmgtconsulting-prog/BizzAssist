/**
 * DAWA address resolution for coverage analysis — POST /api/analyse/daekningsanalyse/resolve
 *
 * Receives an array of customer address strings, resolves each to a DAWA
 * adgangsadresse (datavask), groups by jordstykke (matrikel), counts total
 * units per matrikel, and returns coverage statistics.
 *
 * BIZZ-1994: API route with DAWA address resolution and matrikel lookup.
 * BIZZ-1998: EJF association enrichment.
 *
 * @module app/api/analyse/daekningsanalyse/resolve/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireModuleAccess } from '@/app/lib/serverModuleAccess';
import { parseBody } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';

const MAX_ADDRESSES = 5000;
const DAWA_CONCURRENCY = 8;
const DAWA_TIMEOUT = 10_000;

/** Request schema */
const resolveSchema = z.object({
  adresser: z.array(z.string().min(1).max(500)).min(1).max(MAX_ADDRESSES),
});

/** DAWA datavask response */
interface DawaVaskResult {
  kategori: string;
  resultater: Array<{
    adresse: {
      id: string;
      vejnavn: string;
      husnr: string;
      etage: string | null;
      dør: string | null;
      postnr: string;
      postnrnavn: string;
      adgangsadresseid: string;
    };
  }>;
}

/** DAWA adgangsadresse with nested jordstykke */
interface DawaAdgangsadresse {
  id: string;
  vejnavn: string;
  /** Nestet format har vejstykke.navn i stedet for vejnavn */
  vejstykke?: { navn?: string };
  husnr: string;
  postnr: string;
  postnrnavn: string;
  jordstykke: {
    matrikelnr: string;
    ejerlav: { kode: number; navn: string };
  } | null;
  adgangspunkt: {
    koordinater: [number, number]; // [lng, lat]
  } | null;
}

/** Grouped matrikel result */
interface MatrikelGroup {
  matrikelnr: string;
  ejerlavskode: number;
  ejerlav: string;
  kundeAdgangsIds: Set<string>;
  koordinat: { lat: number; lng: number } | null;
  /** Map of vejnavn → Set of husnumre */
  vejHusnumre: Map<string, Set<string>>;
}

/**
 * Run tasks with limited concurrency.
 *
 * @param tasks - Array of async functions
 * @param concurrency - Max parallel tasks
 * @returns Array of results
 */
async function runConcurrent<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

/**
 * POST /api/analyse/daekningsanalyse/resolve
 *
 * @param req - JSON body with { adresser: string[] }
 * @returns JSON array of MatrikelResult objects
 */
export async function POST(req: NextRequest): Promise<NextResponse | Response> {
  // Module access guard
  const blocked = await requireModuleAccess('daekningsanalyse');
  if (blocked) return blocked;

  // Parse request
  const parsed = await parseBody(req, resolveSchema);
  if (!parsed.success) return parsed.response;
  const { adresser } = parsed.data;

  try {
    // Step 1: DAWA datavask — resolve each address string to adgangsadresse-id
    const vaskTasks = adresser.map((addr) => async () => {
      try {
        const url = `https://api.dataforsyningen.dk/datavask/adresser?betegnelse=${encodeURIComponent(addr)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DAWA_TIMEOUT) });
        if (!res.ok) return null;
        const data: DawaVaskResult = await res.json();
        if (data.resultater.length === 0) return null;
        return data.resultater[0].adresse.adgangsadresseid;
      } catch {
        return null;
      }
    });

    const adgangsIds = await runConcurrent(vaskTasks, DAWA_CONCURRENCY);

    // Deduplicate resolved adgangsadresse IDs
    const uniqueIds = [...new Set(adgangsIds.filter(Boolean) as string[])];
    if (uniqueIds.length === 0) {
      return NextResponse.json([]);
    }

    // Step 2: Fetch adgangsadresser with jordstykke info
    const adgangsTasks = uniqueIds.map((id) => async () => {
      try {
        const url = `https://api.dataforsyningen.dk/adgangsadresser/${id}?struktur=nestet`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DAWA_TIMEOUT) });
        if (!res.ok) return null;
        return (await res.json()) as DawaAdgangsadresse;
      } catch {
        return null;
      }
    });

    const adgangsadresser = (await runConcurrent(adgangsTasks, DAWA_CONCURRENCY)).filter(
      Boolean
    ) as DawaAdgangsadresse[];

    // Step 3: Group by matrikel
    const matrikelMap = new Map<string, MatrikelGroup>();

    for (const aa of adgangsadresser) {
      if (!aa.jordstykke) continue;
      const key = `${aa.jordstykke.matrikelnr}|${aa.jordstykke.ejerlav.kode}`;

      if (!matrikelMap.has(key)) {
        const coords = aa.adgangspunkt?.koordinater;
        matrikelMap.set(key, {
          matrikelnr: aa.jordstykke.matrikelnr,
          ejerlavskode: aa.jordstykke.ejerlav.kode,
          ejerlav: aa.jordstykke.ejerlav.navn,
          kundeAdgangsIds: new Set(),
          koordinat: coords ? { lat: coords[1], lng: coords[0] } : null,
          vejHusnumre: new Map(),
        });
      }

      const group = matrikelMap.get(key)!;
      group.kundeAdgangsIds.add(aa.id);
      // Nestet format: vejstykke.navn; flat format: vejnavn
      const vejnavn = aa.vejstykke?.navn || aa.vejnavn || 'Ukendt';
      if (!group.vejHusnumre.has(vejnavn)) group.vejHusnumre.set(vejnavn, new Set());
      group.vejHusnumre.get(vejnavn)!.add(aa.husnr);
    }

    // Step 4: For each matrikel, count total addresses (all units on the matrikel)
    const matrikelKeys = [...matrikelMap.entries()];
    const countTasks = matrikelKeys.map(([, group]) => async () => {
      try {
        const url = `https://api.dataforsyningen.dk/adresser?matrikelnr=${encodeURIComponent(group.matrikelnr)}&ejerlavkode=${group.ejerlavskode}&struktur=mini&per_side=1000`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DAWA_TIMEOUT) });
        if (!res.ok) return 0;
        const data: Array<{ adgangsadresseid: string }> = await res.json();
        return data.length;
      } catch {
        return 0;
      }
    });

    const totalCounts = await runConcurrent(countTasks, DAWA_CONCURRENCY);

    // Step 5: Fetch jordstykke polygon geometry for each matrikel
    const geoTasks = matrikelKeys.map(([, group]) => async () => {
      try {
        const url = `https://api.dataforsyningen.dk/jordstykker?matrikelnr=${encodeURIComponent(group.matrikelnr)}&ejerlavkode=${group.ejerlavskode}&format=geojson`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DAWA_TIMEOUT) });
        if (!res.ok) return null;
        const geojson = await res.json();
        // GeoJSON FeatureCollection — return first feature's geometry
        const feature = geojson?.features?.[0];
        return feature?.geometry ?? null;
      } catch {
        return null;
      }
    });

    const geometries = await runConcurrent(geoTasks, DAWA_CONCURRENCY);

    // Build results
    const results = matrikelKeys.map(([, group], i) => {
      const totalEnheder = totalCounts[i];
      const kundeAntal = group.kundeAdgangsIds.size;
      const daekningPct = totalEnheder > 0 ? (kundeAntal / totalEnheder) * 100 : 0;

      // Build address label: "Vejnavn husnumre" per line
      const adresserLines: string[] = [];
      for (const [vej, numre] of group.vejHusnumre) {
        const sorted = [...numre].sort((a, b) => parseInt(a) - parseInt(b));
        adresserLines.push(`${vej} ${sorted.join(', ')}`);
      }

      return {
        matrikelnr: group.matrikelnr,
        ejerlavskode: group.ejerlavskode,
        ejerlav: group.ejerlav,
        totalEnheder,
        kundeAntal,
        daekningPct: Math.round(daekningPct * 10) / 10,
        koordinat: group.koordinat,
        geometry: geometries[i],
        adresserLabel: adresserLines.join('\n'),
        ejerforening: null,
        ejerforeningCvr: null,
      };
    });

    // Sort by coverage ascending (lowest first)
    results.sort((a, b) => a.daekningPct - b.daekningPct);

    return NextResponse.json(results);
  } catch (err) {
    logger.error('[daekningsanalyse/resolve] Error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
