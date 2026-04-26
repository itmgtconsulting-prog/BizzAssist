#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';
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

const desc = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Formål'),
    p(txt('Domain Admin UI til at tilføje instruktioner + eksempler + placeholder-beskrivelser efter upload. Disse bruges af AI-pipelinen (Fase 5).')),
    h(2, 'UI'),
    p(code('/domain/[id]/admin/templates'), txt(' — liste.')),
    p(code('/domain/[id]/admin/templates/[tpl_id]'), txt(' — editor med 5 tabs:')),
    ul(
      li(p(strong('Tab "Fil" '), txt('— preview af docx (mammoth → HTML render).'))),
      li(p(strong('Tab "Instruktioner" '), txt('— rich-text editor: hvordan AI skal udfylde skabelonen. Denne tekst går direkte ind i Claude-prompten ved generering.'))),
      li(p(strong('Tab "Eksempler" '), txt('— upload 0-5 udfyldte eksempler (brugt som few-shot prompting). UI viser liste + preview pr. eksempel.'))),
      li(p(strong('Tab "Placeholders" '), txt('— list, pr. placeholder: navn, beskrivelse, data-kilde-hint (fx "brug CVR-lookup for virksomhedsnavn", "tag fra case-dokument titleret \'salgsaftale\'").'))),
      li(p(strong('Tab "Versioner" '), txt('— history + rollback til tidligere version (se T-710).'))),
    ),
    h(2, 'API'),
    p(code('PATCH /api/domain/[id]/templates/:tpl_id'), txt(' — opdater instructions / examples / placeholders (atomic transaction + ny version hvis ændring er material).')),
    p(code('POST  /api/domain/[id]/templates/:tpl_id/examples'), txt(' — upload eksempel-fil.')),
    p(code('DELETE /api/domain/[id]/templates/:tpl_id/examples/:ex_id'), txt(' — slet eksempel.')),
    h(2, 'Acceptance'),
    ul(
      li(p(txt('Docx preview renders korrekt for 5 eksempel-templates.'))),
      li(p(txt('Auto-save per 3s mens admin editer (no data-loss ved tab-luk).'))),
      li(p(txt('Placeholder-detektion kan køres igen hvis templaten re-uploades (bevarer beskrivelser hvor placeholder-navn matcher).'))),
      li(p(txt('E2E: login som Domain Admin, åbn template, tilføj instruktion + 1 eksempel + 3 placeholder-beskrivelser, gem, refresh — alt persisteret.'))),
    ),
    h(2, 'Relaterede'),
    p(strong('Parent epic: '), code('BIZZ-696')),
    p(strong('Forudsætning: '), code('BIZZ-707'), txt(' (upload-API) + '), code('BIZZ-706'), txt(' (Fase 2 complete).')),
  ],
};

const res = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    issuetype: { name: 'Task' },
    priority: { name: 'High' },
    summary: 'Domain: template editor UI — metadata, instruktioner, eksempler, placeholder-review',
    labels: ['domain', 'templates', 'ui', 'phase-3'],
    description: desc,
    parent: { key: 'BIZZ-696' },
  },
});
if (res.status !== 201) {
  console.error('fail:', res.status, res.body.slice(0, 500));
  process.exit(1);
}
const key = JSON.parse(res.body).key;
console.log(`✅ Created ${key} (template editor UI)`);

// Update blocks chain: BIZZ-707 blocks this, this blocks BIZZ-709 ... but chain already exists.
// Instead: insert this into Phase 3 chain: link Blocks so BIZZ-707 blocks this, and this blocks BIZZ-709?
// Existing chain is Phase-level (last of phase 3 blocks first of phase 4) — so just tying new ticket into Phase 3 is enough.
// Optional: add "relates to BIZZ-707" so upload ticket points at editor.
const lr = await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key: 'BIZZ-707' },
  outwardIssue: { key },
});
console.log(lr.status === 201 ? `  🔗 relates BIZZ-707 ↔ ${key}` : `  ⚠️ link ${lr.status}`);
