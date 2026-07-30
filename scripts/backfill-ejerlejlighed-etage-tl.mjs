#!/usr/bin/env node
/**
 * BIZZ-2179 (fase 2): Komplettér værelser/etager for ejerlejligheder UDEN etage/dør
 * i bfe_adresse_cache, ved at hente enhedsadressen (etage/dør) fra Tinglysning.
 *
 * Fase 1 (backfill-ejerlejlighed-vaerelser.mjs) dækkede de ~285k ejerlejligheder der
 * allerede havde etage/dør i cachen. Tilbage står ~90k med adgangsadresse men NULL
 * etage — heraf er kun ~36% ægte ejerlejligheder (resten er SFE uden enhedsadresse).
 *
 * Den ENESTE live-kilde til BFE→etage/dør for en ejerlejlighed er Tinglysning
 * /ejdsummarisk (FloorIdentifier/SuiteIdentifier i AdresseStruktur/AddressSpecific) —
 * verificeret 2026-06-23. SFE returnerer kun AddressAccess (husnr), så ikke-
 * ejerlejligheder filtreres dobbelt: (a) BBR_Ejendomsrelation-klassifikation før TL,
 * (b) intet FloorIdentifier → spring over.
 *
 * Pipeline pr. ægte ejerlejlighed-BFE:
 *   1. BBR_Ejendomsrelation: klassificér EJL vs SFE (batch, før TL — sparer TL-kald).
 *   2. TL REST /ejendom/hovednoteringsnummer?hovednoteringsnummer={bfe} → uuid.
 *   3. TL REST /ejdsummarisk/{uuid} → FloorIdentifier(etage) + SuiteIdentifier(dør).
 *   4. DAWA /adresser (vej+husnr+postnr+etage+dør) → enhedsadresse-UUID.
 *   5. BBR_Enhed(adresseIdentificerer=UUID) → enh031AntalVaerelser + bygning.
 *   6. BBR_Bygning.byg054AntalEtager (batch).
 *   7. Skriv etage/dør → bfe_adresse_cache (offentlig DAR-adressedata) OG
 *      antal_vaerelser/antal_etager → bbr_ejendom_status (autoritativ BBR-data).
 *
 * Keyset-pagineret (bfe_nummer) + crash-resumable (skrevne rækker får etage != NULL
 * og falder ud af WHERE). Lav TL-concurrency + 429-backoff (rammer prod-Tinglysning).
 *
 * Brug:
 *   node scripts/backfill-ejerlejlighed-etage-tl.mjs --env=prod [--concurrency=4] [--page=300] [--limit=200000] [--dry-run] [--no-refresh]
 *
 * Kræver i .env.local: SUPABASE_ACCESS_TOKEN, DATAFORDELER_API_KEY,
 *   TINGLYSNING_CERT_PATH, TINGLYSNING_CERT_PASSWORD, TINGLYSNING_BASE_URL.
 */

import https from 'https';
import fs from 'fs';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const envTarget = args.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'test';
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '200000', 10);
const concurrency = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '4',
  10
);
const PAGE = parseInt(args.find((a) => a.startsWith('--page='))?.split('=')[1] ?? '300', 10);
const dryRun = args.includes('--dry-run');
const noRefresh = args.includes('--no-refresh');

// ── .env.local ─────────────────────────────────────────────────
const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const PROJECT_REFS = {
  prod: 'xsyldjqcntiygrtfcszm',
  test: 'rlkjmqjxmkxuclehbrnl',
  dev: 'wkzwxfhyfmvglrqtmebw',
};
const REF = PROJECT_REFS[envTarget];
if (!REF) throw new Error(`Ukendt env: ${envTarget}`);

