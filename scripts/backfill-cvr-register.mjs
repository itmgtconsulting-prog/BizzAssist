#!/usr/bin/env node
/**
 * Gap-filler: Backfill manglende 'register' type i cvr_deltagerrelation.
 *
 * De eksisterende deltager-backfill scripts extraherer FUNKTION-roller
 * (stifter, direktør etc.) men springer REGISTER-organisationen over
 * (ejerregistret med ejerandele). Denne script scanner CVR ES deltager-
 * index og indsætter 'register' entries med ejerandel_pct.
 *
 * Kørsel:
 *   node scripts/backfill-cvr-register.mjs [--limit=1000] [--dry-run] [--env=test|prod|local]
 *
 * Estimeret tid: ~30 min for fuld run (~1.8M deltagere × 200/batch × 100ms).
 *
 * @retention Permanent cache — ingen GDPR PII (kun enhedsNummer, CVR, roller)
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

// ─── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');
const TARGET_ENV = (() => {
  const a = args.find((x) => x.startsWith('--env='));
  return a ? a.split('=')[1] : 'local';
})();

// ─── Environment resolution ────────────────────────────────────────────────

const ENV_REFS = {
  local: 'wkzwxfhyfmvglrqtmebw',
  test: 'rlkjmqjxmkxuclehbrnl',
  prod: 'xsyldjqcntiygrtfcszm',
};

/**
 * Resolve Supabase client for target environment.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
async function resolveSupabaseClient() {
  if (TARGET_ENV === 'local') {
    const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!sbUrl || !key) {
      console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
      process.exit(1);
    }
    return createClient(sbUrl, key);
  }

  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing SUPABASE_ACCESS_TOKEN for --env=' + TARGET_ENV);
    process.exit(1);
  }

  const ref = ENV_REFS[TARGET_ENV];
  if (!ref) {
    console.error('Unknown env: ' + TARGET_ENV + '. Use local, test, or prod.');
    process.exit(1);
  }

  const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!keysRes.ok) {
    console.error('Failed to fetch API keys:', keysRes.status, await keysRes.text());
    process.exit(1);
  }
  const keys = await keysRes.json();
  const serviceKey = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!serviceKey) {
    console.error('service_role key not found');
    process.exit(1);
  }

  return createClient(`https://${ref}.supabase.co`, serviceKey);
}

// ─── CVR ES ────────────────────────────────────────────────────────────────

const CVR_ES_USER = process.env.CVR_ES_USER;
const CVR_ES_PASS = process.env.CVR_ES_PASS;

if (!CVR_ES_USER || !CVR_ES_PASS) {
  console.error('Missing CVR_ES_USER / CVR_ES_PASS');
  process.exit(1);
}

const esAuth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
const ES_URL = 'http://distribution.virk.dk/cvr-permanent/deltager/_search';

/** Ejerandel interval-koder fra CVR ES → procent */
const INTERVAL_MAP = {
  PROCENT_0_0: 0,
  PROCENT_0_4_99: 2.5,
  PROCENT_5_9_99: 7.5,
  PROCENT_10_14_99: 12.5,
  PROCENT_15_19_99: 17.5,
  PROCENT_20_24_99: 22.5,
  PROCENT_25_33_32: 29,
  PROCENT_33_34_49_99: 42,
  PROCENT_50_66_65: 58,
  PROCENT_66_67_89_99: 78,
  PROCENT_90_100: 95,
  PROCENT_100_100: 100,
};

/**
 * Extrahér REGISTER-relationer fra en deltagers virksomhedSummariskRelation.
 * Finder organisationer med hovedtype=REGISTER og FUNKTION=EJERREGISTER,
 * extraherer ejerandel_pct fra EJERANDEL_PROCENT-attribut.
 *
 * @param {number} enhedsNummer - Deltagerens enhedsNummer
 * @param {Array} rels - virksomhedSummariskRelation array
 * @returns {Array} - Rows til cvr_deltagerrelation
 */
