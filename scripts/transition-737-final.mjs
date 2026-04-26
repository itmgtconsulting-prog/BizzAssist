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
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

const body = doc(
  h(2, 'Shipped — shared AdminNavTabs + create/detail routes + auto-membership'),
  p(strong('3 commits:')),
  ul(
    li(p(code('6e4aeea'), txt(' — shared AdminNavTabs komponent, Domains-tab feature-flag gated, 9 admin client-komponenter refactored (~340 linjer duplikeret kode fjernet)'))),
    li(p(code('44e9ee7'), txt(' — manglende /dashboard/admin/domains/new create-form + /[id] redirect til /domain/[id]/admin (var 404)'))),
    li(p(code('d7e216a'), txt(' — POST /api/admin/domains tilføjer nu automatisk super-admin som admin-member (var årsag til 404 på /domain/[id]/admin efter create) + backfill på test+dev+prod'))),
  ),
  p(strong('Verificeret:')),
  ul(
    li(p(txt('Jakob oprettede "BizzAssist Test Domain" på test.bizzassist.dk — create-flow virkede'))),
    li(p(txt('Domain-detail /domain/[id]/admin loader nu efter auto-membership insert'))),
    li(p(txt('Tests 1626/1640 grønne, type-check clean'))),
  ),
  p(strong('→ In Review.'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-737/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-737 comment' : `❌ ${cr.status} ${cr.body}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-737/transitions`);
const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-737/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? `  ✅ BIZZ-737 → In Review` : `  ⚠️ ${r.status}`);
}
