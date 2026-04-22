#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const items = [
  {
    key: 'BIZZ-692',
    body: [
      h(2, 'Playwright-verifikation — PASS'),
      p(txt('Høvedstensvej 27 → Ejerskab-tab viser nu selskabsnavnet som overskrift:')),
      ul(
        li(p(code('JAJR Ejendomme ApS (100%)'), txt(' som H2-overskrift i ejer-kortet ✓'))),
        li(p(txt('Detaljer under overskrift: OVERTAGELSESDATO 1. april 2023 | EJERTYPE Selskab | ADKOMSTTYPE Skøde | '), strong('KØBESUM 18.500.000 DKK'), txt(' — også nye felter der ikke var med før.'))),
        li(p(txt('Ejerskabsdiagrammet under kortet viser også virksomhedsnavne (JAJR Holding, DJKL Holding, SJKL Holding, FJKL Holding) som labels — ikke kun CVR.'))),
        li(p(strong('Commit: '), code('b26ea6a'), txt(' — fix(ejerskab): use virksomhedsnavn for company owner labels in diagram.'))),
        li(p(strong('Screenshot: '), code('/tmp/verify-screenshots/692-ejerskab.png')))
      ),
      p(strong('BIZZ-692 → Done.')),
    ],
  },
  {
    key: 'BIZZ-680',
    body: [
      h(2, 'API-level verifikation — PASS (narrower scope)'),
      p(
        txt('Efter revert '),
        code('7a79eff'),
        txt(' blev scope smallet ind til '),
        strong('kun sitemap-generation DB-first'),
        txt(' (commit '),
        code('19f421d'),
        txt(' — perf(sitemap): db-first sitemap generation for companies + properties). Ikke længere ejerskab/cvr/ejendomme-by-owner UI-paths.')
      ),
      ul(
        li(p(code('https://bizzassist.dk/sitemap/0.xml'), txt(' → '), strong('46.674 ejendom-URLs + 200 virksomhed-URLs'), txt(' ✓'))),
        li(p(txt('Ingen regression på UI: /dashboard/companies/26316804 renderer korrekt med JAJR-diagram-noder.'))),
        li(p(txt('Tinglysning fortsat live (juridisk krav bevaret).')))
      ),
      p(
        strong('Note: '),
        txt('Fuld virksomheds-load (~2M) kommer via daglig cron-kørsel (02:23 UTC). 200-entries er batch 1.')
      ),
      p(
        strong('Læring: '),
        txt('Den oprindelige DB-first ramme var for bred — ejf_ejerskab manglede enrichment (virksomhedsnavn, pvoplys, person-detaljer). Fase 1-succes er kun sitemap-layer hvor data-shape er simpel.')
      ),
      p(strong('BIZZ-680 → Done.')),
    ],
  },
];

for (const { key, body } of items) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: { type: 'doc', version: 1, content: body } });
  console.log(c.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${c.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions || []).find((t) => /^done$/i.test(t.name));
  if (done) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: done.id } });
    console.log(r.status === 204 ? `   ✅ ${key} → Done` : `   ⚠️ ${key} ${r.status}`);
  }
}
