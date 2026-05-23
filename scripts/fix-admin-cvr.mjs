import pg from 'pg';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 30000 });
await client.connect();

const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.DATAFORDELER_OAUTH_CLIENT_ID, client_secret: process.env.DATAFORDELER_OAUTH_CLIENT_SECRET });
const tokenRes = await fetch('https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
const token = (await tokenRes.json()).access_token;

const virkningstid = new Date().toISOString();
let cursor = null;
let total = 0, updated = 0;
const startTime = Date.now();

console.log('Updating ejf_administrator with virksomhedCVRNr...');

while (true) {
  const afterClause = cursor ? `, after: "${cursor}"` : '';
  const res = await fetch('https://graphql.datafordeler.dk/flexibleCurrent/v1/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ query: `{EJFCustom_EjendomsadministratorBegraenset(first: 500, virkningstid: "${virkningstid}"${afterClause}) { nodes { id_lokalId virksomhedCVRNr } pageInfo { hasNextPage endCursor } }}` }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!data.data) { console.log('API error — retrying...'); await new Promise(r => setTimeout(r, 5000)); continue; }

  const nodes = data.data.EJFCustom_EjendomsadministratorBegraenset.nodes;
  const pageInfo = data.data.EJFCustom_EjendomsadministratorBegraenset.pageInfo;
  if (nodes.length === 0) break;

  for (const n of nodes) {
    if (n.virksomhedCVRNr) {
      await client.query('UPDATE ejf_administrator SET virksomhed_cvr = $1, administrator_type = $2 WHERE id_lokal_id = $3 AND virksomhed_cvr IS NULL', [String(n.virksomhedCVRNr), 'virksomhed', n.id_lokalId]);
      updated++;
    }
  }

  total += nodes.length;
  if (total % 5000 === 0) {
    const rate = (total / ((Date.now() - startTime) / 1000)).toFixed(0);
    console.log(`  [${total}] updated=${updated} ${rate}/s`);
  }

  if (!pageInfo.hasNextPage) break;
  cursor = pageInfo.endCursor;
  await new Promise(r => setTimeout(r, 50));
}

console.log(`Done! total=${total} updated=${updated}`);
const r = await client.query('SELECT count(*) FROM ejf_administrator WHERE virksomhed_cvr IS NOT NULL');
console.log('Med CVR: ' + r.rows[0].count);
await client.end();
