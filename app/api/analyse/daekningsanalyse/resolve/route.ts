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
import { createAdminClient } from '@/lib/supabase/admin';
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
  kommune?: { kode?: string };
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
  kommunekode: string;
  postnr: string;
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
      // Skip road/utility matrikler (7000-prefix = offentligt vejareal)
      if (aa.jordstykke.matrikelnr.startsWith('7000')) continue;
      const key = `${aa.jordstykke.matrikelnr}|${aa.jordstykke.ejerlav.kode}`;

      if (!matrikelMap.has(key)) {
        const coords = aa.adgangspunkt?.koordinater;
        matrikelMap.set(key, {
          matrikelnr: aa.jordstykke.matrikelnr,
          ejerlavskode: aa.jordstykke.ejerlav.kode,
          ejerlav: aa.jordstykke.ejerlav.navn,
          kommunekode: aa.kommune?.kode ?? '',
          postnr: aa.postnr ?? '',
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
        const url = `https://api.dataforsyningen.dk/jordstykker?matrikelnr=${encodeURIComponent(group.matrikelnr)}&kommunekode=${group.kommunekode}&format=geojson`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DAWA_TIMEOUT) });
        if (!res.ok) return null;
        const geojson = await res.json();
        const features = geojson?.features;
        if (!features?.length) return null;
        if (features.length === 1) return features[0].geometry ?? null;
        // Multiple features for same matrikelnr in kommune — pick closest to address coordinate
        if (!group.koordinat) return features[0].geometry ?? null;
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < features.length; i++) {
          const centroid =
            features[i].properties?.visueltcenter ?? features[i].geometry?.coordinates?.[0]?.[0];
          if (!centroid) continue;
          const [cx, cy] = Array.isArray(centroid) ? centroid : [0, 0];
          const dist =
            Math.pow(cx - group.koordinat.lng, 2) + Math.pow(cy - group.koordinat.lat, 2);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
        return features[bestIdx].geometry ?? null;
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
        ejerforening: null as string | null,
        ejerforeningCvr: null as string | null,
      };
    });

    // Step 6: EJF enrichment — look up ejerforening for each matrikel via BFE
    // Match adresser → bfe_adresse_cache → ejf_ejerskab (virksomhed with forening/E/F/A/B in name)
    try {
      const admin = createAdminClient();
      // Get BFEs for the addresses we resolved (use koordinat to match in bfe_adresse_cache)
      const adresseLabels = results
        .map((r) => r.adresserLabel.split('\n')[0]?.trim())
        .filter(Boolean);
      if (adresseLabels.length > 0) {
        // Query bfe_adresse_cache for matching addresses
        const { data: bfeRows } = (await admin
          .from('bfe_adresse_cache')
          .select('bfe_nummer, adresse')
          .or(
            adresseLabels
              .map((a) => `adresse.ilike.%${a.split(' ').slice(0, 2).join(' ')}%`)
              .join(',')
          )
          .limit(200)) as { data: { bfe_nummer: number; adresse: string }[] | null };

        if (bfeRows?.length) {
          const bfeNums = [...new Set(bfeRows.map((r) => r.bfe_nummer))];
          // Look up ejerforeninger (virksomhed-type with forening/E-F/A-B in name)
          const { data: ejfRows } = (await admin
            .from('ejf_ejerskab')
            .select('bfe_nummer, ejer_navn, ejer_cvr')
            .in('bfe_nummer', bfeNums.slice(0, 100))
            .eq('status', 'Aktiv')
            .eq('ejer_type', 'virksomhed')
            .or(
              'ejer_navn.ilike.%forening%,ejer_navn.ilike.%E/F%,ejer_navn.ilike.%A/B%,ejer_navn.ilike.%andel%'
            )
            .limit(100)) as {
            data: { bfe_nummer: number; ejer_navn: string; ejer_cvr: string | null }[] | null;
          };

          if (ejfRows?.length) {
            // Map BFE → ejerforening
            const bfeToEjf = new Map<number, { navn: string; cvr: string | null }>();
            for (const row of ejfRows) {
              if (!bfeToEjf.has(row.bfe_nummer)) {
                bfeToEjf.set(row.bfe_nummer, { navn: row.ejer_navn, cvr: row.ejer_cvr });
              }
            }
            // Map adresse → BFE → ejerforening back to results
            for (const result of results) {
              const firstAddr = result.adresserLabel.split('\n')[0]?.trim() ?? '';
              const matchBfe = bfeRows.find((r) =>
                firstAddr
                  .split(' ')
                  .slice(0, 2)
                  .every((w) => r.adresse?.includes(w))
              );
              if (matchBfe) {
                const ejf = bfeToEjf.get(matchBfe.bfe_nummer);
                if (ejf) {
                  result.ejerforening = ejf.navn;
                  result.ejerforeningCvr = ejf.cvr;
                }
              }
            }
          }
        }
      }
    } catch (ejfErr) {
      // Non-fatal — ejerforening is optional enrichment
      logger.warn('[daekningsanalyse/resolve] EJF enrichment failed:', ejfErr);
    }

    // BIZZ-2022: Find ALL matrikler on the same streets — add uncovered ones as grey (0%)
    try {
      // Collect unique vejnavn+postnr+kommunekode from resolved addresses
      const vejKeys = new Set<string>();
      for (const [, group] of matrikelMap) {
        for (const vej of group.vejHusnumre.keys()) {
          vejKeys.add(`${vej}|${group.postnr}|${group.kommunekode}`);
        }
      }
      // Set of matrikler we already have
      const existingMatrikler = new Set(results.map((r) => `${r.matrikelnr}|${r.ejerlavskode}`));

      // For each unique street, fetch ALL adgangsadresser and their matrikler
      const streetTasks = [...vejKeys].map((key) => async () => {
        const [vejnavn, postnr, kommunekode] = key.split('|');
        try {
          const url = `https://api.dataforsyningen.dk/adgangsadresser?vejnavn=${encodeURIComponent(vejnavn)}&postnr=${postnr}&kommunekode=${kommunekode}&struktur=nestet&per_side=500`;
          const res = await fetch(url, { signal: AbortSignal.timeout(DAWA_TIMEOUT) });
          if (!res.ok) return [];
          return (await res.json()) as DawaAdgangsadresse[];
        } catch {
          return [];
        }
      });
      const streetResults = await runConcurrent(streetTasks, DAWA_CONCURRENCY);

      // Collect uncovered matrikler
      const uncoveredMap = new Map<
        string,
        {
          matrikelnr: string;
          ejerlavskode: number;
          ejerlav: string;
          kommunekode: string;
          koordinat: { lat: number; lng: number } | null;
          vejHusnumre: Map<string, Set<string>>;
        }
      >();

      for (const allAddrs of streetResults) {
        for (const aa of allAddrs) {
          if (!aa.jordstykke) continue;
          if (aa.jordstykke.matrikelnr.startsWith('7000')) continue;
          const key = `${aa.jordstykke.matrikelnr}|${aa.jordstykke.ejerlav.kode}`;
          if (existingMatrikler.has(key)) continue; // Already in results
          if (!uncoveredMap.has(key)) {
            const coords = aa.adgangspunkt?.koordinater;
            uncoveredMap.set(key, {
              matrikelnr: aa.jordstykke.matrikelnr,
              ejerlavskode: aa.jordstykke.ejerlav.kode,
              ejerlav: aa.jordstykke.ejerlav.navn,
              kommunekode: aa.kommune?.kode ?? '',
              koordinat: coords ? { lat: coords[1], lng: coords[0] } : null,
              vejHusnumre: new Map(),
            });
          }
          const g = uncoveredMap.get(key)!;
          const vej = aa.vejstykke?.navn || aa.vejnavn || 'Ukendt';
          if (!g.vejHusnumre.has(vej)) g.vejHusnumre.set(vej, new Set());
          g.vejHusnumre.get(vej)!.add(aa.husnr);
        }
      }

      // Fetch geometry for uncovered matrikler
      const uncoveredEntries = [...uncoveredMap.entries()];
      const uncovGeoTasks = uncoveredEntries.map(([, g]) => async () => {
        try {
          const url = `https://api.dataforsyningen.dk/jordstykker?matrikelnr=${encodeURIComponent(g.matrikelnr)}&kommunekode=${g.kommunekode}&format=geojson`;
          const res = await fetch(url, { signal: AbortSignal.timeout(DAWA_TIMEOUT) });
          if (!res.ok) return null;
          const geojson = await res.json();
          const features = geojson?.features;
          if (!features?.length) return null;
          if (features.length === 1) return features[0].geometry ?? null;
          if (!g.koordinat) return features[0].geometry ?? null;
          let bestIdx = 0;
          let bestDist = Infinity;
          for (let i = 0; i < features.length; i++) {
            const c =
              features[i].properties?.visueltcenter ?? features[i].geometry?.coordinates?.[0]?.[0];
            if (!c) continue;
            const dist = Math.pow(c[0] - g.koordinat.lng, 2) + Math.pow(c[1] - g.koordinat.lat, 2);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
          return features[bestIdx].geometry ?? null;
        } catch {
          return null;
        }
      });
      const uncovGeos = await runConcurrent(uncovGeoTasks, DAWA_CONCURRENCY);

      // Add uncovered matrikler to results with 0% coverage
      for (let i = 0; i < uncoveredEntries.length; i++) {
        const [, g] = uncoveredEntries[i];
        const adresserLines: string[] = [];
        for (const [vej, numre] of g.vejHusnumre) {
          const sorted = [...numre].sort((a, b) => parseInt(a) - parseInt(b));
          adresserLines.push(`${vej} ${sorted.join(', ')}`);
        }
        results.push({
          matrikelnr: g.matrikelnr,
          ejerlavskode: g.ejerlavskode,
          ejerlav: g.ejerlav,
          totalEnheder: 1, // At least 1 address exists
          kundeAntal: 0,
          daekningPct: 0,
          koordinat: g.koordinat,
          geometry: uncovGeos[i],
          adresserLabel: adresserLines.join('\n'),
          ejerforening: null as string | null,
          ejerforeningCvr: null as string | null,
        });
      }
    } catch (uncovErr) {
      // Non-fatal — grey matrikler are optional enrichment
      logger.warn('[daekningsanalyse/resolve] Uncovered matrikler failed:', uncovErr);
    }

    // Sort by coverage ascending (lowest first)
    results.sort((a, b) => a.daekningPct - b.daekningPct);

    return NextResponse.json(results);
  } catch (err) {
    logger.error('[daekningsanalyse/resolve] Error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