function extractRegisterRelations(enhedsNummer, rels) {
  const rows = [];
  if (!Array.isArray(rels)) return rows;

  for (const rel of rels) {
    const virk = rel.virksomhed;
    if (!virk?.cvrNummer) continue;
    const cvr = String(virk.cvrNummer);

    const orgs = Array.isArray(rel.organisationer) ? rel.organisationer : [];
    for (const org of orgs) {
      if (org.hovedtype !== 'REGISTER') continue;

      // Check FUNKTION = EJERREGISTER med aktiv periode
      const allAttrs = [
        ...(Array.isArray(org.attributter) ? org.attributter : []),
        ...((org.medlemsData ?? []).flatMap((md) => md?.attributter ?? [])),
      ];

      const hasEjerReg = allAttrs.some(
        (a) =>
          a?.type === 'FUNKTION' &&
          (a?.vaerdier ?? []).some(
            (v) =>
              v?.vaerdi === 'EJERREGISTER' && v?.periode?.gyldigTil == null
          )
      );
      if (!hasEjerReg) continue;

      // Find ejerandel fra EJERANDEL_PROCENT
      let ejerandelPct = null;
      let gyldigFra = null;
      let gyldigTil = null;

      for (const attr of allAttrs) {
        if (attr?.type !== 'EJERANDEL_PROCENT') continue;
        const vaerdier = attr?.vaerdier ?? [];
        // Find aktiv ejerandel (gyldigTil == null)
        const aktiv = vaerdier.find((v) => v?.periode?.gyldigTil == null);
        if (aktiv) {
          // Map interval-kode til procent
          if (INTERVAL_MAP[aktiv.vaerdi] !== undefined) {
            ejerandelPct = INTERVAL_MAP[aktiv.vaerdi];
          } else {
            const pct = parseFloat(aktiv.vaerdi);
            if (!isNaN(pct)) ejerandelPct = pct * 100;
          }
          break;
        }
        // Alle ejerandel-værdier udløbet → ejerskab ophørt
        const allExpired =
          vaerdier.length > 0 && vaerdier.every((v) => v?.periode?.gyldigTil != null);
        if (allExpired) {
          // Find seneste gyldigTil
          const sorted = vaerdier
            .filter((v) => v?.periode?.gyldigTil)
            .sort((a, b) => b.periode.gyldigTil.localeCompare(a.periode.gyldigTil));
          if (sorted.length > 0) {
            gyldigTil = sorted[0].periode.gyldigTil.slice(0, 10);
          }
        }
      }

      // Find gyldigFra fra medlemsperiode
      const medlemsperioder = org?.medlemsperiode ?? [];
      const aktivMedlem = medlemsperioder.find((m) => m?.periode?.gyldigTil == null);
      if (aktivMedlem?.periode?.gyldigFra) {
        gyldigFra = aktivMedlem.periode.gyldigFra.slice(0, 10);
      }
      // Hvis alle perioder er udløbet, brug seneste gyldigTil
      if (!aktivMedlem && medlemsperioder.length > 0) {
        const sorted = medlemsperioder
          .filter((m) => m?.periode?.gyldigTil)
          .sort((a, b) => b.periode.gyldigTil.localeCompare(a.periode.gyldigTil));
        if (sorted.length > 0 && !gyldigTil) {
          gyldigTil = sorted[0].periode.gyldigTil.slice(0, 10);
        }
      }

      rows.push({
        virksomhed_cvr: cvr,
        deltager_enhedsnummer: enhedsNummer,
        type: 'register',
        ejerandel_pct: ejerandelPct,
        gyldig_fra: gyldigFra ?? '1900-01-01',
        gyldig_til: gyldigTil ?? null,
        sidst_opdateret: new Date().toISOString(),
        sidst_hentet_fra_cvr: new Date().toISOString(),
      });
    }
  }

  return rows;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `[register-backfill] Backfill 'register' type i cvr_deltagerrelation`
  );
  console.log(`  Target: ${TARGET_ENV}`);
  console.log(`  Limit: ${LIMIT === Infinity ? 'ALL' : LIMIT}`);
  console.log(`  Dry-run: ${DRY_RUN}`);
  console.log('');

  const client = await resolveSupabaseClient();

  let totalFetched = 0;
  let totalInserted = 0;
  let totalActive = 0;
  let totalHistorical = 0;
  let errors = 0;
  let searchAfter = null;
  const BATCH = 200;
  const startMs = Date.now();

  while (totalFetched < LIMIT) {
    const esBody = {
      _source: [
        'Vrdeltagerperson.enhedsNummer',
        'Vrdeltagerperson.virksomhedSummariskRelation',
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${esAuth}`,
        },
        body: JSON.stringify(esBody),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.error(`ES HTTP ${res.status}`);
        break;
      }
      const data = await res.json();
      hits = data.hits?.hits ?? [];
    } catch (err) {
      console.error('ES error:', err?.message ?? err);
      errors++;
      // Retry after delay
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (hits.length === 0) break;
    searchAfter = hits[hits.length - 1].sort;
    totalFetched += hits.length;

    // Extrahér register-relationer fra batch
    const batchRows = [];
    for (const hit of hits) {
      const del = hit._source?.Vrdeltagerperson;
      if (!del?.enhedsNummer) continue;
      const rels = del.virksomhedSummariskRelation ?? [];
      const rows = extractRegisterRelations(del.enhedsNummer, rels);
      batchRows.push(...rows);
    }

    if (batchRows.length > 0) {
      for (const r of batchRows) {
        if (r.gyldig_til == null) totalActive++;
        else totalHistorical++;
      }

      if (DRY_RUN) {
        for (const r of batchRows.slice(0, 3)) {
          console.log(
            `  [DRY] en-${r.deltager_enhedsnummer} → CVR ${r.virksomhed_cvr} (${r.ejerandel_pct ?? '?'}%, ${r.gyldig_til ? 'historisk' : 'aktiv'})`
          );
        }
        totalInserted += batchRows.length;
      } else {
        // Dedup på PK
        const seen = new Set();
        const uniqueRows = batchRows.filter((r) => {
          const key = `${r.virksomhed_cvr}|${r.deltager_enhedsnummer}|${r.type}|${r.gyldig_fra}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Upsert i chunks af 500
        for (let i = 0; i < uniqueRows.length; i += 500) {
          const chunk = uniqueRows.slice(i, i + 500);
          const { error: upsertErr } = await client
            .from('cvr_deltagerrelation')
            .upsert(chunk, {
              onConflict:
                'virksomhed_cvr,deltager_enhedsnummer,type,gyldig_fra',
            });
          if (upsertErr) {
            console.error('Upsert error:', upsertErr.message);
            errors++;
          } else {
            totalInserted += chunk.length;
          }
        }
      }
    }

    // Progress log
    if (totalFetched % 5000 === 0 || totalFetched >= LIMIT) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(
        `  ${totalFetched} deltagere scanned, ${totalInserted} register-entries (${totalActive} aktive, ${totalHistorical} historiske), ${errors} fejl (${elapsed}s)`
      );
    }

    // Rate-limit
    await new Promise((r) => setTimeout(r, 100));
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log('');
  console.log(
    `Færdig. ${totalFetched} deltagere, ${totalInserted} register-entries (${totalActive} aktive, ${totalHistorical} historiske), ${errors} fejl (${elapsed}s)`
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
