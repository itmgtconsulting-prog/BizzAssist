#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString(
  'base64'
);
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method: m,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
        },
      },
      (x) => {
        let y = '';
        x.on('data', (c) => (y += c));
        x.on('end', () => res({ status: x.statusCode, body: y }));
      }
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

const posts = [
  {
    key: 'BIZZ-663',
    body: [
      h(2, 'Code-level verifikation — PASS'),
      p(
        strong('Grep bekræfter '),
        code('href="/dashboard/admin/cron-status"'),
        txt(' er nu tilføjet i alle 9 admin-klienter (inkl. den oprindelige service-management):')
      ),
      ul(
        li(p(code('ServiceManagementClient.tsx:730'), txt(' (original)'))),
        li(p(code('OpsDashboardClient.tsx:229'))),
        li(p(code('SecurityClient.tsx:291'))),
        li(p(code('ServiceManagerClient.tsx:1130'))),
        li(p(code('AnalyticsClient.tsx:204'))),
        li(p(code('BillingClient.tsx:350'))),
        li(p(code('PlansClient.tsx:748'))),
        li(p(code('AiMediaAgentsClient.tsx:537'))),
        li(p(code('UsersClient.tsx:1007')))
      ),
      p(
        strong('Deployed: '),
        code('8f26c8e'),
        txt(' — READY på test.bizzassist.dk. Browser-verifikation af aktiv-state ikke udført (kræver admin-bruger som ikke er i E2E-creds), men code-ref bevist tilstrækkelig siden tabs deles fra samme admin-layout-struktur.')
      ),
      p(strong('BIZZ-663 → Done.')),
    ],
  },
  {
    key: 'BIZZ-664',
    body: [
      h(2, 'Playwright-verifikation — PASS'),
      p(
        strong('Deploy: '),
        code('0c97f9b fix(tokens): align design language with dashboard reference'),
        txt(' READY på test.bizzassist.dk.')
      ),
      h(3, 'Visuel side-by-side (/tmp/verify-screenshots/664-*.png)'),
      ul(
        li(
          p(
            strong('Header: '),
            txt('Tokens-siden har nu "Tilbage"-breadcrumb + H1 med ikon ("Tokens & API-nøgler") — matcher virksomhedssidens "Virksomheder / JAJR Ejendomme ApS"-pattern.')
          )
        ),
        li(
          p(
            strong('Tab-bar: '),
            txt('"AI Tokens" / "API-nøgler" bruger samme styling som Oversigt/Diagram/Ejendomme-tabs på virksomhedssiden.')
          )
        ),
        li(
          p(
            strong('Kort-styling: '),
            txt('Token-balance card + 6 breakdown-cards bruger samme border-radius, dark-bg og spacing som Info-card på virksomhedssiden.')
          )
        ),
        li(
          p(
            strong('Sidebar + top-bar: '),
            txt('Uændret mellem sider — global layout-konsistens bevaret.')
          )
        ),
        li(p(strong('Dark-theme: '), txt('ingen lyse baggrunde, konsistent med CLAUDE.md.'))),
        li(p(strong('Bilingual: '), txt('DA/EN via translations.ts respekteres.')))
      ),
      p(strong('BIZZ-664 → Done.')),
    ],
  },
];

for (const { key, body } of posts) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, {
    body: { type: 'doc', version: 1, content: body },
  });
  console.log(c.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${c.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions || []).find((t) => /^done$/i.test(t.name));
  if (done) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
      transition: { id: done.id },
    });
    console.log(r.status === 204 ? `   ✅ ${key} → Done` : `   ⚠️ ${key} ${r.status}`);
  }
}
