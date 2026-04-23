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
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const body = { type: 'doc', version: 1, content: [
  p(strong('Iter 1 shipped — short_description paa sagskort + editable')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('Migration 072'), txt(' — short_description TEXT nullable + 200-tegn check constraint paa domain_case'))),
    li(p(strong('API:'), txt(' GET/POST/PATCH /api/domain/[id]/cases + /cases/[caseId] laeser og skriver short_description (trim + max 200 tegn + null clears)'))),
    li(p(strong('DomainCaseList kort:'), txt(' 2-linjers preview med line-clamp-2 + tooltip paa hover (fuld tekst). Null/empty skjult.'))),
    li(p(strong('CreateCaseModal:'), txt(' textarea-felt med char-counter (0/200) mellem klient-ref og iter-2-note'))),
    li(p(strong('DomainWorkspaceSplitView edit-form:'), txt(' samme textarea med counter over Noter-feltet, matches modal-design'))),
  ),
  p(strong('Iter 2 parkeret (BIZZ-809b — kraever separat scope):')),
  ul(
    li(p(strong('Split-view rotation:'), txt(' top-bottom → left-right layout. Genbruge ResizableDivider fra BIZZ-786 (min 320px, max 600px). Kraever refactor af DomainWorkspaceSplitView — ikke i denne iter.'))),
    li(p(strong('Entity-tags paa sagskort:'), txt(' personer=lilla, virksomheder=blaa, ejendomme=emerald via entityStyles.ts fra BIZZ-806. Kraever multi-entity schema fra BIZZ-808b (ikke landet).'))),
    li(p(strong('CaseDetailPanel.tsx:'), txt(' separate komponent refactor fra DomainWorkspaceSplitView for clearer separation of concerns'))),
    li(p(strong('Mobile responsive:'), txt(' <768px stack kolonner, hide resizable-divider'))),
  ),
  p(strong('Acceptkriterier opfyldt:')),
  ul(
    li(p(txt('✅ Sagskort viser kort beskrivelse som 2-linje preview'))),
    li(p(txt('✅ Ny short_description kolonne i cases-tabel med constraint'))),
    li(p(txt('✅ Editable i detail-formen + CreateCaseModal'))),
    li(p(txt('⏳ Entity-tags: BLOCKED paa BIZZ-808b multi-entity schema'))),
    li(p(txt('⏳ Split-view rotation: parkeret til BIZZ-809b'))),
  ),
  p(strong('Commit: '), code('6f537b8'), txt('. Tests 1733/1747 fortsat gronne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-809/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-809/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-809/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-809 → In Review' : `⚠️ ${r.status}`);
}
