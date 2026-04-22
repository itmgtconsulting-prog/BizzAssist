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
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

const body = doc(
  h(2, 'Shipped — junction-tabel + API + tab-label rename'),
  p(strong('Note: '), txt('ticket beskrev "ingen template-tabel findes" men '), code('domain_template'), txt(' blev shipped som del af BIZZ-698. Junction-tabellen er det manglende led — '), strong('ikke'), txt(' en ny template-tabel.')),
  h(3, 'Migration 067 — applied live på test + dev + prod'),
  cb(
`CREATE TABLE domain_template_document (
  id, template_id → domain_template,
  document_id → domain_training_doc,
  domain_id → domain,
  guidelines text,
  sort_order int,
  UNIQUE (template_id, document_id)
);

+ before-insert/update trigger guarder at begge parents deler samme
  domain_id (prevents cross-domain attach — samtidig matcher RLS)
+ RLS: member-read, admin-write via domain_member-join
+ updated_at auto-touch trigger`,
    'sql'
  ),
  h(3, 'API: /api/domain/[id]/templates/[templateId]/documents'),
  ul(
    li(p(code('GET'), txt(' — list attachments joined med doc.name + file_type, sorteret på sort_order'))),
    li(p(code('POST'), txt(' — attach doc + optional guidelines + sort_order; 409 ved duplicate'))),
    li(p(code('PATCH'), txt(' — opdatér guidelines eller sort_order'))),
    li(p(code('DELETE ?attachmentId='), txt(' — detach (doc bliver i træningsdokumenter)'))),
  ),
  p(txt('Member kan GET; admin kan POST/PATCH/DELETE. Audit-log entries for attach/detach.')),
  h(3, 'UI'),
  ul(
    li(p(txt('"Træningsdokumenter" → "Dokumenter" i '), code('TrainingDocsClient.tsx'), txt(' header'))),
    li(p(txt('Tab-label i '), code('DomainAdminTabs.tsx'), txt(' er allerede "Dokumenter" (landed som del af BIZZ-742)'))),
  ),
  h(3, 'Iter 2 scope (ikke i denne PR)'),
  ul(
    li(p(txt('Template-detail UI med attach-doc dropdown (select fra '), code('domain_training_doc'), txt(' i samme domain)'))),
    li(p(txt('Inline guidelines-editor per attachment + drag-reorder for sort_order'))),
    li(p(txt('Skabelon-oprettelsesflow med attachment-step'))),
    li(p(txt('Test coverage — unit tests for junction API'))),
  ),
  p(strong('Commit: '), code('f313531'), txt('. Tests 1626/1640 grønne. '), strong('→ In Review.'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-743/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-743 comment' : `❌ ${cr.status}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-743/transitions`);
const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-743/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? '  ✅ BIZZ-743 → In Review' : `  ⚠️ ${r.status}`);
}
