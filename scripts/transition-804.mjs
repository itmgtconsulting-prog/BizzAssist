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
  p(strong('Shipped — MVP ejendoms-filter-katalog + tab-aware FilterPanel')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('app/lib/search/ejendomFilterSchema.ts'), txt(' — 3 filtre: Ejendomstype multi-select (SFE/Bygning/Ejerlejlighed), Skjul udfasede toggle default=true, Kommune multi-select (dynamisk options fra live-resultater). Exports: matchEjendomFilter, buildKommuneOptions, narrowEjendomFilters.'))),
    li(p(code('app/lib/search/virksomhedFilterSchema.ts'), txt(' — placeholder med kun kunAktive toggle. Fuld CVR-katalog kommer med BIZZ-789a.'))),
    li(p(code('UniversalSearchPageClient'), txt(' refaktoreret: aside bruger nu FilterPanel<TFilters> i stedet for hardkodet 3-kolonne UI. Tab-aware — activeTab vælger schema. URL-persistent via useFiltersFromURL med allSchemas så tab-skift ikke mister valg.'))),
  ),
  p(strong('Design-alignment (som planlagt):')),
  ul(
    li(p(txt('Dark theme #0a1020 / #0f172a, slate-700/40 borders, blue-500 accent — konsistent med resten af admin-UI'))),
    li(p(txt('ResizableDivider fra BIZZ-786 + fullheight-aside fra BIZZ-786 genbrugt uændret'))),
    li(p(txt('URL-konvention fra BIZZ-792 respektere: ?ejendomstype=bygning,ejerlejlighed · ?skjulUdfasede=false · ?kommune=Hvidovre,København'))),
    li(p(txt('matchCount live aria-live spinner i panel-header; Reset-knap nulstiller kun current tabs keys'))),
    li(p(txt('Eksplicit ejendomstype=sfe i filter overrider default-SFE-skjul-adfærd (BIZZ-794)'))),
  ),
  p(strong('Test-dækning:'), txt(' 14 unit tests dækker schema-struktur, match-logik for alle 3 filtre + kombinationer, kommune-dedup + dansk sortering, narrowEjendomFilters type-safety. Alle eksisterende 1692 tests fortsat grønne (1706/1720 total).')),
  p(strong('Ikke i denne ticket (planlagt iter 2+):')),
  ul(
    li(p(code('788c'), txt(' — areal/opførelsesår/energimærke/anvendelse (kræver BBR-berigelse)'))),
    li(p(txt('Hardkodet 98-kommune dropdown — dynamisk MVP er tilstrækkeligt'))),
    li(p(txt('Analytics telemetri — separat ticket'))),
  ),
  p(strong('Commit: '), code('f0db6ba'), txt('. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-804/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-804/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-804/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-804 → In Review' : `⚠️ ${r.status}`);
}
