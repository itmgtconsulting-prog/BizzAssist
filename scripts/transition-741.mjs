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
  h(2, 'Analyse leveret — docs/design/admin-layout-alignment.md'),
  p(txt('10 admin-tabs inventoriseret. Brugere + Fakturering bekræftet som reference-design.')),
  h(3, 'Effort-fordeling'),
  cb(
`S (aligned):              Users, Billing
M (add kpi + filter):     Analytics, Service-Management,
                          Cron-Status, Domains
L (structural refactor):  Plans, AI-Media-Agents, Security,
                          Service-Manager`,
    'text'
  ),
  h(3, 'Per-tab gaps (top 3 pr. tab i docen)'),
  ul(
    li(p(code('Plans'), txt(' — no cards, no search, no table. Extract inline-form til table + drawer-edit.'))),
    li(p(code('Analytics'), txt(' — no filter pills; no table; date hardcoded.'))),
    li(p(code('AI-Media-Agents'), txt(' / '), code('Security'), txt(' — settings forms uden stats. Wrap i stat-cards + add KPI row.'))),
    li(p(code('Service-Manager'), txt(' — custom collapsible sections uden KPI row.'))),
    li(p(code('Service-Management'), txt(' / '), code('Cron-Status'), txt(' / '), code('Domains'), txt(' — mangler KPI card-row + search.'))),
  ),
  h(3, 'Anbefaling for BIZZ-739 implementation'),
  ul(
    li(p(txt('Roll de 4 M-effort tabs ind i BIZZ-739 parent — samme pattern (add KPI row + search), én PR.'))),
    li(p(txt('Split L-effort '), code('Plans'), txt(' og '), code('Service-Manager'), txt(' til egne child-tickets — strukturel refactor.'))),
    li(p(txt('Security + AI-Media-Agents kan leveres samlet som "settings-card-wrapping" PR.'))),
  ),
  p(strong('Shared building blocks allerede tilgængelige:'), txt(' '), code('AdminNavTabs'), txt(' + card/table class-patterns. Ingen ny shared komponent nødvendig før 3+ tabs konvergerer.')),
  p(strong('Commit: '), code('23796bc'), txt('. '), strong('→ In Review.'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-741/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-741 comment' : `❌ ${cr.status}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-741/transitions`);
const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-741/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? '  ✅ BIZZ-741 → In Review' : `  ⚠️ ${r.status}`);
}
