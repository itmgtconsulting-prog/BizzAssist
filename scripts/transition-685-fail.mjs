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
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
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
    h(2, 'API-level verifikation — FAIL (systemisk)'),
    p(
      strong('Kørt mod '),
      code('/api/salgshistorik?bfeNummer='),
      txt(' på 5 forskellige ejendomme — '),
      strong('alle rækker har køber: null'),
      txt(' uanset BFE. Ikke én enkelt-ejendom-bug, det er systemisk.')
    ),
    h(3, 'Resultat'),
    ul(
      li(p(code('BFE 2091166 Høvedstensvej 27'), txt(' — 4 rækker · '), strong('0 har køber'))),
      li(p(code('BFE 425479 Kaffevej 31, 1.tv'), txt(' — 4 rækker · '), strong('0 har køber'))),
      li(p(code('BFE 2024847 Hovager 8'), txt(' — 7 rækker · '), strong('0 har køber'))),
      li(p(code('BFE 100065801 Kildegårdsvej 18D'), txt(' — 5 rækker · '), strong('0 har køber'))),
      li(p(code('BFE 2091185 Arnold Nielsens Blvd 64B'), txt(' — 4 rækker · '), strong('0 har køber')))
    ),
    p(
      txt('Response-struktur per handler-row: kun '),
      code('{ dato, type, andel }'),
      txt(' er populeret. Alle andre felter ('),
      code('koeber'),
      txt(', '),
      code('koebesum'),
      txt(', '),
      code('kontant'),
      txt(', '),
      code('loesore'),
      txt(', '),
      code('entreprise'),
      txt(', '),
      code('tinglystDato'),
      txt(') er '),
      code('null'),
      txt('.')
    ),
    h(3, 'Data er tilgængelig i anden kilde'),
    p(
      strong('Tinglysning summarisk har nødvendige data: '),
      code('GET /api/tinglysning/summarisk?uuid=<tluuid>&hovedBfe=2091166'),
      txt(' for Høvedstensvej 27 returnerer korrekt:')
    ),
    p(code('{ adkomstType: "skoede", koebesum: 18500000, kontantKoebesum: 18500000, ejer: { navn: "JAJR Ejendomme ApS", cvr: "26316804" } }')),
    p(
      txt('Men kun for '),
      strong('nuværende'),
      txt(' ejer. De 3+ historiske rækker kommer udelukkende fra '),
      code('EJF_Ejerskifte'),
      txt('-kaldet i '),
      code('app/api/salgshistorik/route.ts'),
      txt('.')
    ),
    h(3, 'Sandsynlig rodårsag'),
    ul(
      li(
        p(
          code('app/api/salgshistorik/route.ts'),
          txt(' kommentar-header beskriver 2-trins flow: '),
          code('EJF_Ejerskifte'),
          txt(' → '),
          code('handelsoplysningerLokalId'),
          txt(' → '),
          code('EJF_Handelsoplysninger'),
          txt('. Trin 2 ser enten ud til at fejle stille, returnere tom response, eller mappes ikke ind i response-shape klient modtager.')
        )
      ),
      li(p(txt('Custom query-navn "EJF_Handelsoplysninger" kan være forkert — kommentar nævner at det "testes efter deploy".')))
    ),
    h(3, 'Acceptance — hvad der mangler'),
    ul(
      li(p(txt('Alle 4 rækker på Høvedstensvej 27 skal have køber + købesum (minimum for de 3 første der er efter digital Tinglysning).'))),
      li(p(txt('Verificér også Hovager 8 (7 rækker), Kildegårdsvej 18D (5 rækker) — samme bug.'))),
      li(p(txt('For rækker hvor EJF reelt mangler data: vis "Ikke oplyst" (ikke tom celle) med tooltip.')))
    ),
    h(3, 'Relateret'),
    ul(
      li(p(code('BIZZ-693'), txt(' — nyere reproduktion på Kaffevej 31, 1.tv (samme bug-familie).'))),
      li(p(code('BIZZ-633'), txt(' (Done?) — tidligere salgshistorik-cache. LRU-cache gemmer den tomme response — efter fix skal cache invalideres.')))
    ),
    p(strong('BIZZ-685 → To Do (genåbnes efter FAIL-verifikation).')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-685/comment', { body });
console.log(c.status === 201 ? '✅ comment' : `❌ ${c.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-685/transitions');
const todo = (JSON.parse(tr.body).transitions || []).find((t) => t.name.toLowerCase() === 'to do');
if (todo) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-685/transitions', { transition: { id: todo.id } });
  console.log(r.status === 204 ? '✅ BIZZ-685 → To Do' : `⚠️ ${r.status}`);
}
