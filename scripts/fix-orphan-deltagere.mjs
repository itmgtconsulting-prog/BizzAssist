#!/usr/bin/env node
/**
 * Targeted fix for BIZZ-1298 orphan-register-ejere: enhedsnumre der
 * findes i cvr_deltagerrelation type=register/gyldig_til=null men IKKE
 * i cvr_deltager. Queryer CVR ES for hver orphan og inserter med
 * navn + grundlæggende metadata. Idempotent UPSERT.
 *
 * Brug:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/fix-orphan-deltagere.mjs
 *
 * Læser CVR_ES_USER + CVR_ES_PASS fra .env.local.
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import { createClient } from '@supabase/supabase-js';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CVR_USER = process.env.CVR_ES_USER;
const CVR_PASS = process.env.CVR_ES_PASS;

if (!SUPABASE_URL || !SERVICE_ROLE || !CVR_USER || !CVR_PASS) {
  console.error('Missing env: SUPABASE_URL/SERVICE_ROLE_KEY/CVR_ES_USER/CVR_ES_PASS');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
const CVR_AUTH = 'Basic ' + Buffer.from(`${CVR_USER}:${CVR_PASS}`).toString('base64');

async function main() {
  // 1. Pull orphan enhedsnumre
  const { data: orphans, error } = await sb
    .from('cvr_deltagerrelation')
    .select('deltager_enhedsnummer')
    .eq('type', 'register')
    .is('gyldig_til', null)
    .limit(2000);
  if (error) throw error;

  const allEnr = [...new Set(orphans.map((r) => Number(r.deltager_enhedsnummer)))];

  // Filtrér til kun dem der mangler i cvr_deltager
  const { data: existing } = await sb
    .from('cvr_deltager')
    .select('enhedsnummer')
    .in('enhedsnummer', allEnr);
  const existingSet = new Set(existing.map((r) => Number(r.enhedsnummer)));
  const orphanEnr = allEnr.filter((n) => !existingSet.has(n));

  console.log(`Orphan enhedsnumre: ${orphanEnr.length} (af ${allEnr.length} register-relationer)`);
  if (orphanEnr.length === 0) {
    console.log('Ingen orphans — done.');
    return;
  }

  // 2. Batch-query CVR ES (200 per call jf rate-limit hygiene)
  let found = 0;
  let inserted = 0;
  const BATCH = 200;
  for (let i = 0; i < orphanEnr.length; i += BATCH) {
    const chunk = orphanEnr.slice(i, i + BATCH);
    const res = await fetch('http://distribution.virk.dk/cvr-permanent/deltager/_search', {
      method: 'POST',
      headers: { Authorization: CVR_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: { terms: { 'Vrdeltagerperson.enhedsNummer': chunk } },
        _source: [
          'Vrdeltagerperson.enhedsNummer',
          'Vrdeltagerperson.navne',
          'Vrdeltagerperson.beliggenhedsadresse',
        ],
        size: chunk.length,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`  CVR ES fejl: ${res.status}`);
      continue;
    }
    const body = await res.json();
    const hits = body?.hits?.hits ?? [];
    found += hits.length;

    const rows = hits
      .map((h) => {
        const del = h._source?.Vrdeltagerperson;
        if (!del?.enhedsNummer) return null;
        const navne = Array.isArray(del.navne) ? del.navne : [];
        const aktivt = navne.find((n) => !n.periode?.gyldigTil) ?? navne[navne.length - 1];
        const navn = aktivt?.navn ?? '';
        if (!navn) return null;
        return {
          enhedsnummer: del.enhedsNummer,
          navn,
          sidst_hentet_fra_cvr: new Date().toISOString(),
        };
      })
      .filter(Boolean);

    if (rows.length > 0) {
      const { error: upErr } = await sb
        .from('cvr_deltager')
        .upsert(rows, { onConflict: 'enhedsnummer' });
      if (upErr) {
        console.error('  UPSERT fejl:', upErr.message);
      } else {
        inserted += rows.length;
      }
    }
    console.log(`  Batch ${i / BATCH + 1}: queried ${chunk.length}, found ${hits.length}, inserted ${rows.length}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`Færdig. Orphans: ${orphanEnr.length}, CVR-ES hits: ${found}, inserted: ${inserted}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});
