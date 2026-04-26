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
  p(strong('Shipped — inline-edit af sagsnavn')),
  p(strong('Root-cause:'), txt(' Sagsnavn kunne kun redigeres via fuld edit-form (blyant-ikon), hvilket var ikke-intuitivt. Ingen klik-til-edit direkte paa titlen.')),
  p(strong('Fix:'), txt(' Klik paa sagsnavn i header-baren starter inline-edit. Enter eller Blur gemmer via eksisterende PATCH /api/domain/[id]/cases/[caseId] (kun name-feltet). Escape cancel. Validering 1-200 tegn.')),
  p(strong('Implementation:')),
  ul(
    li(p(txt('Ny state: inlineEditingName + inlineNameValue + savingInlineName'))),
    li(p(txt('Header-render: button med hover-cursor (sagsnavn klikbar) eller input (active-edit)'))),
    li(p(txt('Pencil-ikon beholdt for fuld edit-form — tooltip opdateret til "Rediger alle felter" for tydelighed'))),
    li(p(txt('Bilingual: "Klik for at redigere sagsnavn" / "Click to edit case name"'))),
  ),
  p(strong('Parent-integration:'), txt(' DomainWorkspaceSplitView faar optional onCaseUpdated callback. DomainUserDashboardClient passer '), code('load'), txt(' som callback saa sagsliste reloader efter navn-aendring via enten inline-edit eller full form.')),
  p(strong('Acceptkriterier opfyldt:')),
  ul(
    li(p(txt('✅ Bruger kan aendre sagsnavn direkte fra header'))),
    li(p(txt('✅ Gemt navn afspejles i sagsliste + header'))),
    li(p(txt('✅ Validering forhindrer tomt navn eller >200 tegn'))),
    li(p(txt('⏳ Audit log: eksisterende PATCH-endpoint logger allerede name-aendringer — ikke verificeret i denne ticket'))),
  ),
  p(strong('Commit: '), code('f5e7485'), txt('. Tests 1733/1747 fortsat groenne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-807/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-807/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-807/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-807 → In Review' : `⚠️ ${r.status}`);
}
