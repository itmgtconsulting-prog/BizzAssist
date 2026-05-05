#!/usr/bin/env node
/**
 * BIZZ-1125: Backfill cvr_virksomhed_ejerskab fra CVR ES.
 *
 * For hver virksomhed i cvr_virksomhed: hent deltagerRelation fra CVR ES,
 * find virksomheds-deltagere (ikke personer) med ejerandel, og gem i
 * cvr_virksomhed_ejerskab.
 *
 * Usage:
 *   node scripts/backfill-cvr-ejerskab.mjs [--limit=1000] [--dry-run] [--offset=0]
 *
 * @retention Permanent cache — ingen GDPR PII (kun CVR-numre og ejerandele)
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CVR_USER = process.env.CVR_ES_USER;
const CVR_PASS = process.env.CVR_ES_PASS;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}
if (!CVR_USER || !CVR_PASS) {
  console.error('Missing CVR_ES_USER or CVR_ES_PASS');
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY);
const cvrAuth = Buffer.from(`${CVR_USER}:${CVR_PASS}`).toString('base64');

const args = process.argv.slice(2);
const LIMIT = args.find((a) => a.startsWith('--limit='))
  ? parseInt(args.find((a) => a.startsWith('--limit=')).split('=')[1], 10)
  : Infinity;
const OFFSET = args.find((a) => a.startsWith('--offset='))
  ? parseInt(args.find((a) => a.startsWith('--offset=')).split('=')[1], 10)
  : 0;
const DRY_RUN = args.includes('--dry-run');

const BATCH_SIZE = 50;
const DELAY_MS = 300;

/** Ejerandel interval-koder fra CVR ES → procent-interval */
const INTERVAL_MAP = {
  PROCENT_0_0: { min: 0, max: 0 },
  PROCENT_0_4_99: { min: 0, max: 4.99 },
  PROCENT_5_9_99: { min: 5, max: 9.99 },
  PROCENT_10_14_99: { min: 10, max: 14.99 },
  PROCENT_15_19_99: { min: 15, max: 19.99 },
  PROCENT_20_24_99: { min: 20, max: 24.99 },
  PROCENT_25_33_32: { min: 25, max: 33.32 },
  PROCENT_33_34_49_99: { min: 33.34, max: 49.99 },
  PROCENT_50_66_65: { min: 50, max: 66.65 },
  PROCENT_66_67_89_99: { min: 66.67, max: 89.99 },
  PROCENT_90_100: { min: 90, max: 100 },
  PROCENT_100_100: { min: 100, max: 100 },
};

/**
 * Hent en virksomheds deltagerRelation fra CVR ES.
 *
 * @param {string} cvrNummer - CVR-nummer
 * @returns {object|null} - ES hit _source eller null
 */
