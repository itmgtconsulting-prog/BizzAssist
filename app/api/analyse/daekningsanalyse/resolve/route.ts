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
import {
  parseLabelLine,
  longestStreetWord,
  buildForeningIndex,
  matchForening,
  type ForeningCandidate,
} from '@/app/lib/daekningsanalyse/ejerforeningMatch';
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
  /** Nestet format: postnummer.nr */
  postnummer?: { nr?: string };
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
  /** Unikke kunde-enhedsadresse-id'er (unit-niveau) på matriklen — coverage-tæller */
  kundeEnhedIds: Set<string>;
  koordinat: { lat: number; lng: number } | null;
  /** Repræsentativ DAWA adgangsadresse-id → link til ejendomssiden (BIZZ-2217) */
  dawaId: string | null;
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
    // Step 1: DAWA datavask — resolve each address string to BÅDE enhedsadresse-id
    // (unit-niveau, etage/dør) og adgangsadresse-id (bygning/opgang). Vi grupperer
    // matrikler via adgangsadressen, men TÆLLER kunder på enhedsniveau (adresse.id),
    // så flere kundeenheder i samme opgang ikke kollapser til 1 (Falkoner Alle 128:
    // 4 enheder deler 1 adgangsadresse → skal give 4 kunder, ikke 1).
    const vaskTasks = adresser.map((addr) => async () => {
      try {
        const url = `https://api.dataforsyningen.dk/datavask/adresser?betegnelse=${encodeURIComponent(addr)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DAWA_TIMEOUT) });
        if (!res.ok) return null;
        const data: DawaVaskResult = await res.json();
        if (data.resultater.length === 0) return null;
        const a = data.resultater[0].adresse;
        // Fald tilbage til adgangsadressen hvis enhedsadresse-id mangler (husnr-only match)
        return { enhedId: a.id ?? a.adgangsadresseid, adgangsadresseid: a.adgangsadresseid };
      } catch {
        return null;
      }
    });

    const vaskResults = (await runConcurrent(vaskTasks, DAWA_CONCURRENCY)).filter(Boolean) as {
      enhedId: string;
      adgangsadresseid: string;
    }[];

    // Map adgangsadresse → sæt af unikke kunde-enhedsadresser på den adgangsadresse.
    // Bruges i grupperingen til at tælle kunder på enhedsniveau pr. matrikel.
    const adgToEnhed = new Map<string, Set<string>>();
    for (const v of vaskResults) {
      if (!adgToEnhed.has(v.adgangsadresseid)) adgToEnhed.set(v.adgangsadresseid, new Set());
      adgToEnhed.get(v.adgangsadresseid)!.add(v.enhedId);
    }

    // Unikke adgangsadresse-IDs (til matrikel-opslag i Step 2)
    const uniqueIds = [...adgToEnhed.keys()];
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
          postnr: aa.postnummer?.nr ?? aa.postnr ?? '',
          kundeEnhedIds: new Set(),
          koordinat: coords ? { lat: coords[1], lng: coords[0] } : null,
          dawaId: aa.id,
          vejHusnumre: new Map(),
        });
      }

      const group = matrikelMap.get(key)!;
      // Tæl kunder på enhedsniveau: tilføj alle kunde-enhedsadresser der resolvede
      // til denne adgangsadresse (flere units i samme opgang tælles hver for sig).
      const enhedIds = adgToEnhed.get(aa.id);
      if (enhedIds) for (const eid of enhedIds) group.kundeEnhedIds.add(eid);
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
      const kundeAntal = group.kundeEnhedIds.size;
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
        dawaId: group.dawaId,
        ejerforening: null as string | null,
        ejerforeningCvr: null as string | null,
      };
    });

    // Step 6: Ejerforening-berigelse via CVR (BIZZ-2215). Ejerforeninger er IKKE
    // ejere i ejf_ejerskab, og deres beliggenhedsadresse peger typisk på
    // administrator — men foreningens NAVN indeholder ejendommens vej+husnr
    // ("E/F Falkoner Alle 54"). Vi henter forenings-kandidater fra cvr_virksomhed
    // for analysens gader og matcher på vej+husnr (se ejerforeningMatch). Best-
    // effort: fyldes hvor en CVR-registreret forening findes, ellers null.
    try {
      const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
      const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').match(/\/\/([^.]+)/)?.[1];
      // Distinkte gader fra alle matrikel-labels
      const streets = [
        ...new Set(
          results
            .flatMap((r) => r.adresserLabel.split('\n'))
            .map((line) => parseLabelLine(line)?.vej)
            .filter((v): v is string => !!v)
        ),
      ];
      if (accessToken && projectRef && streets.length > 0) {
        // Groft ILIKE-net på det mest distinktive ord pr. gade; præcis vej+husnr-
        // match sker i JS (accent/mellemrum-uafhængigt). virksomhedsform + navne-
        // præfikser fanger ejer-/andels-/boligforeninger.
        const patterns = [...new Set(streets.map((s) => `%${longestStreetWord(s)}%`))];
        // Per-gade `navn ILIKE ... OR ...` (IKKE lower()/LIKE ANY): så kan pg_trgm-
        // GIN-indekset på navn bruges → ~0,5-1s i stedet for ~14s fuld-scan der
        // ramte timeouten (og gav tom ejerforening-kolonne). ILIKE er selv
        // case-insensitiv, så lower() er unødvendig.
        const streetOr = patterns.map((p) => `navn ILIKE '${p.replace(/'/g, "''")}'`).join(' OR ');
        const sql = `SELECT navn, cvr FROM cvr_virksomhed WHERE (${streetOr}) AND (virksomhedsform IN ('FFO','FOR','ABA','FMA') OR navn ILIKE 'e/f%' OR navn ILIKE 'a/b%' OR navn ILIKE '%ejerforening%' OR navn ILIKE '%andelsbolig%' OR navn ILIKE '%boligforening%') LIMIT 8000`;
        const res = await fetch(
          `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: sql }),
            signal: AbortSignal.timeout(15000),
          }
        ).then((r) => r.json());
        const candidates: ForeningCandidate[] = Array.isArray(res)
          ? res.map((row: { navn: string; cvr: string | number | null }) => ({
              navn: String(row.navn),
              cvr: row.cvr != null ? String(row.cvr) : null,
            }))
          : [];
        if (candidates.length > 0) {
          const idx = buildForeningIndex(candidates, streets);
          for (const result of results) {
            for (const line of result.adresserLabel.split('\n')) {
              const parsed = parseLabelLine(line);
              if (!parsed) continue;
              const forening = matchForening(parsed.vej, parsed.husnumre, idx);
              if (forening) {
                result.ejerforening = forening.navn;
                result.ejerforeningCvr = forening.cvr;
                break;
              }
            }
          }
        }
      }
    } catch (ejfErr) {
      // Non-fatal — ejerforening er valgfri berigelse
      logger.warn('[daekningsanalyse/resolve] Ejerforening-berigelse fejlede:', ejfErr);
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
          dawaId: string | null;
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
              dawaId: aa.id,
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
          dawaId: g.dawaId,
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
