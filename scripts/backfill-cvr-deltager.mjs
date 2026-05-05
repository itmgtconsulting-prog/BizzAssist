#!/usr/bin/env node
/**
 * BIZZ-905: Initial bulk-load af cvr_deltager + cvr_deltagerrelation
 * fra CVR Erhvervsstyrelsens ElasticSearch deltager-index.
 *
 * Henter alle ~1.8M deltagere via search_after-paginering og upserter
 * til Supabase i batches.
 *
 * Kørsel:
 *   node scripts/backfill-cvr-deltager.mjs [--limit=1000] [--dry-run]
 *
 * Miljø:
 *   * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (til upsert)
 *   * CVR_ES_USER + CVR_ES_PASS (til CVR ES)
 *
 * Estimeret tid: ~30 min for fuld run (1.8M × batch=200 × 100ms delay).
 *
 * Idempotent: UPSERT pr. enhedsNummer / composite PK.
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

// ─── Environment resolution ──────────────────────────────────────────────────
const ENV_REFS = {
  test: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

const args = process.argv.slice(2);
const TARGET_ENV = (() => { const a = args.find(x => x.startsWith('--env=')); return a ? a.split('=')[1] : 'local'; })();

let SUPABASE_URL, SERVICE_ROLE;
if (TARGET_ENV === 'local') {
  SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
} else {
  const ref = ENV_REFS[TARGET_ENV];
  if (!ref) { console.error(`Unknown env: ${TARGET_ENV}`); process.exit(1); }
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) { console.error('SUPABASE_ACCESS_TOKEN required for remote env'); process.exit(1); }
  const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys = await keysRes.json();
  const srKey = keys.find(k => k.name === 'service_role')?.api_key;
  if (!srKey) { console.error('Could not fetch service_role key'); process.exit(1); }
  SUPABASE_URL = `https://${ref}.supabase.co`;
  SERVICE_ROLE = srKey;
}

const CVR_ES_USER = process.env.CVR_ES_USER;
const CVR_ES_PASS = process.env.CVR_ES_PASS;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!CVR_ES_USER || !CVR_ES_PASS) {
  console.error('Missing CVR_ES_USER / CVR_ES_PASS');
  process.exit(1);
}

console.log(`Target: ${TARGET_ENV} (${SUPABASE_URL})`);

const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');

const client = createClient(SUPABASE_URL, SERVICE_ROLE);
const esAuth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
const ES_URL = 'http://distribution.virk.dk/cvr-permanent/deltager/_search';

// ─── ES helpers ─────────────────────────────────────────────────────────────

/**
 * Finder gældende (åben) periode i et tidsbestemt array.
 */