async function fetchCompanyFromES(cvrNummer) {
  const res = await fetch(
    'http://distribution.virk.dk/cvr-permanent/virksomhed/_search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${cvrAuth}`,
      },
      body: JSON.stringify({
        query: { term: { 'Vrvirksomhed.cvrNummer': Number(cvrNummer) } },
        _source: ['Vrvirksomhed.deltagerRelation'],
        size: 1,
      }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.hits?.hits?.[0]?._source?.Vrvirksomhed ?? null;
}

/**
 * Ekstraher virksomheds-ejerskab fra deltagerRelation.
 * Virksomheds-deltagere har enhedstype=VIRKSOMHED og er registreret
 * i EJERREGISTER. EnhedsNummer→CVR mappes via enhedsNummerToCvr.
 *
 * @param {string} ejetCvr - CVR for den ejede virksomhed
 * @param {object} vrData - CVR ES virksomhedsdata
 * @param {Map<number, string>} enhedsNummerToCvr - Mapping fra enhedsNummer → CVR
 * @returns {Array} - Ejerskabs-rækker klar til insert
 */
function extractOwnership(ejetCvr, vrData, enhedsNummerToCvr) {
  const relations = vrData?.deltagerRelation ?? [];
  const rows = [];

  for (const rel of relations) {
    const deltager = rel?.deltager;
    if (!deltager) continue;

    // Kun virksomheds-deltagere (person-ejere håndteres separat via CVR ES person API)
    if (deltager.enhedstype !== 'VIRKSOMHED') continue;
    const enhedsNr = deltager.enhedsNummer;
    if (!enhedsNr) continue;

    // Find CVR for denne deltager-virksomhed
    const deltagerCvr = enhedsNummerToCvr.get(enhedsNr);
    if (!deltagerCvr || deltagerCvr === ejetCvr) continue;

    // Check om deltageren er i EJERREGISTER med aktiv ejerandel
    const organisationer = rel.organisationer ?? [];
    let isOwner = false;
    let ejerandelMin = null;
    let ejerandelMax = null;
    let gyldigFra = null;

    for (const org of organisationer) {
      if (org?.hovedtype !== 'REGISTER') continue;

      // Check medlemsperiode — udløbet = historisk ejerskab
      const medlemsperioder = org?.medlemsperiode ?? [];
      const aktivMedlem = medlemsperioder.find(
        (m) => m?.periode?.gyldigTil == null
      );
      if (medlemsperioder.length > 0 && !aktivMedlem) continue;

      // Check FUNKTION = EJERREGISTER med aktiv periode
      const attrs = org?.attributter ?? [];
      const hasEjerReg = attrs.some(
        (a) =>
          a?.type === 'FUNKTION' &&
          (a?.vaerdier ?? []).some(
            (v) => v?.vaerdi === 'EJERREGISTER' && v?.periode?.gyldigTil == null
          )
      );
      if (!hasEjerReg) continue;

      // Ejerandel: check BÅDE org.attributter OG org.medlemsData[].attributter
      const allAttrSources = [
        ...(org?.attributter ?? []),
        ...((org?.medlemsData ?? []).flatMap((md) => md?.attributter ?? [])),
      ];

      let foundEjerandel = false;
      for (const attr of allAttrSources) {
        if (attr?.type !== 'EJERANDEL_PROCENT') continue;
        const vaerdier = attr?.vaerdier ?? [];
        // Find aktiv ejerandel (gyldigTil == null)
        const aktiv = vaerdier.find((v) => v?.periode?.gyldigTil == null);
        if (aktiv) {
          // Aktiv ejerandel — brug interval-mapping eller rå decimal
          const interval = INTERVAL_MAP[aktiv.vaerdi];
          if (interval) {
            ejerandelMin = interval.min;
            ejerandelMax = interval.max;
          } else {
            // Rå decimal (fx "0.5" = 50%)
            const pct = parseFloat(aktiv.vaerdi);
            if (!isNaN(pct)) {
              ejerandelMin = pct * 100;
              ejerandelMax = pct * 100;
            }
          }
          foundEjerandel = true;
          isOwner = true;
          break;
        }
        // Alle ejerandels-værdier er udløbet → ejerskabet er udløbet
        const hasAny = vaerdier.length > 0;
        const allExpired = vaerdier.every((v) => v?.periode?.gyldigTil != null);
        if (hasAny && allExpired) {
          // Ejerandel udløbet — skip dette ejerskab
          isOwner = false;
          break;
        }
      }

      // Hvis ingen EJERANDEL_PROCENT data overhovedet → ejer uden angivet andel
      if (!foundEjerandel && isOwner === false) {
        isOwner = true;
      }

      // Gyldig fra
      if (aktivMedlem?.periode) {
        gyldigFra = aktivMedlem.periode.gyldigFra ?? null;
      }
      break;
    }

    // Tilføj ejerskab (med eller uden ejerandel)
    if (isOwner) {
      rows.push({
        ejer_cvr: deltagerCvr,
        ejet_cvr: ejetCvr,
        ejerandel_pct: ejerandelMax,
        ejerandel_min: ejerandelMin,
        ejerandel_max: ejerandelMax,
        gyldig_fra: gyldigFra,
        gyldig_til: null,
        sidst_opdateret: new Date().toISOString(),
      });
    }
  }

  return rows;
}

async function main() {
  console.log(`BIZZ-1125: Backfill cvr_virksomhed_ejerskab`);
  console.log(`  Limit: ${LIMIT === Infinity ? 'alle' : LIMIT}`);
  console.log(`  Offset: ${OFFSET}`);
  console.log(`  Dry run: ${DRY_RUN}`);

  // Byg enhedsNummer→CVR mapping fra cvr_virksomhed (samt_id = enhedsNummer)
  // OBS: samt_id er ofte 0 eller lavt — brug cvr_deltager for bedre mapping
  console.log('  Bygger enhedsNummer → CVR mapping...');
  const enhedsNummerToCvr = new Map();

  // Hent fra cvr_deltager (virksomheds-deltagere har enhedsnummer → kan mappes til CVR via cvr_virksomhed)
  // Alternativt: byg mapping on-the-fly fra CVR ES hits
  // For nu: bruger vi en simpel CVR ES lookup for hvert enhedsNummer vi støder på
  console.log('  (mapping bygges on-the-fly fra CVR ES)');
  console.log('');

  let processed = 0;
  let inserted = 0;
  let errors = 0;
  let page = OFFSET;

  while (processed < LIMIT) {
    // Hent batch af CVR-numre fra cvr_virksomhed
    const { data: batch, error } = await client
      .from('cvr_virksomhed')
      .select('cvr')
      .order('cvr', { ascending: true })
      .range(page, page + BATCH_SIZE - 1);

    if (error) {
      console.error('Supabase error:', error.message);
      break;
    }
    if (!batch || batch.length === 0) {
      console.log('Ingen flere virksomheder.');
      break;
    }

    for (const { cvr } of batch) {
      if (processed >= LIMIT) break;
      processed++;

      try {
        const vrData = await fetchCompanyFromES(cvr);
        if (!vrData) continue;

        // Byg enhedsNummer→CVR mapping for virksomheds-deltagere i dette hit
        const rels = vrData.deltagerRelation ?? [];
        const missingEnheder = [];
        for (const rel of rels) {
          const d = rel?.deltager;
          if (d?.enhedstype === 'VIRKSOMHED' && d?.enhedsNummer && !enhedsNummerToCvr.has(d.enhedsNummer)) {
            missingEnheder.push(d.enhedsNummer);
          }
        }
        // Lookup manglende enhedsNummer → CVR via CVR ES
        for (const en of missingEnheder) {
          try {
            const enRes = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Basic ${cvrAuth}` },
              body: JSON.stringify({
                query: { term: { 'Vrvirksomhed.enhedsNummer': en } },
                _source: ['Vrvirksomhed.cvrNummer'],
                size: 1,
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (enRes.ok) {
              const enData = await enRes.json();
              const enCvr = enData?.hits?.hits?.[0]?._source?.Vrvirksomhed?.cvrNummer;
              if (enCvr) enhedsNummerToCvr.set(en, String(enCvr));
            }
          } catch { /* skip */ }
        }

        const rows = extractOwnership(cvr, vrData, enhedsNummerToCvr);
        if (rows.length === 0) continue;

        if (DRY_RUN) {
          for (const r of rows) {
            console.log(`  [DRY] ${r.ejer_cvr} → ${r.ejet_cvr} (${r.ejerandel_min}-${r.ejerandel_max}%)`);
          }
        } else {
          const { error: upsertErr } = await client
            .from('cvr_virksomhed_ejerskab')
            .upsert(rows, { onConflict: 'ejer_cvr,ejet_cvr' });
          if (upsertErr) {
            console.error(`  CVR ${cvr}: upsert fejl:`, upsertErr.message);
            errors++;
          } else {
            inserted += rows.length;
          }
        }
      } catch (err) {
        console.error(`  CVR ${cvr}: ${err.message}`);
        errors++;
      }

      // Rate limit
      if (processed % 10 === 0) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }

    page += BATCH_SIZE;
    console.log(`  Processed: ${processed}, inserted: ${inserted}, errors: ${errors}`);
  }

  console.log('');
  console.log(`Færdig. Processed: ${processed}, inserted: ${inserted}, errors: ${errors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
