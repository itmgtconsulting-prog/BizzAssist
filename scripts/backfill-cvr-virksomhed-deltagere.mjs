#!/usr/bin/env node
/**
 * BIZZ-1108: Bulk-ingest virksomhed→deltager relationer fra CVR ES.
 *
 * Scroller CVR ES virksomheds-index og extraherer deltagerRelation[]
 * for at populere cvr_deltagerrelation med virksomhed-ejer-relationer
 * (hvem ejer hvem, roller, ejerandele).
 *
 * Dette script henter virksomheds-ejere (opad) — IKKE person-deltagere
 * (de dækkes af backfill-cvr-deltager.mjs via deltager-index).
 *
 * Kørsel:
 *   node scripts/backfill-cvr-virksomhed-deltagere.mjs [--limit=1000] [--dry-run]
 *
 * Miljø:
 *   * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   * CVR_ES_USER + CVR_ES_PASS
 *
 * Estimeret: ~2.1M virksomheder × 2-3 deltagere = ~5M rækker, ~45 min.
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

config({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

// ─── Environment resolution ──────────────────────────────────────────────────
const ENV_REFS = {
  local: process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/([a-z]+)\.supabase/)?.[1] ?? 'local',
  test: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

const args = process.argv.slice(2);
const TARGET_ENV = (() => { const a = args.find(x => x.startsWith('--env=')); return a ? a.split('=')[1] : 'local'; })();

let SUPABASE_URL, SUPABASE_KEY;
if (TARGET_ENV === 'local') {
  SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
} else {
  const ref = ENV_REFS[TARGET_ENV];
  if (!ref) { console.error(`Unknown env: ${TARGET_ENV}`); process.exit(1); }
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) { console.error('SUPABASE_ACCESS_TOKEN required for remote env'); process.exit(1); }
  // Hent service_role key via Management API
  const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys = await keysRes.json();
  const srKey = keys.find(k => k.name === 'service_role')?.api_key;
  if (!srKey) { console.error('Could not fetch service_role key'); process.exit(1); }
  SUPABASE_URL = `https://${ref}.supabase.co`;
  SUPABASE_KEY = srKey;
}

const CVR_USER = process.env.CVR_ES_USER;
const CVR_PASS = process.env.CVR_ES_PASS;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }
if (!CVR_USER || !CVR_PASS) { console.error('Missing CVR_ES_USER/CVR_ES_PASS'); process.exit(1); }

console.log(`Target: ${TARGET_ENV} (${SUPABASE_URL})`);

const client = createClient(SUPABASE_URL, SUPABASE_KEY);
const esAuth = Buffer.from(`${CVR_USER}:${CVR_PASS}`).toString('base64');

const LIMIT = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : Infinity; })();
const DRY_RUN = args.includes('--dry-run');

const BATCH_SIZE = 200;
const DELAY_MS = 100;

/**
 * Finder gældende (åben) periode i et tidsbestemt array.
 *
 * @param {Array} arr - Array med periode-objekter
 * @returns {Object|null} - Gældende element
 */