function gyldigNu(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Normaliserer rollenavn fra CVR FUNKTION-attribut.
 */
function normalizeRolle(raw) {
  if (!raw) return null;
  const low = raw.toLowerCase();
  if (low.includes('direktør') || low.includes('adm.')) return 'direktør';
  if (low.includes('bestyrelsesmedlem')) return 'bestyrelsesmedlem';
  if (low.includes('formand')) return 'formand';
  if (low.includes('stifter')) return 'stifter';
  if (low.includes('reel ejer') || low.includes('reel_ejer')) return 'reel_ejer';
  if (low === 'ejer' || low.includes('fuldt ansvarlig')) return 'ejer';
  if (low.includes('suppleant')) return 'suppleant';
  return low.slice(0, 50); // Cap ukendte roller
}

/**
 * Mapper et CVR ES deltager-hit til cvr_deltager + cvr_deltagerrelation rows.
 */
function mapHit(hit) {
  const src = hit._source;
  const del = src?.Vrdeltagerperson ?? src?.VrDeltager;
  if (!del) return null;

  const enhedsNummer = del.enhedsNummer;
  if (!enhedsNummer) return null;

  // Navn
  const navne = Array.isArray(del.navne) ? del.navne : [];
  const aktivtNavn = gyldigNu(navne);
  const navn = aktivtNavn?.navn ?? '';
  if (!navn) return null;

  // Adresse
  const adresser = Array.isArray(del.beliggenhedsadresse) ? del.beliggenhedsadresse : [];
  const adresse = gyldigNu(adresser);

  // Relationer → cvr_deltagerrelation rows
  const relationer = [];
  const rels = Array.isArray(del.virksomhedSummariskRelation)
    ? del.virksomhedSummariskRelation
    : [];

  for (const rel of rels) {
    const virk = rel.virksomhed;
    if (!virk) continue;
    const cvr = virk.cvrNummer;
    if (!cvr) continue;

    // Udtræk roller fra organisationer → medlemsData → FUNKTION
    const orgs = Array.isArray(rel.organisationer) ? rel.organisationer : [];
    for (const org of orgs) {
      const hovedtype = org.hovedtype ?? '';
      // Spring REGISTER (ejerregister) over for ledelsesroller
      const medlemsData = Array.isArray(org.medlemsData) ? org.medlemsData : [];

      for (const md of medlemsData) {
        const attrs = Array.isArray(md.attributter) ? md.attributter : [];

        // Hent ejerandel fra EJERANDEL-attribut (gældende værdi)
        let ejerandelPct = null;
        const ejerAttr = attrs.find(a => a.type === 'EJERANDEL');
        if (ejerAttr) {
          const ejerVals = Array.isArray(ejerAttr.vaerdier) ? ejerAttr.vaerdier : [];
          const gyldigEjer = ejerVals.find(v => !v.periode?.gyldigTil) ?? ejerVals[ejerVals.length - 1];
          if (gyldigEjer?.vaerdi) ejerandelPct = parseFloat(gyldigEjer.vaerdi);
        }

        for (const attr of attrs) {
          if (attr.type !== 'FUNKTION') continue;
          const vaerdier = Array.isArray(attr.vaerdier) ? attr.vaerdier : [];
          for (const v of vaerdier) {
            const rolleRaw = v.vaerdi;
            if (!rolleRaw) continue;
            const rolle = normalizeRolle(rolleRaw);
            if (!rolle) continue;

            // gyldig_fra er del af PK — kan ikke være NULL.
            // Fallback til '1900-01-01' for roller uden dato.
            const gyldigFra = v.periode?.gyldigFra?.slice(0, 10) ?? '1900-01-01';
            relationer.push({
              virksomhed_cvr: String(cvr),
              deltager_enhedsnummer: enhedsNummer,
              type: rolle,
              ejerandel_pct: rolle === 'register' ? ejerandelPct : null,
              gyldig_fra: gyldigFra,
              gyldig_til: v.periode?.gyldigTil?.slice(0, 10) ?? null,
              sidst_opdateret: del.sidstOpdateret ?? null,
              sidst_hentet_fra_cvr: new Date().toISOString(),
            });
          }
        }
      }

      // Fallback: hvis ingen FUNKTION-attribut, brug hovedtype som rolle
      if (
        relationer.filter((r) => r.virksomhed_cvr === String(cvr)).length === 0 &&
        hovedtype
      ) {
        // Hent ejerandel fra evt. EJERANDEL-attribut i medlemsData
        let fallbackPct = null;
        for (const md of medlemsData) {
          const ejerAttr = (Array.isArray(md.attributter) ? md.attributter : []).find(a => a.type === 'EJERANDEL');
          if (ejerAttr) {
            const vals = Array.isArray(ejerAttr.vaerdier) ? ejerAttr.vaerdier : [];
            const gv = vals.find(v => !v.periode?.gyldigTil) ?? vals[vals.length - 1];
            if (gv?.vaerdi) fallbackPct = parseFloat(gv.vaerdi);
          }
        }
        const fallbackType = normalizeRolle(hovedtype) ?? hovedtype.toLowerCase().slice(0, 50);
        relationer.push({
          virksomhed_cvr: String(cvr),
          deltager_enhedsnummer: enhedsNummer,
          type: fallbackType,
          ejerandel_pct: fallbackType === 'register' ? fallbackPct : null,
          gyldig_fra: '1900-01-01',
          gyldig_til: null,
          sidst_opdateret: del.sidstOpdateret ?? null,
          sidst_hentet_fra_cvr: new Date().toISOString(),
        });
      }
    }
  }

  return {
    deltager: {
      enhedsnummer: enhedsNummer,
      navn,

      adresse_json: adresse ?? null,
      roller_json: relationer.length > 0 ? relationer.map((r) => ({ cvr: r.virksomhed_cvr, type: r.type, fra: r.gyldig_fra, til: r.gyldig_til })) : null,
      sidst_opdateret: del.sidstOpdateret ?? null,
      sidst_indlaest: del.sidstIndlaest ?? null,
      sidst_hentet_fra_cvr: new Date().toISOString(),
    },
    relationer,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[deltager-backfill] Starting — limit=${LIMIT === Infinity ? 'ALL' : LIMIT}, dry-run=${DRY_RUN}`);

  let totalFetched = 0;
  let totalDeltagere = 0;
  let totalRelationer = 0;
  let searchAfter = null;
  const BATCH = 200; // ES page size

  while (totalFetched < LIMIT) {
    const esBody = {
      _source: [
        'Vrdeltagerperson.enhedsNummer',
        'Vrdeltagerperson.navne',
        'Vrdeltagerperson.enhedstype',
        'Vrdeltagerperson.beliggenhedsadresse',
        'Vrdeltagerperson.virksomhedSummariskRelation',
        'Vrdeltagerperson.sidstOpdateret',
        'Vrdeltagerperson.sidstIndlaest',
      ],
      query: { match_all: {} },
      sort: [{ _id: 'asc' }],
      size: Math.min(BATCH, LIMIT - totalFetched),
    };
    if (searchAfter) esBody.search_after = searchAfter;

    let hits;
    try {
      const res = await fetch(ES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${esAuth}` },
        body: JSON.stringify(esBody),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.error(`[deltager-backfill] ES HTTP ${res.status}`);
        break;
      }
      const data = await res.json();
      hits = data.hits?.hits ?? [];
    } catch (err) {
      console.error(`[deltager-backfill] ES error:`, err?.message ?? err);
      break;
    }

    if (hits.length === 0) break;
    searchAfter = hits[hits.length - 1].sort;
    totalFetched += hits.length;

    // Map hits
    const deltagerRows = [];
    const relationRows = [];
    for (const hit of hits) {
      const mapped = mapHit(hit);
      if (!mapped) continue;
      deltagerRows.push(mapped.deltager);
      relationRows.push(...mapped.relationer);
    }

    if (DRY_RUN) {
      totalDeltagere += deltagerRows.length;
      totalRelationer += relationRows.length;
      if (totalFetched % 2000 === 0 || totalFetched >= LIMIT) {
        console.log(`[deltager-backfill] fetched=${totalFetched} deltagere=${totalDeltagere} relationer=${totalRelationer}`);
      }
      continue;
    }

    // Upsert deltagere
    if (deltagerRows.length > 0) {
      const { error } = await client
        .from('cvr_deltager')
        .upsert(deltagerRows, { onConflict: 'enhedsnummer' });
      if (error) {
        console.error(`[deltager-backfill] deltager upsert error:`, error.message);
      } else {
        totalDeltagere += deltagerRows.length;
      }
    }

    // Upsert relationer (composite PK: virksomhed_cvr + deltager_enhedsnummer + type + gyldig_fra)
    // gyldig_fra kan være null — Supabase håndterer dette i composite PK
    if (relationRows.length > 0) {
      // Dedup relationer (samme composite key kan optræde fra flere orgs)
      const seen = new Set();
      const uniqueRels = relationRows.filter((r) => {
        const key = `${r.virksomhed_cvr}|${r.deltager_enhedsnummer}|${r.type}|${r.gyldig_fra}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const { error } = await client
        .from('cvr_deltagerrelation')
        .upsert(uniqueRels, {
          onConflict: 'virksomhed_cvr,deltager_enhedsnummer,type,gyldig_fra',
        });
      if (error) {
        console.error(`[deltager-backfill] relation upsert error:`, error.message);
      } else {
        totalRelationer += uniqueRels.length;
      }
    }

    if (totalFetched % 2000 === 0) {
      console.log(`[deltager-backfill] fetched=${totalFetched} deltagere=${totalDeltagere} relationer=${totalRelationer}`);
    }

    // Rate-limit: 100ms mellem ES-queries
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`[deltager-backfill] Done. fetched=${totalFetched} deltagere=${totalDeltagere} relationer=${totalRelationer}`);
}

main().catch((err) => {
  console.error('[deltager-backfill] Fatal:', err);
  process.exit(1);
});
