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

const body = { type: 'doc', version: 1, content: [
  p(strong('Shipped — personligt ejede ejendomme paa egen layer i virksomhedsdiagram')),
  p(strong('Root-cause:'), txt(' '), code('expandPersonDynamic()'), txt(' i DiagramForce.tsx tilfoejede edges direkte fra personId til bfeId. Det gjorde at ejendomme fik samme topological depth som virksomheder (begge var direkte children af personen) og blev placeret paa samme y-raekke.')),
  p(strong('Fix:'), txt(' Efter direkte-ejendomme + bulk-ejendomme er samlet (begge paths i expansion), inserter koden nu en virtuel container-node '), code('personal-props-group-{personId}'), txt(' med type=status, og re-router alle person to property edges til container to property. Container faar egen depth-layer via eksisterende nodeYMap-logik (type=status tæller som ikke-property paa linje 579 i depthMap-BFS).')),
  p(strong('Konsistens:'), txt(' Samme moenster som '), code('buildPersonGraph'), txt(' bruger (BIZZ-594/730) i person-viewet. Nu konsistent paa tvaers af /dashboard/owners/[id] (person-graph) og /dashboard/companies/[cvr] (expanded owner-chain).')),
  p(strong('Bilingual:'), txt(' Container-label bruger eksisterende lang-prop — "Personligt ejede ejendomme" / "Personally owned properties".')),
  p(strong('Test-status:'), txt(' 1733 eksisterende tests fortsat groenne (layout-fix verificeres visuelt — ingen unit test for renderer-positioning). Visuel QA mod test.bizzassist.dk/dashboard/companies/41092807 (JaJR Holding) forventer: Jakob Juul Rasmussen node med personlige ejendomme paa deres egen selvstaendige y-raekke, adskilt fra virksomhedsnoderne.')),
  p(strong('Commit: '), code('8f260ae'), txt('. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-688/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-688/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-688/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-688 → In Review' : `⚠️ ${r.status}`);
}