function gyldigNu(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find(x => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Extrahér deltager-relationer fra en virksomheds deltagerRelation array.
 *
 * @param {number} targetCvr - CVR-nummer på virksomheden
 * @param {Array} deltagerRels - deltagerRelation array fra CVR ES
 * @returns {Array} - Rækker til cvr_deltagerrelation
 */
function extractRelations(targetCvr, deltagerRels) {
  const rows = [];
  if (!Array.isArray(deltagerRels)) return rows;

  for (const rel of deltagerRels) {
    const deltager = rel.deltager;
    if (!deltager) continue;

    const enhedsNummer = deltager.enhedsNummer;
    if (!enhedsNummer) continue;

    // Deltager-type: person eller virksomhed
    const enhedstype = deltager.enhedstype ?? '';
    const isPerson = enhedstype.toLowerCase().includes('person');

    // Deltager-CVR (kun for virksomheds-deltagere)
    // CVR ES har ikke direkte CVR på deltageren — men virksomheder
    // har enhedsNummer som kan mappes. Vi gemmer enhedsNummer altid.
    // For virksomheds-deltagere prøver vi at finde CVR via
    // virksomhedsrelation.
    let deltagerCvr = null;
    if (!isPerson) {
      // Virksomheds-deltager: cvrNummer kan ligge i deltager.cvrNummer
      deltagerCvr = deltager.cvrNummer ? String(deltager.cvrNummer) : null;
    }

    // Navn
    const navne = Array.isArray(deltager.navne) ? deltager.navne : [];
    const aktivtNavn = gyldigNu(navne);
    const navn = aktivtNavn?.navn ?? '';
    if (!navn) continue;

    // Roller fra organisationer → medlemsData → attributter
    const orgs = Array.isArray(rel.organisationer) ? rel.organisationer : [];
    let foundRolle = false;

    for (const org of orgs) {
      const medlemsData = Array.isArray(org.medlemsData) ? org.medlemsData : [];

      for (const md of medlemsData) {
        const attrs = Array.isArray(md.attributter) ? md.attributter : [];

        // Find FUNKTION-attributter (roller)
        const funktioner = attrs.filter(a => a.type === 'FUNKTION');
        for (const attr of funktioner) {
          const vaerdier = Array.isArray(attr.vaerdier) ? attr.vaerdier : [];
          for (const v of vaerdier) {
            if (!v.vaerdi) continue;
            const rolle = v.vaerdi.toLowerCase().slice(0, 60);
            const fra = v.periode?.gyldigFra?.slice(0, 10) ?? '1900-01-01';
            const til = v.periode?.gyldigTil?.slice(0, 10) ?? null;

            rows.push({
              virksomhed_cvr: String(targetCvr),
              deltager_enhedsnummer: enhedsNummer,
              type: rolle,
              gyldig_fra: fra,
              gyldig_til: til,
              sidst_opdateret: new Date().toISOString(),
              sidst_hentet_fra_cvr: new Date().toISOString(),
              // Ekstra felter til cvr_ejerskab-brug
              _ejer_cvr: deltagerCvr,
              _ejer_navn: navn,
            });
            foundRolle = true;
          }
        }

        // Find ejerandel — sæt ejerandel_pct på eksisterende register-række
        // i stedet for separate rækker. Finder gældende (åben) EJERANDEL-attribut.
        const ejerandelAttrs = attrs.filter(a => a.type === 'EJERANDEL');
        for (const attr of ejerandelAttrs) {
          const vaerdier = Array.isArray(attr.vaerdier) ? attr.vaerdier : [];
          const gyldig = vaerdier.find(v => !v.periode?.gyldigTil) ?? vaerdier[vaerdier.length - 1];
          if (gyldig?.vaerdi) {
            // Find register-rækken for denne deltager og sæt ejerandel_pct
            const registerRow = rows.find(
              r => r.virksomhed_cvr === String(targetCvr) &&
                   r.deltager_enhedsnummer === enhedsNummer &&
                   r.type === 'register' && !r.gyldig_til
            );
            if (registerRow) {
              registerRow.ejerandel_pct = parseFloat(gyldig.vaerdi);
            }
          }
        }
      }

      // Fallback: brug hovedtype som rolle
      if (!foundRolle && org.hovedtype) {
        rows.push({
          virksomhed_cvr: String(targetCvr),
          deltager_enhedsnummer: enhedsNummer,
          type: org.hovedtype.toLowerCase().slice(0, 60),
          gyldig_fra: '1900-01-01',
          gyldig_til: null,
          sidst_opdateret: new Date().toISOString(),
          sidst_hentet_fra_cvr: new Date().toISOString(),
          _ejer_cvr: deltagerCvr,
          _ejer_navn: navn,
        });
        foundRolle = true;
      }
    }
  }

  return rows;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[virksomhed-deltager] Starting — limit=${LIMIT === Infinity ? 'ALL' : LIMIT}, dry-run=${DRY_RUN}`);

  let totalFetched = 0;
  let totalRelations = 0;
  let scrollId = null;

  while (totalFetched < LIMIT) {
    // Scroll CVR ES virksomheds-index
    const esUrl = scrollId
      ? 'http://distribution.virk.dk/_search/scroll'
      : 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search?scroll=5m';

    const esBody = scrollId
      ? { scroll: '5m', scroll_id: scrollId }
      : {
          size: Math.min(BATCH_SIZE, LIMIT - totalFetched),
          _source: [
            'Vrvirksomhed.cvrNummer',
            'Vrvirksomhed.deltagerRelation',
          ],
          query: { match_all: {} },
          sort: [{ 'Vrvirksomhed.cvrNummer': 'asc' }],
        };

    let data;
    try {
      const res = await fetch(esUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${esAuth}` },
        body: JSON.stringify(esBody),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        console.error(`[virksomhed-deltager] ES HTTP ${res.status}`);
        break;
      }
      data = await res.json();
    } catch (err) {
      console.error(`[virksomhed-deltager] ES error:`, err.message);
      break;
    }

    scrollId = data._scroll_id;
    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) break;

    // Extrahér relationer fra hver virksomhed
    const batch = [];
    for (const hit of hits) {
      const vrv = hit._source?.Vrvirksomhed;
      if (!vrv?.cvrNummer) continue;
      const rels = extractRelations(vrv.cvrNummer, vrv.deltagerRelation ?? []);
      batch.push(...rels);
    }

    totalFetched += hits.length;

    // Upsert til Supabase
    if (batch.length > 0 && !DRY_RUN) {
      // Strip ekstra felter + dedup på PK + inkluder ejer_cvr
      const seen = new Set();
      const cleanBatch = [];
      for (const r of batch) {
        const key = `${r.virksomhed_cvr}|${r.deltager_enhedsnummer}|${r.type}|${r.gyldig_fra}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cleanBatch.push({
          virksomhed_cvr: r.virksomhed_cvr,
          deltager_enhedsnummer: r.deltager_enhedsnummer,
          type: r.type,
          gyldig_fra: r.gyldig_fra,
          gyldig_til: r.gyldig_til,
          sidst_opdateret: r.sidst_opdateret,
          sidst_hentet_fra_cvr: r.sidst_hentet_fra_cvr,
          ejer_cvr: r._ejer_cvr ?? null,
          ejerandel_pct: r.ejerandel_pct ?? null,
        });
      }

      // Upsert i chunks af 500
      for (let i = 0; i < cleanBatch.length; i += 500) {
        const chunk = cleanBatch.slice(i, i + 500);
        const { error } = await client
          .from('cvr_deltagerrelation')
          .upsert(chunk, { onConflict: 'virksomhed_cvr,deltager_enhedsnummer,type,gyldig_fra' });
        if (error) {
          console.error(`[virksomhed-deltager] Upsert error:`, error.message);
        }
      }
      totalRelations += batch.length;
    }

    if (totalFetched % 10000 === 0 || totalFetched >= LIMIT) {
      console.log(`[virksomhed-deltager] Progress: ${totalFetched} virksomheder, ${totalRelations} relationer`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`[virksomhed-deltager] Done. fetched=${totalFetched} relationer=${totalRelations}`);
}

main().catch(err => {
  console.error('[virksomhed-deltager] Fatal:', err);
  process.exit(1);
});
