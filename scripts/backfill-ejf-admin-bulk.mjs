#!/usr/bin/env node
/**
 * BIZZ-1659: Bulk backfill ejf_administrator via EJFCustom_EjendomsadministratorBegraenset.
 *
 * Usage:
 *   node scripts/backfill-ejf-admin-bulk.mjs --env=prod [--after=CURSOR]
 */
import https from 'node:https';
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const args = process.argv.slice(2);
const TARGET_ENV = args.find(x => x.startsWith('--env='))?.split('=')[1] || 'prod';
const AFTER_CURSOR = args.find(x => x.startsWith('--after='))?.split('=')[1] || null;

const ENV_REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
const PROJECT_REF = ENV_REFS[TARGET_ENV];
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const DF_CLIENT_ID = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
const DF_CLIENT_SECRET = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;

const PAGE_SIZE = 500;

let cachedToken = null, tokenExpiry = 0;
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: DF_CLIENT_ID, client_secret: DF_CLIENT_SECRET });
  const res = await fetch('https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  const data = await res.json();
  cachedToken = data.access_token; tokenExpiry = Date.now() + (data.expires_in || 300) * 1000;
  return cachedToken;
}

async function dfQuery(query, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const token = await getToken();
      const res = await fetch('https://graphql.datafordeler.dk/flexibleCurrent/v1/', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000) });
      const data = await res.json();
      if (data.errors) { if (attempt < retries) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; } return null; }
      return data.data;
    } catch { if (attempt < retries) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; } return null; }
  }
  return null;
}

function runSqlOnce(sql) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 30000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', (e) => { clearTimeout(timer); resolve({ message: e.code || e.message }); });
    req.write(body); req.end();
  });
}
async function runSql(sql, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await runSqlOnce(sql);
    if (r?.message && (r.message.includes('timeout') || r.message.includes('ECONNRESET') || r.message.includes('Throttler'))) {
      if (attempt < retries) { await new Promise(res => setTimeout(res, 5000 * (attempt + 1))); continue; }
    }
    return r;
  }
  return { message: 'max retries' };
}

function esc(s) { return s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`; }

async function main() {
  process.on('uncaughtException', (err) => { if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return; console.error('Fatal:', err); process.exit(1); });

  const virkningstid = new Date().toISOString();
  console.log(`BIZZ-1659: Bulk backfill EJF Administrator — env=${TARGET_ENV}`);

  let cursor = AFTER_CURSOR;
  let total = 0, errors = 0, pages = 0;
  let buf = [];
  const startTime = Date.now();

  while (true) {
    pages++;
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const data = await dfQuery(`{
      EJFCustom_EjendomsadministratorBegraenset(first: ${PAGE_SIZE}, virkningstid: "${virkningstid}"${afterClause}) {
        nodes {
          id_lokalId bestemtFastEjendomBFENr virksomhedCVRNr virkningFra virkningTil status registreringFra registreringTil
        }
        pageInfo { hasNextPage endCursor }
      }
    }`);

    if (!data) { console.error('  [WARN] page failed — retrying in 30s'); await new Promise(r => setTimeout(r, 30000)); continue; }
    const nodes = data.EJFCustom_EjendomsadministratorBegraenset?.nodes ?? [];
    const pageInfo = data.EJFCustom_EjendomsadministratorBegraenset?.pageInfo;
    if (nodes.length === 0) break;

    buf.push(...nodes);

    if (buf.length >= 200) {
      const values = buf.map(n => {
        const cvr = n.virksomhedCVRNr ? esc(String(n.virksomhedCVRNr)) : 'NULL';
        const type = n.virksomhedCVRNr ? "'virksomhed'" : "'ukendt'";
        return `(${esc(n.id_lokalId)}, ${n.bestemtFastEjendomBFENr}, ${cvr}, ${type}, ${n.virkningFra ? esc(n.virkningFra) : 'NULL'}, ${n.virkningTil ? esc(n.virkningTil) : 'NULL'}, ${esc(n.status)}, now())`;
      }).join(',\n');
      const r = await runSql(`INSERT INTO ejf_administrator (id_lokal_id, bfe_nummer, virksomhed_cvr, administrator_type, virkning_fra, virkning_til, status, sidst_opdateret) VALUES ${values} ON CONFLICT (id_lokal_id) DO UPDATE SET virksomhed_cvr = COALESCE(EXCLUDED.virksomhed_cvr, ejf_administrator.virksomhed_cvr), administrator_type = CASE WHEN EXCLUDED.virksomhed_cvr IS NOT NULL THEN 'virksomhed' ELSE ejf_administrator.administrator_type END`);
      if (r?.message) { errors++; if (errors <= 5) console.error('  [INSERT ERR]:', r.message.substring(0, 100)); }
      else { total += buf.length; }
      buf = [];
    }

    if (pages % 10 === 0) {
      const rate = (total / ((Date.now() - startTime) / 1000)).toFixed(1);
      console.log(`  [page ${pages}] total=${total} errors=${errors} ${rate}/s`);
    }

    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await new Promise(r => setTimeout(r, 100));
  }

  if (buf.length > 0) {
    const values = buf.map(n => `(${esc(n.id_lokalId)}, ${n.bestemtFastEjendomBFENr}, 'ukendt', ${n.virkningFra ? esc(n.virkningFra) : 'NULL'}, ${n.virkningTil ? esc(n.virkningTil) : 'NULL'}, ${esc(n.status)}, now())`).join(',\n');
    const r = await runSql(`INSERT INTO ejf_administrator (id_lokal_id, bfe_nummer, administrator_type, virkning_fra, virkning_til, status, sidst_opdateret) VALUES ${values} ON CONFLICT (id_lokal_id) DO NOTHING`);
    if (!r?.message) total += buf.length;
  }

  console.log(`\nDone! ${((Date.now() - startTime) / 60000).toFixed(1)} min, total=${total}, errors=${errors}, pages=${pages}`);
  if (cursor) console.log(`Resume with: --after=${cursor}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
