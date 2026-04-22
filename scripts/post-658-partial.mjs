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
    h(2, 'Code-level verifikation — inconclusive (progress-checkpoint)'),
    p(
      strong('Status: '),
      txt('Solid progress, men master-fil stadig 4.775 linjer — acceptance-kriterium (≤ 2.000) IKKE opfyldt. Ticket forbliver In Review.')
    ),
    h(3, 'Aktuel tilstand (develop)'),
    ul(
      li(p(code('VirksomhedDetaljeClient.tsx'), txt(': 4.775 linjer (fra 7.852 — '), strong('−39%'), txt(')'))),
      li(p(code('tabs/VirksomhedOverblikTab.tsx'), txt(': 719'))),
      li(p(code('tabs/VirksomhedEjendommeTab.tsx'), txt(': 643'))),
      li(p(code('tabs/VirksomhedGruppeTab.tsx'), txt(': 587'))),
      li(p(code('tabs/VirksomhedNoeglepersonerTab.tsx'), txt(': 309'))),
      li(p(code('tabs/VirksomhedRegnskabTab.tsx'), txt(': 268'))),
      li(p(code('tabs/VirksomhedHistorikTab.tsx'), txt(': 181')))
    ),
    h(3, 'Tilbage — 2.775 linjer for meget'),
    ul(
      li(
        p(
          strong('Tinglysning-tab (stadig inline): '),
          txt('Jakob noterer afhængighed til '),
          code('PersonbogSection'),
          txt('. Udtræk kræver enten (a) flytning af PersonbogSection til shared-components, eller (b) keep inline og kompensér ved at splitte andre dele.')
        )
      ),
      li(
        p(
          strong('AIArticleSearchPanel: '),
          txt('~400-600 linjer i master-filen — ekstrahér til '),
          code('app/components/ai/AIArticleSearchPanel.tsx'),
          txt(' så BIZZ-659 (person) kan genbruge den.')
        )
      ),
      li(
        p(
          strong('Route-state + fetch-logik: '),
          txt('flyt til '),
          code('useVirksomhedDetail()'),
          txt('-hook (~500-800 linjer besparelse).')
        )
      )
    ),
    p(strong('Forbliver In Review — 2.775 linjer fra mål.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-658/comment', { body });
console.log(c.status === 201 ? '✅ 658 comment' : `❌ ${c.status}`);
