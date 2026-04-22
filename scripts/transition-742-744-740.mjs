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

const bodyFor = (ticket) => {
  if (ticket === 'BIZZ-742') {
    return doc(
      h(2, 'Shipped — tab-baseret domain admin nav'),
      p(txt('Ny shared component '), code('app/domain/[id]/admin/DomainAdminTabs.tsx'), txt(' tilføjet i '), code('layout.tsx'), txt(' — wrapper alle admin subpages.')),
      p(strong('Tabs: '), txt('Oversigt | Brugere | Skabeloner | Dokumenter | Historik | Indstillinger')),
      ul(
        li(p(txt('usePathname-based active-tab detection med longest-suffix match (så '), code('/admin/templates/[templateId]'), txt(' stadig highlighter Templates-tab)'))),
        li(p(txt('Layout loader domain-navn og viser det i header med shield-icon'))),
        li(p(txt('Back-arrow ved siden af domain-navnet går til '), code('/domain/[id]'))),
        li(p(txt('Ingen breaking changes — hver eksisterende '), code('/admin/*'), txt('-rute keeper sin egen page.tsx'))),
      ),
      p(strong('Løser samtidig: '), code('BIZZ-744'), txt(' (tilbage-navigation) og '), code('BIZZ-740'), txt(' (indstillinger-knap)')),
      p(strong('Commit: '), code('73f54d1'), txt('. → In Review.'))
    );
  }
  if (ticket === 'BIZZ-744') {
    return doc(
      h(2, 'Shipped — back-arrow i shared tab-bar'),
      p(txt('Løst som del af '), code('BIZZ-742'), txt(' (tab-baseret nav-refactor). Ny '), code('DomainAdminTabs'), txt(' komponent har en tilbage-pil til '), code('/domain/[id]'), txt(' i headeren.')),
      p(strong('Commit: '), code('73f54d1'), txt('. → In Review.'))
    );
  }
  if (ticket === 'BIZZ-740') {
    return doc(
      h(2, 'Shipped — Indstillinger er nu en tab'),
      p(txt('Tidligere var "Indstillinger" en knap øverst til højre + en quick-link i dashboard-panelet. Brugerne opfattede den som "virker ikke" — selvom den faktisk navigerede til '), code('/admin/settings'), txt(', var der ingen tydelig visuel feedback.')),
      p(txt('Som del af '), code('BIZZ-742'), txt(' er Indstillinger nu en førstklasses tab ved siden af Oversigt/Brugere/Skabeloner/etc. — navigation er nu tydelig og konsistent med '), code('/dashboard/admin/*'), txt(' pattern.')),
      p(strong('Commit: '), code('73f54d1'), txt('. → In Review.'))
    );
  }
};

for (const key of ['BIZZ-742', 'BIZZ-744', 'BIZZ-740']) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: bodyFor(key) });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
  if (target) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → In Review` : `  ⚠️ ${r.status}`);
  }
}
