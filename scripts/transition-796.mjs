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
  p(strong('Iter 1 shipped — bygning som selvstændig entitet')),
  p(txt('Ny route /dashboard/ejendomme/bygning/[bygningId] hvor bygningId er BBR_Bygning.id_lokalId (UUID). Brugere kan share/bookmarke en specifik bygning som egen entitet.')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('app/lib/fetchBygning.ts'), txt(' — fetchBygningById(id): BBR GraphQL query på id_lokalId. Returnerer BygningDetail (anvendelse, areal, opførelsesår, ombygningsår, bolig/erhvervs-areal, etager, status, husnummer-UUID).'))),
    li(p(code('fetchBbrData.ts'), txt(' — fetchBBRGraphQL eksporteres nu (var private).'))),
    li(p(code('page.tsx'), txt(' server component — header med anvendelse + status-chip (emerald aktiv, red nedrevet) + key-facts grid + link til husnummer-adresse.'))),
  ),
  p(strong('Iter 2 (BIZZ-796b, parkeret):'), txt(' enheder-liste (BBR_Enhed where bygning=id), SFE-lookup for breadcrumb, offentlig SEO-rute /ejendom/bygning/[slug]/[id], kort med bygnings-polygon fra BBR WFS.')),
  p(strong('Commit: '), code('f233aca'), txt('. Tests 1685/1699 grønne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-796/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-796/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-796/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-796 → In Review' : `⚠️ ${r.status}`);
}