const BBR_V2 = `https://graphql.datafordeler.dk/BBR/v2?apiKey=${env.DATAFORDELER_API_KEY}`;
const DAWA = 'https://api.dataforsyningen.dk';
const TL_BASE = env.TINGLYSNING_BASE_URL ?? 'https://www.tinglysning.dk';
const TL_PFX = fs.readFileSync(env.TINGLYSNING_CERT_PATH);
const TL_PASS = env.TINGLYSNING_CERT_PASSWORD;
const RETIRED_STATUS = new Set(['4', '7', '10', '11']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Supabase Management API SQL (retry på transiente fejl) ──────
async function runSql(sql) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        const txt = await res.text();
        if (res.status < 500) throw new Error(`Supabase API ${res.status}: ${txt.slice(0, 300)}`);
        throw Object.assign(new Error(`Supabase API ${res.status}`), { transient: true });
      }
      const raw = await res.json();
      return Array.isArray(raw) ? raw : (raw.result ?? raw.rows ?? []);
    } catch (err) {
      const transient = err.transient || err.name === 'TimeoutError' || err.code === 'ECONNRESET';
      if (!transient || attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

// ── Tinglysning direkte mTLS GET (429-aware backoff) ───────────
function tlGet(urlPath, accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const url = new URL(`${TL_BASE}/tinglysning/ssl${urlPath}`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        pfx: TL_PFX,
        passphrase: TL_PASS,
        rejectUnauthorized: false,
        timeout: 30000,
        headers: { Accept: accept },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

/** BFE → ejdsummarisk-XML (med 429/5xx-backoff). Returnerer XML eller null. */
async function fetchSummariskXml(bfe) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const s = await tlGet(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
      if (s.status === 429 || s.status >= 500) throw Object.assign(new Error(`TL ${s.status}`), { transient: true });
      if (s.status !== 200) return null;
      let uuid = null;
      try {
        uuid = JSON.parse(s.body)?.items?.[0]?.uuid ?? null;
      } catch {
        /* */
      }
      if (!uuid) return null;
      const sum = await tlGet(`/ejdsummarisk/${uuid}`, 'application/xml');
      if (sum.status === 429 || sum.status >= 500) throw Object.assign(new Error(`TL ${sum.status}`), { transient: true });
      if (sum.status !== 200) return null;
      return sum.body;
    } catch (err) {
      if (!err.transient || attempt === 4) return null;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

/**
 * Udtræk HELE adressen (vej, husnr, postnr, etage, dør) fra ejdsummarisk-XML.
 *
 * Vigtigt: bfe_adresse_cache.adresse er upålidelig for denne slice — mange rækker
 * indeholder matrikel-betegnelser ("1cp Gentofte") frem for en rigtig gadeadresse.
 * Derfor bruges TL's egen AdresseStruktur som autoritativ kilde:
 *   StreetName + StreetBuildingIdentifier + PostCodeIdentifier + Floor/SuiteIdentifier.
 * Etage/dør normaliseres til lowercase (TL: "TH"/"ST" → DAWA/cache: "th"/"st").
 * Kun ægte ejerlejligheder har FloorIdentifier; SFE har kun AddressAccess (husnr).
 */
function parseTlAddress(xml) {
  const struct = xml.match(/AdresseStruktur[^>]*>([\s\S]*?)<\/[^>]*AdresseStruktur>/)?.[1] ?? '';
  const spec = struct.match(/AddressSpecific>([\s\S]*?)<\/[^>]*AddressSpecific>/)?.[1] ?? '';
  const vejnavn = struct.match(/StreetName[^>]*>([^<]+)/)?.[1]?.trim() ?? null;
  const husnr = struct.match(/StreetBuildingIdentifier[^>]*>([^<]+)/)?.[1]?.trim() ?? null;
  const postnr = struct.match(/PostCodeIdentifier[^>]*>([^<]+)/)?.[1]?.trim() ?? null;
  const etage = spec.match(/FloorIdentifier[^>]*>([^<]+)/)?.[1]?.trim().toLowerCase() ?? null;
  const doer = spec.match(/SuiteIdentifier[^>]*>([^<]+)/)?.[1]?.trim().toLowerCase() ?? null;
  return { vejnavn, husnr, postnr, etage, doer };
}

// ── BBR_Ejendomsrelation: klassificér ægte ejerlejlighed (batch ≤100) ──
async function classifyEjl(bfeList) {
  const vt = new Date().toISOString().replace('Z', '+01:00');
  const ejl = new Set();
  for (let i = 0; i < bfeList.length; i += 100) {
    const chunk = bfeList.slice(i, i + 100);
    const query = `query($vt: DafDateTime!, $ids: [Long!]) {
      BBR_Ejendomsrelation(first: 500, virkningstid: $vt, where: { bfeNummer: { in: $ids } }) {
        nodes { bfeNummer ejerlejlighed }
      }
    }`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(BBR_V2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { vt, ids: chunk } }),
          signal: AbortSignal.timeout(25000),
        });
        const json = await res.json();
        if (json.errors) {
          if (attempt === 3) break;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        for (const n of json.data?.BBR_Ejendomsrelation?.nodes ?? []) {
          if (n.ejerlejlighed) ejl.add(Number(n.bfeNummer));
        }
        break;
      } catch {
        if (attempt === 3) break;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  return ejl;
}

// ── DAWA enhedsadresse-UUID ────────────────────────────────────
async function resolveEnhedsadresseId({ vejnavn, husnr, postnr, etage, doer }) {
  const params = new URLSearchParams({ vejnavn, husnr, postnr, struktur: 'mini' });
  if (etage) params.set('etage', etage);
  if (doer) params.set('dør', doer);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${DAWA}/adresser?${params}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        if (res.status < 500) return null;
        throw new Error(`DAWA ${res.status}`);
      }
      const addrs = await res.json();
      if (!Array.isArray(addrs) || addrs.length === 0) return null;
      const exact = addrs.find(
        (a) =>
          (etage ? String(a.etage ?? '') === String(etage) : true) &&
          (doer ? String(a.dør ?? '').toLowerCase() === String(doer).toLowerCase() : true)
      );
      return (exact ?? addrs[0]).id ?? null;
    } catch {
      if (attempt === 3) return null;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

// ── BBR_Enhed → værelser + bygning ─────────────────────────────
async function fetchEnhedData(enhedsadresseId) {
  const vt = new Date().toISOString().replace('Z', '+01:00');
  const query = `query($vt: DafDateTime!, $id: String!) {
    BBR_Enhed(first: 50, virkningstid: $vt, where: { adresseIdentificerer: { eq: $id } }) {
      nodes { enh031AntalVaerelser bygning status }
    }
  }`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(BBR_V2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { vt, id: enhedsadresseId } }),
        signal: AbortSignal.timeout(20000),
      });
      const json = await res.json();
      if (json.errors) {
        if (attempt === 3) return null;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      const nodes = json.data?.BBR_Enhed?.nodes ?? [];
      let best = null;
      let bygningId = null;
      for (const n of nodes) {
        if (RETIRED_STATUS.has(String(n.status ?? ''))) continue;
        const v = Number(n.enh031AntalVaerelser ?? 0);
        if (v > 0 && (best === null || v > best)) best = v;
        if (!bygningId && n.bygning && UUID_RE.test(n.bygning)) bygningId = n.bygning;
      }
      return { vaerelser: best, bygningId };
    } catch {
      if (attempt === 3) return null;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return null;
}

// ── BBR_Bygning → etager (batch) ───────────────────────────────
async function fetchEtagerForBygninger(bygningIds) {
  const vt = new Date().toISOString().replace('Z', '+01:00');
  const out = new Map();
  for (let i = 0; i < bygningIds.length; i += 100) {
    const chunk = bygningIds.slice(i, i + 100);
    const query = `query($vt: DafDateTime!, $ids: [String!]) {
      BBR_Bygning(first: 500, virkningstid: $vt, where: { id_lokalId: { in: $ids } }) {
        nodes { id_lokalId byg054AntalEtager status }
      }
    }`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(BBR_V2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { vt, ids: chunk } }),
          signal: AbortSignal.timeout(25000),
        });
        const json = await res.json();
        if (json.errors) {
          if (attempt === 3) break;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        for (const n of json.data?.BBR_Bygning?.nodes ?? []) {
          if (RETIRED_STATUS.has(String(n.status ?? ''))) continue;
          const e = Number(n.byg054AntalEtager ?? 0);
          if (e > 0 && n.id_lokalId) {
            const cur = out.get(n.id_lokalId);
            if (cur == null || e > cur) out.set(n.id_lokalId, e);
          }
        }
        break;
      } catch {
        if (attempt === 3) break;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  return out;
}

/** SQL-escape (enkelt-citationstegn). */
function sq(s) {
  return s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
}

// ── Hovedløkke: keyset-pagineret over no-etage-slicen ──────────
let processed = 0;
let totalEjl = 0;
let totalResolved = 0;
let totalWritten = 0;

/** Resolve etage/dør (TL) + værelser (DAWA→BBR) for én ejerlejlighed-kandidat. */
async function resolveOne(c) {
  const xml = await fetchSummariskXml(Number(c.bfe_nummer));
  if (!xml) return null;
  const { vejnavn, husnr, postnr, etage, doer } = parseTlAddress(xml);
  if (!etage || !vejnavn || !husnr) return null; // SFE / ingen enhedsadresse → spring over
  const enhedsadresseId = await resolveEnhedsadresseId({
    vejnavn,
    husnr,
    postnr: String(postnr ?? c.postnr ?? ''),
    etage,
    doer,
  });
  let vaerelser = null;
  let bygningId = null;
  if (enhedsadresseId) {
    const data = await fetchEnhedData(enhedsadresseId);
    if (data) {
      vaerelser = data.vaerelser;
      bygningId = data.bygningId;
    }
  }
  return { bfe: Number(c.bfe_nummer), etage, doer, vaerelser, bygningId };
}

async function processPage(page) {
  // Pre-klassificér: behold kun ægte ejerlejligheder (sparer TL-kald på SFE).
  const ejlSet = await classifyEjl(page.map((c) => Number(c.bfe_nummer)));
  const ejlCands = page.filter((c) => ejlSet.has(Number(c.bfe_nummer)));
  totalEjl += ejlCands.length;

  const resolved = [];
  let i = 0;
  async function worker() {
    while (i < ejlCands.length) {
      const c = ejlCands[i++];
      processed++;
      const r = await resolveOne(c);
      if (r) resolved.push(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  totalResolved += resolved.length;
  return resolved;
}

async function writePage(resolved) {
  // Etager pr. bygning (batch).
  const uniqueByg = [...new Set(resolved.map((r) => r.bygningId).filter(Boolean))];
  const etagerByByg = await fetchEtagerForBygninger(uniqueByg);

  // 1) bfe_adresse_cache: etage/dør (offentlig DAR-adressedata).
  const cacheRows = resolved.filter((r) => r.etage);
  for (let i = 0; i < cacheRows.length; i += 500) {
    const batch = cacheRows.slice(i, i + 500);
    const values = batch.map((r) => `(${r.bfe}, ${sq(r.etage)}, ${sq(r.doer)})`).join(',');
    await runSql(`
      UPDATE bfe_adresse_cache a
      SET etage = v.etage, doer = v.doer
      FROM (VALUES ${values}) AS v(bfe, etage, doer)
      WHERE a.bfe_nummer = v.bfe AND a.etage IS NULL;
    `);
  }

  // 2) bbr_ejendom_status: antal_vaerelser/antal_etager (autoritativ BBR-data).
  const statusRows = resolved
    .filter((r) => r.vaerelser != null && r.vaerelser > 0)
    .map((r) => ({
      bfe: r.bfe,
      vaerelser: r.vaerelser,
      etager: r.bygningId ? (etagerByByg.get(r.bygningId) ?? null) : null,
    }));
  for (let i = 0; i < statusRows.length; i += 500) {
    const batch = statusRows.slice(i, i + 500);
    const values = batch
      .map((u) => `(${u.bfe}, ${u.vaerelser}, ${u.etager === null ? 'NULL' : u.etager})`)
      .join(',');
    await runSql(`
      UPDATE bbr_ejendom_status b
      SET antal_vaerelser = v.vaerelser,
          antal_etager = COALESCE(b.antal_etager, v.etager)
      FROM (VALUES ${values}) AS v(bfe, vaerelser, etager)
      WHERE b.bfe_nummer = v.bfe AND b.antal_vaerelser IS NULL;
    `);
    totalWritten += batch.length;
  }
}

let cursor = 0;
let pageNo = 0;
while (processed < limit) {
  let page;
  try {
    page = await runSql(`
      SELECT DISTINCT b.bfe_nummer, a.adresse, a.postnr
      FROM bbr_ejendom_status b
      JOIN v_ejerskifte_handel h
        ON h.bfe_nummer = b.bfe_nummer AND h.samlet_koebesum > 0 AND h.overtagelsesdato IS NOT NULL
      JOIN bfe_adresse_cache a ON a.bfe_nummer = b.bfe_nummer
      WHERE b.antal_vaerelser IS NULL
        AND b.byg021_anvendelse IS NULL
        AND a.etage IS NULL
        AND a.adresse IS NOT NULL
        AND a.adresse NOT LIKE 'BFE %'
        AND b.bfe_nummer > ${cursor}
      ORDER BY b.bfe_nummer
      LIMIT ${PAGE};
    `);
  } catch (err) {
    console.error(`Side-fetch fejlede ved cursor ${cursor}: ${err.message}. Stopper pænt — re-kør.`);
    break;
  }
  if (page.length === 0) break;
  cursor = Number(page[page.length - 1].bfe_nummer);
  pageNo++;
  const resolved = await processPage(page);
  if (dryRun) {
    console.log(`DRY-RUN side ${pageNo} (t.o.m. BFE ${cursor}): ${resolved.length} løst af ${totalEjl} EJL. Eksempel:`, resolved.slice(0, 5));
    break;
  }
  try {
    if (resolved.length > 0) await writePage(resolved);
  } catch (err) {
    console.error(`Skrivning fejlede ved cursor ${cursor}: ${err.message}. Stopper pænt — re-kør.`);
    break;
  }
  console.log(
    `Side ${pageNo} (t.o.m. BFE ${cursor}): behandlet ${processed}, EJL ${totalEjl}, løst ${totalResolved}, skrevet ${totalWritten}`
  );
}
console.log(`Færdig-resolve. Behandlet ${processed} EJL, løst ${totalResolved}, skrevet ${totalWritten}.`);

if (dryRun) process.exit(0);

if (!noRefresh) {
  console.log('Refresher mv_boligpris_handler …');
  try {
    await runSql('REFRESH MATERIALIZED VIEW public.mv_boligpris_handler;');
  } catch (err) {
    console.error(`MV-refresh fejlede (${err.message}). Data ER skrevet — kør REFRESH manuelt.`);
  }
}
console.log('Færdig.');
