#!/usr/bin/env node
/**
 * Targeted TL backfill: tag CLI-liste af BFE-numre og kør existing parser-logik
 * Bruger samme parser som backfill-tl-all-ejf-bfes.mjs men kun på specifikke BFEer.
 *
 * Usage: node scripts/backfill-tl-targeted.mjs --bfes=100165694,100435372,...
 */

import https from 'https';
import fs from 'fs';
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k,v] = a.replace(/^--/,'').split('='); return [k, v ?? 'true']; }));
const BFES = (args.bfes && args.bfes !== 'true') ? args.bfes.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0) : [];
if (BFES.length === 0) { console.error('Usage: --bfes=N,N,N'); process.exit(1); }

const envContent = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = envContent.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const CERT_PATH = envContent.match(/^TINGLYSNING_CERT_PATH=(.+)$/m)?.[1] || './certs/nemlogin-prod/BizzAssist.p12';
const CERT_PASS = envContent.match(/^TINGLYSNING_CERT_PASSWORD=(.+)$/m)?.[1] || '';
const pfx = fs.readFileSync(CERT_PATH);
const TL_BASE = 'https://www.tinglysning.dk';

// Re-use helpers from backfill-tl-all-ejf-bfes.mjs
function extractText(xml, tag) { const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`)); return m?.[1]?.trim() || null; }
function extractInt(xml, tag) { const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`)); const n = parseInt(m?.[1]?.trim() || '', 10); return Number.isFinite(n) ? n : null; }
function extractDate(xml, tag) { const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`)); return m?.[1]?.split(/[+T]/)[0] || null; }
function extractKreditor(xml) {
  const b = xml.match(/KreditorInformationSamling[^>]*>([\s\S]*?)<\/[^:]*:?KreditorInformationSamling/);
  if (!b) return { navn: null, cvr: null };
  return { navn: extractText(b[1], 'LegalUnitName') || extractText(b[1], 'PersonName'), cvr: extractText(b[1], 'CVRnumberIdentifier') };
}
function extractKoebere(xml) {
  const s = xml.match(/AdkomsthaverSamling[^>]*>([\s\S]*?)<\/[^:]*:?AdkomsthaverSamling/);
  if (!s) return { navne: [], cvrs: [], andelTaeller: null, andelNaevner: null };
  const entries = [...s[1].matchAll(/(?:^|<[^:]*:?Adkomsthaver[^>]*>)([\s\S]*?)<\/[^:]*:?Adkomsthaver/g)];
  const navne = [], cvrs = []; let andelTaeller = null, andelNaevner = null;
  for (const [, e] of entries) {
    const p = extractText(e, 'PersonName'); const v = extractText(e, 'LegalUnitName'); const cvr = extractText(e, 'CVRnumberIdentifier');
    if (p) navne.push(p); else if (v) navne.push(v);
    if (cvr) cvrs.push(cvr);
    if (andelTaeller === null) { const i = e.match(/AndelIdeel[^>]*>([\s\S]*?)<\/[^:]*:?AndelIdeel/); if (i) { andelTaeller = extractInt(i[1], 'Taeller'); andelNaevner = extractInt(i[1], 'Naevner'); } }
  }
  return { navne, cvrs, andelTaeller, andelNaevner };
}

function tlGet(urlPath, accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const url = new URL(TL_BASE + '/tinglysning/ssl' + urlPath);
    const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'GET', pfx, passphrase: CERT_PASS, rejectUnauthorized: false, timeout: 30000, headers: { Accept: accept } }, (res) => { let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); }); req.end();
  });
}

async function processBfe(bfe, db) {
  const r1 = await tlGet(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return { bfe, status: 'no-uuid' };
  let uuid;
  try { uuid = JSON.parse(r1.body)?.items?.[0]?.uuid; } catch { return { bfe, status: 'parse-error' }; }
  if (!uuid) return { bfe, status: 'no-uuid' };
  const r2 = await tlGet(`/ejdsummarisk/${uuid}`, 'application/xml');
  if (r2.status !== 200 || !r2.body) return { bfe, status: `http-${r2.status}` };
  const xml = r2.body;

  const handler = [];
  for (const [, e] of xml.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g)) {
    const dato = extractDate(e, 'SkoedeOvertagelsesDato');
    const koebesum = extractInt(e, 'KontantKoebesum');
    if (!dato && !koebesum) continue;
    const k = extractKoebere(e);
    handler.push({ bfe_nummer: bfe, dato, tinglyst_dato: extractDate(e, 'TinglysningsDato'), koebesum, samlet_koebesum: extractInt(e, 'IAltKoebesum'), andel_taeller: k.andelTaeller, andel_naevner: k.andelNaevner, koeber_navne: k.navne.length > 0 ? k.navne : null, koeber_cvrs: k.cvrs.length > 0 ? k.cvrs : null });
  }
  const haeftelser = [];
  let prioritet = 0;
  for (const [, e] of xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk/g)) {
    prioritet++;
    const kreditor = extractKreditor(e);
    haeftelser.push({ bfe_nummer: bfe, prioritet, type: extractText(e, 'DokumentType') || extractText(e, 'HaeftelseType') || 'Ukendt', hovedstol_dkk: extractInt(e, 'BeloebVaerdi'), kreditor_navn: kreditor.navn, kreditor_cvr: kreditor.cvr, tinglyst_dato: extractDate(e, 'TinglysningsDato'), akt_navn: extractText(e, 'DokumentAliasIdentifikator'), status: extractText(e, 'Status')?.toLowerCase() || 'gaeldende' });
  }

  if (handler.length === 0 && haeftelser.length === 0) return { bfe, status: 'no-tl-data' };

  const ejere = handler.flatMap(h => (h.koeber_navne || []).map((navn, i) => ({ navn, cvr: (h.koeber_cvrs || [])[i] || null, type: (h.koeber_cvrs || [])[i] ? 'selskab' : 'person', adkomstType: 'skoede', andel: h.andel_taeller && h.andel_naevner ? `${Math.round((h.andel_taeller/h.andel_naevner)*100)}%` : null, andelTaeller: h.andel_taeller, andelNaevner: h.andel_naevner, overtagelsesdato: h.dato, tinglysningsdato: h.tinglyst_dato, koebesum: h.koebesum, koebsaftaledato: null, kontantKoebesum: h.koebesum, iAltKoebesum: h.samlet_koebesum, tinglysningsafgift: null, anmelderNavn: null, anmelderEmail: null, anmelderCvr: null, skoedeTekst: null, ejendomKategori: null, handelKode: null, adresse: null, kommunekode: null, dokumentId: null, dokumentAlias: null, dato: h.tinglyst_dato })));
  const cachePayload = { ejere, haeftelser: haeftelser.map(h => ({ prioritet: h.prioritet, type: h.type, hovedstol: h.hovedstol_dkk, kreditor: h.kreditor_navn, kreditorCvr: h.kreditor_cvr, tinglysningsdato: h.tinglyst_dato, dokumentAlias: h.akt_navn, status: h.status })), servitutter: [], bilagRefs: [], indskannedeAkterNavne: [], tingbogsattest: null, fejl: null };

  await db.query('BEGIN');
  try {
    if (handler.length > 0) {
      await db.query("DELETE FROM ejendomshandel WHERE bfe_nummer=$1 AND kilde='tinglysning-summarisk'", [bfe]);
      for (const h of handler) await db.query(`INSERT INTO ejendomshandel (bfe_nummer, dato, tinglyst_dato, koebesum, samlet_koebesum, andel_taeller, andel_naevner, koeber_navne, koeber_cvrs, kilde, sidst_opdateret) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'tinglysning-summarisk',NOW())`, [h.bfe_nummer, h.dato, h.tinglyst_dato, h.koebesum, h.samlet_koebesum, h.andel_taeller, h.andel_naevner, h.koeber_navne, h.koeber_cvrs]);
    }
    if (haeftelser.length > 0) {
      await db.query('DELETE FROM tinglysning_haeftelse WHERE bfe_nummer = $1', [bfe]);
      for (const r of haeftelser) await db.query(`INSERT INTO tinglysning_haeftelse (bfe_nummer, prioritet, type, hovedstol_dkk, kreditor_navn, kreditor_cvr, tinglyst_dato, akt_navn, status, sidst_opdateret) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`, [r.bfe_nummer, r.prioritet, r.type, r.hovedstol_dkk, r.kreditor_navn, r.kreditor_cvr, r.tinglyst_dato, r.akt_navn, r.status]);
    }
    await db.query(`INSERT INTO tinglysning_summarisk_cache (uuid, bfe_nummer, payload, fetched_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (uuid) DO UPDATE SET bfe_nummer = EXCLUDED.bfe_nummer, payload = EXCLUDED.payload, fetched_at = NOW()`, [uuid, bfe, JSON.stringify(cachePayload)]);
    await db.query('COMMIT');
    return { bfe, status: 'ok', handler: handler.length, haeftelser: haeftelser.length, ejere: ejere.length };
  } catch (err) { await db.query('ROLLBACK'); return { bfe, status: 'db-error', error: err.message }; }
}

async function main() {
  console.log(`[tl-targeted] ${BFES.length} BFEer at processere (5s delay mellem hver for at undgå 429)`);
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: 3 });
  for (const bfe of BFES) {
    const c = await pool.connect();
    let retries = 0;
    let r;
    try {
      while (retries < 3) {
        r = await processBfe(bfe, c);
        if (r.status !== 'no-uuid' || retries === 2) break;
        // Retry no-uuid (may have been 429-throttled)
        retries++;
        console.log(' BFE', bfe, '→ retry', retries, 'after 10s');
        await new Promise(res => setTimeout(res, 10000));
      }
      console.log(' BFE', bfe, '→', r.status, r.handler != null ? `handler=${r.handler}, haeftelser=${r.haeftelser}, ejere=${r.ejere}` : r.error || '');
    } finally { c.release(); }
    // Sleep between BFEer to be polite
    await new Promise(res => setTimeout(res, 5000));
  }
  await pool.end();
}
main().catch(err => { console.error(err); process.exit(1); });
