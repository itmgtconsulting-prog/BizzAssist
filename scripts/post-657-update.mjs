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

const body = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Code-level verifikation — progress-checkpoint #2 (stadig inconclusive)'),
    p(strong('Master-fil nu på 2.168 linjer — 168 over acceptance-grænsen.')),
    h(3, 'Aktuel tilstand (develop)'),
    ul(
      li(p(code('EjendomDetaljeClient.tsx'), txt(': 2.168 linjer (fra 7.845 — '), strong('−72%'), txt(')'))),
      li(p(code('tabs/EjendomBBRTab.tsx'), txt(': 992'))),
      li(p(code('tabs/EjendomDokumenterTab.tsx'), txt(': 936'))),
      li(p(code('tabs/EjendomOverblikTab.tsx'), txt(': 731 (ny siden checkpoint #1)'))),
      li(p(code('tabs/EjendomOekonomiTab.tsx'), txt(': 581'))),
      li(p(code('tabs/EjendomSkatTab.tsx'), txt(': 387'))),
      li(p(code('tabs/EjendomEjerforholdTab.tsx'), txt(': 196')))
    ),
    h(3, 'Tilbage'),
    p(
      txt('For at nå ≤ 2.000: træk én af (Tinglysning, Kort, Kronologi) ud som tab-komponent, eller bare split '),
      code('EjendomDetaljeClient'),
      txt(' ved at flytte route-state + tab-routing til separat '),
      code('useEjendomDetail()'),
      txt('-hook (~300-400 linjer mindre).')
    ),
    p(strong('Forbliver In Review — acceptance mangler ~168 linjer.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-657/comment', { body });
console.log(c.status === 201 ? '✅ comment' : `❌ ${c.status} ${c.body}`);
