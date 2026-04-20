#!/usr/bin/env node
/**
 * Batch 2 transitions:
 *   Done: BIZZ-630, 603, 628, 631, 624
 *   To Do: BIZZ-596, 621
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const para = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => marks ? { type: 'text', text, marks } : { type: 'text', text };
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });

const done = {
  'BIZZ-630': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation 2026-04-20 — PASSED'),
      para(txt('Code-level check: '), code('app/dashboard/kort/KortPageClient.tsx:1295-1307'), txt(' har nu eksplicit DK-bbox-validering før '), code('flyTo'), txt(':')),
      ul(
        li(para(code('DK_BBOX = { minLng: 7, maxLng: 16, minLat: 54, maxLat: 58 }'))),
        li(para(code('isInDenmark'), txt('-check før '), code('flyTo'), txt(' — udenfor DK viser toast i stedet for at flyve.'))),
      ),
      para(txt('Browser-verifikation: søgning på "Søbyvej 11" viser 5 match (inkl. 2650 Hvidovre) og kortet forbliver i Danmark-view (zoom 6.5). Afrika-regression er elimineret.')),
    ],
  },
  'BIZZ-603': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — PASSED'),
      para(code('app/dashboard/pvoplys/loading.tsx'), txt(' eksisterer (37 linjer) med dark-theme animate-pulse skeleton som matcher øvrige dashboard-ruter. Ingen layout-shift ved navigation.')),
    ],
  },
  'BIZZ-628': {
    type: 'doc', version: 1, content: [
      h(2, 'Playwright-verifikation — PASSED'),
      para(txt('På '), code('/dashboard/owners/4000115446'), txt(' → Ejendomme-tab: 0 forekomster af '), code('"Ejer: [virksomhedsnavn]"'), txt('-linje i ejendoms-kort. Gruppe-overskrift er single source of truth for ejerskab.')),
    ],
  },
  'BIZZ-631': {
    type: 'doc', version: 1, content: [
      h(2, 'Playwright-verifikation — PASSED'),
      para(txt('På person → Ejendomme-tab er filter-knapperne "Alle / Ejendomme / Ejendomshandler" fjernet. Teksten "Ejendomshandler" forekommer 0 gange på siden. Persontab matcher virksomhedsfanens layout.')),
    ],
  },
  'BIZZ-624': {
    type: 'doc', version: 1, content: [
      h(2, 'Code-level verifikation — PASSED'),
      para(code('app/lib/cronMonitor.ts'), txt(' implementerer '), code('withCronMonitor()'), txt(' der wrapper '), code('Sentry.withMonitor'), txt(' + '), code('recordHeartbeat'), txt(' i én fælles helper.')),
      h(3, 'Rollout — alle 12 cron-routes bruger withCronMonitor'),
      ul(
        li(para(code('pull-bbr-events'), txt(', '), code('ingest-ejf-bulk'), txt(', '), code('deep-scan'), txt(', '), code('warm-cache'), txt(', '), code('daily-report'), txt(', '), code('daily-status'), txt(', '), code('service-scan'), txt(', '), code('monitor-email'), txt(', '), code('generate-sitemap'), txt(', '), code('poll-properties'), txt(', '), code('purge-old-data'), txt(', '), code('ai-feedback-triage'))),
      ),
      para(txt('Belt-and-suspenders observability er i produktion. Sentry cron-monitor er aktivt på alle jobs.')),
    ],
  },
};

const todo = {
  'BIZZ-596': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — NOT DONE, sender til To Do'),
      para(txt('Person-Ejendomme-tabben viser stadig '), code('"Kommer snart"'), txt('-placeholder på Jakobs side. Browser-test fandt 0/5 af de kendte personligt ejede adresser (Søbyvej 11, Vigerslevvej 146, H C Møllersvej 21, Horsekildevej 26, Hovager 8).')),
      para(txt('Alignment med virksomhedsfanen er ikke gennemført — blokeret af samme implementation gap som '), strong('BIZZ-595'), txt('.')),
    ],
  },
  'BIZZ-621': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikation — DELVIST, sender til To Do'),
      h(3, 'Del A — heartbeats ✅'),
      para(txt('Wrapper '), code('app/lib/cronMonitor.ts'), txt(' med '), code('withCronMonitor()'), txt(' er implementeret og bruges i alle 12 cron-routes. Wrapper kalder '), code('recordHeartbeat'), txt(' ved start+slut.')),
      h(3, 'Del B — UI-dashboard ❌'),
      ul(
        li(para(txt('Ingen route '), code('/dashboard/admin/cron-status'), txt(' eksisterer.'))),
        li(para(txt('Ingen cron-tab på '), code('/dashboard/admin/service-management'), txt('.'))),
        li(para(txt('Admin kan stadig kun se cron-status ved at kigge direkte i Supabase '), code('cron_heartbeats'), txt('-tabellen.'))),
      ),
      para(txt('Acceptance criteria er ikke opfyldt: "Dashboard viser korrekt status for alle 12; OVERDUE-detektion fungerer; Fejlede runs viser fejlmeddelelsen i UI\'et uden at admin skal i Supabase; Siden auto-refresher hver 30. sek." — alt dette kræver UI-arbejdet.')),
    ],
  },
};

console.log('═══ Tickets → Done ═══');
for (const [key, body] of Object.entries(done)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status !== 201) { console.log(`❌ ${key} comment failed (${c.status})`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const d = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
  if (!d) { console.log(`⚠️ ${key}: no Done transition`); continue; }
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: d.id } });
  console.log(r.status === 204 ? `✅ ${key} → Done` : `⚠️ ${key} failed (${r.status})`);
}

console.log('\n═══ Tickets → To Do ═══');
for (const [key, body] of Object.entries(todo)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status !== 201) { console.log(`❌ ${key} comment failed (${c.status})`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => /^to\s*do$/i.test(x.name));
  if (!t) { console.log(`⚠️ ${key}: no To Do transition`); continue; }
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
  console.log(r.status === 204 ? `🔄 ${key} → To Do` : `⚠️ ${key} failed (${r.status})`);
}
