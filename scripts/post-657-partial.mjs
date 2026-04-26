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
      txt('Solid progress, men acceptance-kriteriet (ingen .tsx-fil > 2.000 linjer) er IKKE opfyldt endnu. Ticket forbliver i In Review indtil resterende tabs er ekstraheret.')
    ),
    h(3, 'Aktuelle linje-tal (live på develop)'),
    ul(
      li(p(code('EjendomDetaljeClient.tsx'), txt(': 5.281 linjer (startede på 7.845, -32.7%)'))),
      li(p(code('tabs/EjendomBBRTab.tsx'), txt(': 1.055'))),
      li(p(code('tabs/EjendomDokumenterTab.tsx'), txt(': 936'))),
      li(p(code('tabs/EjendomOekonomiTab.tsx'), txt(': 581'))),
      li(p(code('tabs/EjendomSkatTab.tsx'), txt(': 387'))),
      li(p(code('tabs/EjendomEjerforholdTab.tsx'), txt(': 196')))
    ),
    h(3, 'Manglende ekstraheringer (for at nå ≤2.000)'),
    ul(
      li(p(code('EjendomOverblikTab.tsx'), txt(' — mangler'))),
      li(p(code('EjendomTinglysningTab.tsx'), txt(' — mangler'))),
      li(p(code('EjendomKortTab.tsx'), txt(' — mangler'))),
      li(p(code('EjendomKronologiTab.tsx'), txt(' — mangler')))
    ),
    p(
      strong('Estimat: '),
      txt('master-fil reduceres med ~3.500-4.000 linjer hvis de 4 resterende tabs ekstraheres — lander så på ~1.300-1.800 linjer.')
    ),
    h(3, 'Note'),
    p(
      strong('Blokker BIZZ-658 (601b): '),
      txt('indtil pattern er fuldt etableret i 601a er det sikrere at afvente. Virksomheds-kloning af pattern giver mest værdi når alle 9 tabs er forme-givet her.')
    ),
    p(strong('Forbliver In Review.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-657/comment', { body });
console.log(c.status === 201 ? '✅ comment posted — BIZZ-657 blijver In Review' : `❌ ${c.status} ${c.body}`);
