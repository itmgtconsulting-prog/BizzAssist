#!/usr/bin/env node
/**
 * BIZZ-2232: One-time drain of the cache_vur backlog.
 *
 * refresh-vur-cache (cron) er capped på 300 BFE/kørsel for at holde sig under
 * Vercels 300s maxDuration. Efter BIZZ-2211-fixet virker VUR-hentningen igen,
 * men ~18.8k stale rækker kan ikke indhentes hurtigt nok af cronen alene. Dette
 * script dræner hele backloggen uden 300s-loft (kør fra en maskine/CI).
 *
 * Skriver til cache_vur (adresse: raw_data/source_hash/synced_at) — IKKE den
 * forældede backfill-vur-cache.mjs, der ramte en anden tabel med Basic-auth.
 *
 * Bruger Management API til DB (targeter prod/test/dev via --env uden at skifte
 * .env.local) + proxy+OAuth til Datafordeler VUR/v2 med SAMME numeriske-id
 * GraphQL-syntaks som cron-routen (BIZZ-2211).
 *
 * Usage:
 *   node scripts/drain-vur-backlog.mjs --env=prod [--limit=100000] [--stale-days=7] [--batch=40] [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
      return m ? [m[1], m[2]] : [null, null];
    })
    .filter(([k]) => k)
);

const REFS = {
  prod: 'xsyldjqcntiygrtfcszm',
  test: 'rlkjmqjxmkxuclehbrnl',
  dev: 'wkzwxfhyfmvglrqtmebw',
};
const args = process.argv.slice(2);
const arg = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};
const ENV = arg('env', 'dev');
const REF = REFS[ENV];
const LIMIT = parseInt(arg('limit', '100000'), 10);
const STALE_DAYS = parseInt(arg('stale-days', '7'), 10);
const BATCH = parseInt(arg('batch', '40'), 10);
const DRY = args.includes('--dry-run');

const TOKEN = env.SUPABASE_ACCESS_TOKEN;
const CID = env.DATAFORDELER_OAUTH_CLIENT_ID;
const CSEC = env.DATAFORDELER_OAUTH_CLIENT_SECRET;
const PROXY = env.DF_PROXY_URL;
const PSEC = env.DF_PROXY_SECRET;

if (!REF) {
  console.error(`Ukendt --env=${ENV} (brug prod|test|dev)`);
  process.exit(1);
}
if (!TOKEN || !CID || !CSEC) {
  console.error('Mangler SUPABASE_ACCESS_TOKEN / DATAFORDELER_OAUTH_* i .env.local');
  process.exit(1);
}

const VUR_GQL = 'https://graphql.datafordeler.dk/VUR/v2';
const phdr = PROXY && PSEC ? { 'X-Proxy-Secret': PSEC } : {};
const purl = (u) => (PROXY ? u.replace('https://', `${PROXY}/proxy/`) : u);
const sqlEsc = (s) => String(s).replace(/'/g, "''");

/** Run SQL via Management API. */
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`SQL fejl: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function getToken() {
  const r = await fetch(
    'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CID,
        client_secret: CSEC,
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!r.ok) throw new Error(`OAuth ${r.status}`);
  return (await r.json()).access_token;
}

/** Fetch VUR for a BFE — same numeric-id GraphQL syntax as the cron (BIZZ-2211). */
async function fetchVurForBfe(bfe, token) {
  const gh = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...phdr };
  const kq = `{ VUR_BFEKrydsreference(first: 100, where: { BFEnummer: { eq: ${bfe} } }) { nodes { fkEjendomsvurderingID } } }`;
  const kr = await fetch(purl(VUR_GQL), {
    method: 'POST',
    headers: gh,
    body: JSON.stringify({ query: kq }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!kr.ok) return null;
  const kd = await kr.json();
  const ids = (kd.data?.VUR_BFEKrydsreference?.nodes ?? [])
    .map((n) => n.fkEjendomsvurderingID)
    .filter((x) => x != null);
  if (ids.length === 0) return { vurderinger: [] };
  const vq = `{ VUR_Ejendomsvurdering(first: 100, where: { id: { in: [${ids.join(',')}] } }) { nodes { id aar ejendomvaerdiBeloeb grundvaerdiBeloeb vurderetAreal benyttelseKode juridiskKategoriTekst } } }`;
  const vr = await fetch(purl(VUR_GQL), {
    method: 'POST',
    headers: gh,
    body: JSON.stringify({ query: vq }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!vr.ok) return null;
  const vd = await vr.json();
  if (vd.errors?.length) return null;
  return { vurderinger: vd.data?.VUR_Ejendomsvurdering?.nodes ?? [] };
}

async function main() {
  console.log(
    `VUR backlog-drain — env=${ENV} (${REF}), stale>${STALE_DAYS}d, limit=${LIMIT}, batch=${BATCH}, dry=${DRY}`
  );
  const rows = await sql(
    `SELECT bfe_nummer FROM cache_vur WHERE synced_at < now() - interval '${STALE_DAYS} days' ORDER BY synced_at ASC LIMIT ${LIMIT}`
  );
  const bfes = rows.map((r) => r.bfe_nummer);
  console.log(`Stale BFE'er: ${bfes.length}`);
  if (bfes.length === 0 || DRY) {
    if (DRY) console.log('(dry-run — henter/skriver ikke)');
    return;
  }

  const token = await getToken();
  let refreshed = 0;
  let errors = 0;
  let batchRows = [];

  const flush = async () => {
    if (batchRows.length === 0) return;
    const values = batchRows
      .map((b) => `(${b.bfe}, '${sqlEsc(JSON.stringify(b.data))}'::jsonb, '${b.hash}', now())`)
      .join(',');
    await sql(
      `INSERT INTO cache_vur (bfe_nummer, raw_data, source_hash, synced_at) VALUES ${values} ` +
        `ON CONFLICT (bfe_nummer) DO UPDATE SET raw_data=EXCLUDED.raw_data, source_hash=EXCLUDED.source_hash, synced_at=EXCLUDED.synced_at`
    );
    refreshed += batchRows.length;
    batchRows = [];
    console.log(`  ...${refreshed}/${bfes.length} opdateret`);
  };

  for (const bfe of bfes) {
    const data = await fetchVurForBfe(bfe, token);
    if (!data) {
      errors++;
      continue;
    }
    batchRows.push({
      bfe,
      data,
      hash: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    });
    if (batchRows.length >= BATCH) await flush();
  }
  await flush();
  console.log(`Færdig: ${refreshed} opdateret, ${errors} fejl.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
