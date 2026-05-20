#!/usr/bin/env node
/**
 * BIZZ-1712 + BIZZ-1709: Backfill ejf_ejerskifte + ejf_handelsoplysninger
 * fra Datafordeler EJF GraphQL.
 *
 * Paginerer gennem alle Ejerskifte-records via cursor, henter linked
 * Handelsoplysninger, og inserter i PROD via Management API.
 *
 * Usage:
 *   node scripts/backfill-ejf-ejerskifte.mjs --env=prod [--after=CURSOR]
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
const INSERT_BATCH = 200;

if (!ACCESS_TOKEN || !PROJECT_REF || !DF_CLIENT_ID || !DF_CLIENT_SECRET) {
  console.error('Missing credentials'); process.exit(1);
}

/** Get Datafordeler OAuth token. */
let cachedToken = null;
let tokenExpiry = 0;
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: DF_CLIENT_ID, client_secret: DF_CLIENT_SECRET });
  const res = await fetch('https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(), signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 300) * 1000;
  return cachedToken;
}

/** Execute GraphQL query against Datafordeler. */
async function dfQuery(query, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const token = await getToken();
      const res = await fetch('https://graphql.datafordeler.dk/flexibleCurrent/v1/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      if (data.errors) {
        if (attempt < retries) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
        console.error('  [GQL ERR]:', data.errors[0].message.substring(0, 100));
        return null;
      }
      return data.data;
    } catch (e) {
      if (attempt < retries) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
      console.error('  [GQL FETCH ERR]:', e.message);
      return null;
    }
  }
  return null;
}

