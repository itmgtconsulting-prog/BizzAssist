/**
 * BIZZ-2103 data-reparation: luk stale cvr_virksomhed_ejerskab-rækker for
 * ejer_cvr=28864973 (RACEHALL Aarhus) mod CVR ES ground truth.
 *
 * For hver ejet_cvr hentes Vrvirksomhed fra CVR ES, og den seneste afsluttede
 * EJERANDEL_PROCENT-periode for ejeren udledes → gyldig_til skrives i både
 * test (preview-DB) og prod.
 *
 * Kør: node scripts/repair-2103-stale-ejerskab.mjs [--dry-run]
 */
import fs from 'node:fs';

const env = Object.fromEntries(
  fs
    .readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);

const DRY = process.argv.includes('--dry-run');
const EJER_CVR = '28864973'; // RACEHALL Aarhus A/S
const EJEDE = ['28518943', '36958391', '39930757'];
const PROJECT_REFS = { test: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const cvrAuth = 'Basic ' + Buffer.from(`${env.CVR_ES_USER}:${env.CVR_ES_PASS}`).toString('base64');

/** Kør SQL via Supabase Management API */
async function runSql(ref, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

/** Find seneste afsluttede EJERANDEL_PROCENT-periode for EJER_CVR i ejet selskab */
async function findGyldigTil(ejetCvr) {
  const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: cvrAuth },
    body: JSON.stringify({
      _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.deltagerRelation'],
      query: { term: { 'Vrvirksomhed.cvrNummer': Number(ejetCvr) } },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  const vr = json.hits?.hits?.[0]?._source?.Vrvirksomhed;
  if (!vr) return { found: false };

  for (const rel of vr.deltagerRelation ?? []) {
    const d = rel.deltager;
    if (d?.enhedstype !== 'VIRKSOMHED') continue;
    // Match ejeren via forretningsnoegle/cvrNummer på deltageren
    const dCvr = d.cvrNummer ?? d.forretningsnoegle;
    if (String(dCvr) !== EJER_CVR) continue;

    let aktiv = false;
    let senesteTil = null;
    let andel = null;
    for (const org of rel.organisationer ?? []) {
      if (org.hovedtype !== 'REGISTER') continue;
      const attrs = [
        ...(org.attributter ?? []),
        ...(org.medlemsData ?? []).flatMap((md) => md.attributter ?? []),
      ];
      for (const a of attrs) {
        if (a.type !== 'EJERANDEL_PROCENT') continue;
        for (const v of a.vaerdier ?? []) {
          if (!v.periode?.gyldigTil) {
            aktiv = true;
            andel = v.vaerdi;
          } else if (!senesteTil || v.periode.gyldigTil > senesteTil) {
            senesteTil = v.periode.gyldigTil;
            andel = andel ?? v.vaerdi;
          }
        }
      }
    }
    return { found: true, aktiv, gyldigTil: senesteTil?.slice(0, 10) ?? null, andel };
  }
  return { found: false };
}

for (const ejet of EJEDE) {
  const r = await findGyldigTil(ejet);
  console.log(`${EJER_CVR} → ${ejet}:`, JSON.stringify(r));
  if (!r.found) {
    console.log('  SKIP: relation ikke fundet i CVR ES');
    continue;
  }
  if (r.aktiv) {
    console.log('  SKIP: ejerskabet er stadig aktivt iflg. CVR ES — rækken er ikke stale');
    continue;
  }
  if (!r.gyldigTil) {
    console.log('  SKIP: ingen afsluttet periode fundet');
    continue;
  }
  const sql = `UPDATE cvr_virksomhed_ejerskab SET gyldig_til = '${r.gyldigTil}'::date WHERE ejer_cvr = '${EJER_CVR}' AND ejet_cvr = '${ejet}' AND gyldig_til IS NULL RETURNING ejer_cvr, ejet_cvr, gyldig_til`;
  for (const [envName, ref] of Object.entries(PROJECT_REFS)) {
    if (DRY) {
      console.log(`  [dry-run ${envName}] ${sql}`);
      continue;
    }
    const rows = await runSql(ref, sql);
    console.log(`  ${envName}: ${rows.length} række(r) lukket med gyldig_til=${r.gyldigTil}`);
  }
}
console.log('Done.');
