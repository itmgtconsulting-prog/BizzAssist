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
  p(strong('Shipped — kunde-søgning farve/ikon alignment')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('app/lib/entityStyles.ts'), txt(' — central farve + ikon mapping. Eksporterer getEntityStyle (Icon + textColor + chip + iconBg + bilingual badges), getEntityBadge, mapLegacyType. Ejendom=emerald+Home, Virksomhed=blue+Briefcase, Person=purple+User — matcher universel søgning 1:1.'))),
    li(p(code('CustomerSearchPicker'), txt(' refactored: selected-view + dropdown-liste bruger nu central style. Badge-chips farvekodes også (tidligere neutral slate-600). Fjerner hardkodede Building2/User imports.'))),
  ),
  p(strong('Verificerede ændringer:')),
  ul(
    li(p(txt('Virksomhed: emerald+Building2 → blue+Briefcase'))),
    li(p(txt('Person: sky+User → purple+User'))),
    li(p(txt('Badge-chip (CVR/Person) farvekodet per type'))),
    li(p(txt('Selected-view border farver også type-specifikke'))),
  ),
  p(strong('Test-dækning:'), txt(' 9 unit tests i entityStyles.test.ts dækker unique farver, bilingual labels, legacy-type-mapping, chip-struktur. Alle eksisterende 1724 tests fortsat grønne (1733/1747 total).')),
  p(strong('Ingen breaking changes:'), txt(' CustomerLink-kontrakt uændret, kun visuel styling. Reusable EntityResultItem komponent (foreslået i ticket) er parkeret til iter 2 — entityStyles.ts helper er tilstrækkelig til current consumer.')),
  p(strong('Commit: '), code('3df6bf5'), txt('. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-806/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-806/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-806/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-806 → In Review' : `⚠️ ${r.status}`);
}