/** Execute SQL via Management API with retry. */
function runSqlOnce(sql) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: sql });
    const timer = setTimeout(() => { req.destroy(); resolve({ message: 'timeout' }); }, 30000);
    const req = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
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
  process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
    console.error('Fatal:', err); process.exit(1);
  });

  const virkningstid = new Date().toISOString();
  console.log(`BIZZ-1712: Backfill EJF Ejerskifte+Handelsoplysninger — env=${TARGET_ENV}`);
  console.log(`Virkningstid: ${virkningstid}`);

  let cursor = AFTER_CURSOR;
  let totalEjerskifte = 0, totalHandel = 0, errors = 0, pages = 0;
  let ejerskifteBuf = [], handelBuf = [];
  const startTime = Date.now();

  while (true) {
    pages++;
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      EJF_Ejerskifte(first: ${PAGE_SIZE}, virkningstid: "${virkningstid}"${afterClause}) {
        nodes {
          id_lokalId bestemtFastEjendomBFENr overdragelsesmaade overtagelsesdato
          virkningFra virkningTil status registreringFra registreringTil
          handelsoplysningerLokalId
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const data = await dfQuery(query);
    if (!data) {
      console.error('  [WARN] page failed — retrying in 30s');
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    const nodes = data.EJF_Ejerskifte?.nodes ?? [];
    const pageInfo = data.EJF_Ejerskifte?.pageInfo;

    if (nodes.length === 0) break;

    // Collect Ejerskifte rows
    for (const n of nodes) {
      ejerskifteBuf.push(n);
    }

    // Fetch Handelsoplysninger for linked IDs
    const handelIds = nodes.map(n => n.handelsoplysningerLokalId).filter(Boolean);
    if (handelIds.length > 0) {
      // Batch lookup — query by IDs
      for (let i = 0; i < handelIds.length; i += 50) {
        const batch = handelIds.slice(i, i + 50);
        for (const hId of batch) {
          const hQuery = `{
            EJF_Handelsoplysninger(first: 1, virkningstid: "${virkningstid}", where: { id_lokalId: { eq: "${hId}" } }) {
              nodes {
                id_lokalId kontantKoebesum samletKoebesum loesoeresum entreprisesum
                koebsaftaleDato valutakode virkningFra virkningTil status
                registreringFra registreringTil
              }
            }
          }`;
          const hData = await dfQuery(hQuery);
          const hNodes = hData?.EJF_Handelsoplysninger?.nodes ?? [];
          handelBuf.push(...hNodes);
        }
      }
    }

    // Flush buffers
    if (ejerskifteBuf.length >= INSERT_BATCH) {
      // Insert Ejerskifte
      const values = ejerskifteBuf.map(n =>
        `(${esc(n.id_lokalId)}, ${n.bestemtFastEjendomBFENr}, ${esc(n.overdragelsesmaade)}, ${n.overtagelsesdato ? esc(n.overtagelsesdato) : 'NULL'}, ${esc(n.handelsoplysningerLokalId)}, ${n.virkningFra ? esc(n.virkningFra) : 'NULL'}, ${n.virkningTil ? esc(n.virkningTil) : 'NULL'}, ${esc(n.status)}, ${n.registreringFra ? esc(n.registreringFra) : 'NULL'}, ${n.registreringTil ? esc(n.registreringTil) : 'NULL'}, now())`
      ).join(',\n');
      const r = await runSql(`INSERT INTO ejf_ejerskifte (id_lokal_id, bfe_nummer, overdragelsesmaade, overtagelsesdato, handelsoplysninger_lokal_id, virkning_fra, virkning_til, status, registrering_fra, registrering_til, sidst_opdateret) VALUES ${values} ON CONFLICT (id_lokal_id) DO NOTHING`);
      if (r?.message) { errors++; if (errors <= 5) console.error(`  [INSERT ERR ejerskifte]: ${r.message.substring(0, 100)}`); }
      else { totalEjerskifte += ejerskifteBuf.length; }
      ejerskifteBuf = [];
    }

    if (handelBuf.length >= INSERT_BATCH / 2) {
      const values = handelBuf.map(n =>
        `(${esc(n.id_lokalId)}, ${n.kontantKoebesum ?? 'NULL'}, ${n.samletKoebesum ?? 'NULL'}, ${n.loesoeresum ?? 'NULL'}, ${n.entreprisesum ?? 'NULL'}, ${n.koebsaftaleDato ? esc(n.koebsaftaleDato) : 'NULL'}, ${esc(n.valutakode)}, ${n.virkningFra ? esc(n.virkningFra) : 'NULL'}, ${n.virkningTil ? esc(n.virkningTil) : 'NULL'}, ${esc(n.status)}, ${n.registreringFra ? esc(n.registreringFra) : 'NULL'}, ${n.registreringTil ? esc(n.registreringTil) : 'NULL'}, now())`
      ).join(',\n');
      const r = await runSql(`INSERT INTO ejf_handelsoplysninger (id_lokal_id, kontant_koebesum, samlet_koebesum, loesoeresum, entreprisesum, koebsaftale_dato, valutakode, virkning_fra, virkning_til, status, registrering_fra, registrering_til, sidst_opdateret) VALUES ${values} ON CONFLICT (id_lokal_id) DO NOTHING`);
      if (r?.message) { errors++; if (errors <= 5) console.error(`  [INSERT ERR handel]: ${r.message.substring(0, 100)}`); }
      else { totalHandel += handelBuf.length; }
      handelBuf = [];
    }

    if (pages % 10 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (totalEjerskifte / elapsed).toFixed(1);
      console.log(`  [page ${pages}] ejerskifte=${totalEjerskifte} handel=${totalHandel} errors=${errors} ${rate}/s cursor=${cursor?.substring(0, 20)}`);
    }

    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;

    await new Promise(r => setTimeout(r, 200));
  }

  // Final flush
  if (ejerskifteBuf.length > 0) {
    const values = ejerskifteBuf.map(n =>
      `(${esc(n.id_lokalId)}, ${n.bestemtFastEjendomBFENr}, ${esc(n.overdragelsesmaade)}, ${n.overtagelsesdato ? esc(n.overtagelsesdato) : 'NULL'}, ${esc(n.handelsoplysningerLokalId)}, ${n.virkningFra ? esc(n.virkningFra) : 'NULL'}, ${n.virkningTil ? esc(n.virkningTil) : 'NULL'}, ${esc(n.status)}, ${n.registreringFra ? esc(n.registreringFra) : 'NULL'}, ${n.registreringTil ? esc(n.registreringTil) : 'NULL'}, now())`
    ).join(',\n');
    const r = await runSql(`INSERT INTO ejf_ejerskifte (id_lokal_id, bfe_nummer, overdragelsesmaade, overtagelsesdato, handelsoplysninger_lokal_id, virkning_fra, virkning_til, status, registrering_fra, registrering_til, sidst_opdateret) VALUES ${values} ON CONFLICT (id_lokal_id) DO NOTHING`);
    if (!r?.message) totalEjerskifte += ejerskifteBuf.length;
  }
  if (handelBuf.length > 0) {
    const values = handelBuf.map(n =>
      `(${esc(n.id_lokalId)}, ${n.kontantKoebesum ?? 'NULL'}, ${n.samletKoebesum ?? 'NULL'}, ${n.loesoeresum ?? 'NULL'}, ${n.entreprisesum ?? 'NULL'}, ${n.koebsaftaleDato ? esc(n.koebsaftaleDato) : 'NULL'}, ${esc(n.valutakode)}, ${n.virkningFra ? esc(n.virkningFra) : 'NULL'}, ${n.virkningTil ? esc(n.virkningTil) : 'NULL'}, ${esc(n.status)}, ${n.registreringFra ? esc(n.registreringFra) : 'NULL'}, ${n.registreringTil ? esc(n.registreringTil) : 'NULL'}, now())`
    ).join(',\n');
    const r = await runSql(`INSERT INTO ejf_handelsoplysninger (id_lokal_id, kontant_koebesum, samlet_koebesum, loesoeresum, entreprisesum, koebsaftale_dato, valutakode, virkning_fra, virkning_til, status, registrering_fra, registrering_til, sidst_opdateret) VALUES ${values} ON CONFLICT (id_lokal_id) DO NOTHING`);
    if (!r?.message) totalHandel += handelBuf.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone! ${elapsed} min, ejerskifte=${totalEjerskifte}, handel=${totalHandel}, errors=${errors}, pages=${pages}`);
  if (cursor) console.log(`Resume with: --after=${cursor}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
