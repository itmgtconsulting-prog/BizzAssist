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
  p(strong('Iter 1 shipped — ny route /dashboard/ejendomme/sfe/[bfe]')),
  p(txt('Server component der fetcher MAT + komponenter via eksisterende /api/matrikel + /api/ejerlejligheder (includeUdfasede=true, moderBfe). Grupperer komponenter efter bygnings-prefix (62A/62B/62C parses fra første komma-del af adressen).')),
  p(strong('UI:'), txt(' Header med BFE + jordstykke-label + info-chips (komponent-antal, bygning-antal, Opdelt-i-ejerlejligheder flag fra MAT, landbrugs-notering). Bygning-sektioner med enheder under hver + links til /dashboard/ejendomme/[dawaId] for videre drill-down.')),
  p(strong('Iter 2 parkeret (BIZZ-795b):'), txt(' kort med farve-kodede markører, ejerforening fra EJF, ejerandele pr. lejlighed, E2E-test for drill-down-flow.')),
  p(strong('Commit: '), code('dde8c47'), txt('. Tests 1685/1699 grønne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-795/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-795/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-795/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-795 → In Review' : `⚠️ ${r.status}`);
}
