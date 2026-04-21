#!/usr/bin/env node
/**
 * CVR bulk backfill — paginerer alle virksomheder fra CVR ES
 * og upsert'er til production Supabase cvr_virksomhed.
 *
 * BIZZ-666: Initial backfill af ~800k+ virksomheder.
 * Kører lokalt, taler direkte til prod Supabase via service role key.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-cvr-prod.mjs
 *
 * Requires env vars:
 *   CVR_ES_USER, CVR_ES_PASS — CVR ES credentials
 *   PROD_SUPABASE_URL, PROD_SUPABASE_KEY — production Supabase (fetched from Vercel)
 *
 * Or pass directly:
 *   PROD_SUPABASE_URL=... PROD_SUPABASE_KEY=... node scripts/backfill-cvr-prod.mjs
 */

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
const PAGE_SIZE = 1000;
const UPSERT_BATCH = 500;
const MAX_PAGES = 5000; // safety cap

async function main() {
  // ── Get Supabase prod credentials ──
  let prodUrl = process.env.PROD_SUPABASE_URL;
  let prodKey = process.env.PROD_SUPABASE_KEY;

  if (!prodUrl || !prodKey) {
    console.log('Fetching prod credentials from Vercel...');
    const vercelToken = process.env.VERCEL_API_TOKEN;
    const projectId = process.env.VERCEL_PROJECT_ID;
    const teamId = process.env.VERCEL_TEAM_ID;
    if (!vercelToken || !projectId) {
      console.error('Missing VERCEL_API_TOKEN / VERCEL_PROJECT_ID');
      process.exit(1);
    }

    const envs = await fetch(
      `https://api.vercel.com/v9/projects/${projectId}/env?teamId=${teamId}`,
      { headers: { Authorization: `Bearer ${vercelToken}` } }
    ).then(r => r.json());

    // Find IDs
    const urlId = envs.envs.find(e => e.key === 'NEXT_PUBLIC_SUPABASE_URL' && e.target.includes('production'))?.id;
    const keyId = envs.envs.find(e => e.key === 'SUPABASE_SERVICE_ROLE_KEY' && e.target.includes('production'))?.id;

    if (!urlId || !keyId) {
      console.error('Could not find production Supabase env vars in Vercel');
      process.exit(1);
    }

    const fetchDecrypted = async (id) => {
      const r = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}/env/${id}?teamId=${teamId}&decrypt=true`,
        { headers: { Authorization: `Bearer ${vercelToken}` } }
      );
      return (await r.json()).value;
    };

    prodUrl = await fetchDecrypted(urlId);
    prodKey = await fetchDecrypted(keyId);
    console.log(`Prod URL: ${prodUrl.slice(0, 40)}...`);
  }

  // ── CVR ES auth ──
  const cvrUser = process.env.CVR_ES_USER;
  const cvrPass = process.env.CVR_ES_PASS;
  if (!cvrUser || !cvrPass) {
    console.error('Missing CVR_ES_USER / CVR_ES_PASS');
    process.exit(1);
  }
  const cvrAuth = `Basic ${Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64')}`;

  // ── Pagination state ──
  let searchAfter = null;
  let totalFetched = 0;
  let totalUpserted = 0;
  let pagesFetched = 0;
  const startTime = Date.now();

  console.log(`Starting CVR backfill (page size ${PAGE_SIZE}, max ${MAX_PAGES} pages)...`);

  while (pagesFetched < MAX_PAGES) {
    const body = {
      size: PAGE_SIZE,
      sort: [{ 'Vrvirksomhed.cvrNummer': 'asc' }],
      query: { match_all: {} },
      _source: [
        'Vrvirksomhed.cvrNummer',
        'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn',
        'Vrvirksomhed.virksomhedMetadata.nyesteHovedbranche',
        'Vrvirksomhed.virksomhedMetadata.nyesteBeliggenhedsadresse',
        'Vrvirksomhed.virksomhedMetadata.nyesteVirksomhedsform',
        'Vrvirksomhed.virksomhedMetadata.nyesteStatus',
        'Vrvirksomhed.virksomhedMetadata.nyesteKontaktoplysninger',
        'Vrvirksomhed.virksomhedMetadata.stiftelsesDato',
        'Vrvirksomhed.virksomhedMetadata.nyesteAarsbeskaeftigelse',
        'Vrvirksomhed.samtId',
        'Vrvirksomhed.sidstOpdateret',
        'Vrvirksomhed.reklamebeskyttet',
      ],
    };
    if (searchAfter) body.search_after = searchAfter;

    let hits;
    try {
      const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: cvrAuth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.error(`ES HTTP ${res.status}`);
        break;
      }
      const json = await res.json();
      hits = json.hits?.hits ?? [];
    } catch (err) {
      console.error('ES fetch error:', err.message);
      break;
    }

    if (hits.length === 0) {
      console.log('No more results — backfill complete!');
      break;
    }

    // Map to rows
    const rows = [];
    for (const h of hits) {
      const v = h._source?.Vrvirksomhed;
      if (!v?.cvrNummer) continue;

      const meta = v.virksomhedMetadata ?? {};
      const adr = meta.nyesteBeliggenhedsadresse;
      const branche = meta.nyesteHovedbranche;

      const brancheKode = branche?.branchekode ? String(branche.branchekode).padStart(6, '0') : null;
      rows.push({
        cvr: String(v.cvrNummer),
        samt_id: v.samtId ?? null,
        navn: meta.nyesteNavn?.navn ?? null,
        status: meta.nyesteStatus ?? null,
        branche_kode: brancheKode,
        branche_tekst: branche?.branchetekst ?? null,
        virksomhedsform: meta.nyesteVirksomhedsform?.kortBeskrivelse ?? null,
        adresse_json: adr ?? null,
        ansatte_aar: meta.nyesteAarsbeskaeftigelse?.antalAnsatte ?? null,
        sidst_opdateret: v.sidstOpdateret ?? null,
        sidst_hentet_fra_cvr: new Date().toISOString(),
        raw_source: v,
      });
    }

    // Upsert to Supabase in batches
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH);
      const res = await fetch(`${prodUrl}/rest/v1/cvr_virksomhed`, {
        method: 'POST',
        headers: {
          apikey: prodKey,
          Authorization: `Bearer ${prodKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(batch),
      });
      if (res.ok) {
        totalUpserted += batch.length;
      } else {
        const err = await res.text();
        console.error(`Upsert failed: ${res.status} ${err.slice(0, 200)}`);
      }
    }

    totalFetched += hits.length;
    pagesFetched++;

    // Update search_after cursor
    const last = hits[hits.length - 1];
    searchAfter = last.sort;

    // Progress log every 10 pages
    if (pagesFetched % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (totalFetched / (Date.now() - startTime) * 1000).toFixed(0);
      console.log(`  Page ${pagesFetched}: ${totalFetched} fetched, ${totalUpserted} upserted (${rate}/s, ${elapsed}s elapsed)`);
    }

    if (hits.length < PAGE_SIZE) {
      console.log('Last page reached — backfill complete!');
      break;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nDone: ${totalFetched} fetched, ${totalUpserted} upserted in ${elapsed}s over ${pagesFetched} pages`);
}

main().catch(err => { console.error(err); process.exit(1); });
