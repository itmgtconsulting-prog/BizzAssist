#!/usr/bin/env node
/**
 * BIZZ-1796: Targeted backfill for BFEs without ejerskab via EJF API.
 */
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '.env.local' });

const client = new pg.Client({ connectionString: process.env.SUPABASE_PROD_DB_URL, statement_timeout: 30000 });
await client.connect();

let tokenData = null;
async function getToken() {
  if (tokenData && Date.now() < tokenData.exp - 60000) return tokenData.token;
  const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.DATAFORDELER_OAUTH_CLIENT_ID, client_secret: process.env.DATAFORDELER_OAUTH_CLIENT_SECRET });
  const res = await fetch('https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  const d = await res.json();
  tokenData = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return tokenData.token;
}

const missing = await client.query(`
  SELECT b.bfe_nummer FROM bbr_ejendom_status b
  WHERE b.is_udfaset = false
    AND NOT EXISTS (SELECT 1 FROM ejf_ejerskab e WHERE e.bfe_nummer = b.bfe_nummer AND e.status = 'gældende')
  ORDER BY b.bfe_nummer
`);
console.log('Total BFE without ejerskab:', missing.rows.length);

let total = 0, inserted = 0, empty = 0, errors = 0;
const startTime = Date.now();
const vt = new Date().toISOString();

for (const row of missing.rows) {
  try {
    const token = await getToken();
    const res = await fetch('https://graphql.datafordeler.dk/flexibleCurrent/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ query: `{EJFCustom_EjerskabBegraenset(first:50, virkningstid: "${vt}", where: { bestemtFastEjendomBFENr: { eq: ${row.bfe_nummer} } }) { nodes { bestemtFastEjendomBFENr ejerforholdskode faktiskEjerandel_taeller faktiskEjerandel_naevner virkningFra virkningTil status ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref { CVRNummer } ejendePersonBegraenset { id navn { navn } foedselsdato } } }}` }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await res.json();
    const nodes = d.data?.EJFCustom_EjerskabBegraenset?.nodes || [];

    if (nodes.length === 0) { empty++; total++; continue; }

    for (const n of nodes) {
      const person = n.ejendePersonBegraenset;
      const cvr = n.ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref?.CVRNummer;
      const ejerNavn = person?.navn?.navn || (cvr ? 'CVR ' + cvr : 'Ukendt');
      const ejerType = cvr ? 'virksomhed' : 'person';
      const ejerId = cvr ? 'virk-' + cvr : (person?.id || 'unknown');

      await client.query(
        `INSERT INTO ejf_ejerskab (bfe_nummer, ejer_ejf_id, virkning_fra, ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, status, virkning_til, sidst_opdateret) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT DO NOTHING`,
        [row.bfe_nummer, ejerId, n.virkningFra, ejerNavn, cvr ? String(cvr) : null, ejerType, n.faktiskEjerandel_taeller, n.faktiskEjerandel_naevner, n.status || 'gældende', n.virkningTil]
      );
      inserted++;
    }
  } catch (e) {
    errors++;
    if (errors <= 5) console.error('ERR BFE ' + row.bfe_nummer + ': ' + e.message?.substring(0, 60));
  }

  total++;
  if (total % 500 === 0) {
    const rate = (total / ((Date.now() - startTime) / 1000)).toFixed(1);
    console.log(`[${total}/${missing.rows.length}] inserted=${inserted} empty=${empty} errors=${errors} ${rate}/s`);
  }
}

console.log(`\nDone! total=${total} inserted=${inserted} empty=${empty} errors=${errors}`);
await client.end();
