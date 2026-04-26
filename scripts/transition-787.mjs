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
  p(strong('Root cause fundet + fix shipped')),
  p(strong('Root cause:'), txt(' Banneret blev trigret på '), code('dawaAdresse.zone === "Udfaset"'), txt('. Feltet kommer fra Plandata WFS '), code('pdk:theme_pdk_zonekort_vedtaget_v'), txt(' — en '), strong('zone-polygon'), txt(' i kortet der er blevet afløst af en nyere version. Det er en ren kartografisk historik-operation i Plandata, '), strong('uden relation til ejendommens fysiske tilstand'), txt('. BBR-status er ikke involveret i den gamle logik.')),
  p(strong('Hvorfor hele Arnold Nielsens Boulevard 62 ramtes:'), txt(' adressens koordinater ligger inde i en Plandata-zone-polygon der er blevet superseded (ny polygon har afløst den gamle). Alle 6 enheder på samme adresse slår op i samme polygon → alle 6 får '), code('zone = "Udfaset"'), txt(' → alle 6 får banner. Hypotesen om BBR zone-registrering var forkert — det er Plandata zone-kortet der er skyld.')),
  p(strong('Fix:')),
  ul(
    li(p(txt('Banner-trigger skiftet fra '), code('zone === "Udfaset"'), txt(' til '), code('bbrData.bbr.every(b => b.status ∈ {Nedrevet/slettet, Bygning nedrevet, Bygning bortfaldet})'), txt('. Mindst én aktiv bygning → intet banner.'))),
    li(p(txt('Tekst opdateret: "Alle bygninger på denne ejendom er registreret som nedrevet eller bortfaldet i BBR" (før: "Denne ejendoms zone-registrering er markeret som udfaset").'))),
    li(p(txt('Zone-badge i header (visning af "Udfaset" som zone-kategori chip) '), strong('beholdes'), txt(' — den viser korrekt hvad Plandata siger. Kun banneret er omkoblet.'))),
  ),
  p(strong('Spot-check efter deploy:')),
  ul(
    li(p(txt('Arnold Nielsens Boulevard 62A-62C (BFE 2091165 m.fl.) → intet banner forventet (har aktive bygninger)'))),
    li(p(txt('Genuint nedrevet ejendom (search after "nedrevet" i BBR) → banner vises'))),
    li(p(txt('Ejendom uden BBR-data (ukendt) → intet banner (before-safe-than-false-positive)'))),
  ),
  p(strong('Iter 2 (parkeret, lavere prio):')),
  ul(
    li(p(code('BIZZ-787a'), txt(' — "Efterfølger-BFE" felt i data-modellen: når ejendom er sammenlagt/genopført under nyt BFE, link direkte til nyt BFE i stedet for bare at vise banner.'))),
    li(p(code('BIZZ-787b'), txt(' — MAT-status cross-check: tillæg '), code('matrikelData.status'), txt(' som supplerende signal. Hvis BBR siger "aktiv" men MAT siger "afviklet" — vis advarsel, ikke banner.'))),
  ),
  p(strong('Commit: '), code('d7d055a'), txt('. Tests 1640/1654 grønne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-787/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status} ${cr.body}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-787/transitions');
const t = (JSON.parse(tr.body).transitions || []).find(x => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-787/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ → In Review' : `⚠️ ${r.status}`);
}
