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
  p(strong('Shipped — MVP virksomheds-filter-katalog (5 filtre)')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('/api/cvr-search'), txt(' API udvidet: CVRSearchResult returnerer nu '), code('status'), txt(' (sammensatStatus), '), code('stiftetAar'), txt(' (fra stiftelsesDato) og '), code('kommuneNavn'), txt(' (fra beliggenhedsadresse). ES _source whitelist uændret.'))),
    li(p(code('app/lib/search/virksomhedFilterSchema.ts'), txt(' — 5 filtre: Status multi-select (7 CVR-statusser), Virksomhedsform multi-select (11 former, value=kortBeskrivelse), Branche + Kommune dynamisk multi-select, Stiftet år range 1900-current. Legacy kunAktive erstattet.'))),
    li(p(code('UniversalSearchPageClient'), txt(' companies-tab bygger currentTabSchemas dynamisk fra live brancher + kommuner. Ingen structural ændring i tab-aware FilterPanel.'))),
  ),
  p(strong('Design-alignment:')),
  ul(
    li(p(txt('Dark theme konsistent (#0a1020/#0f172a, slate-700/40, blue-500)'))),
    li(p(txt('URL-konvention fra BIZZ-792: ?status=Normal,Ophørt · ?virksomhedsform=ApS · ?branche=IT · ?kommune=København · ?stiftet=2020-2025'))),
    li(p(txt('matchVirksomhedFilter har bidirectional substring-match på companyType for robust CVR ES-data + legacy active-bool fallback når status er null'))),
    li(p(txt('ResetButton nulstiller kun current tabs keys (ejendomme-valg bevares ved tab-skift)'))),
    li(p(txt('Dansk locale-compare (Å=Aa) respekteret i kommune/branche sortering'))),
  ),
  p(strong('Test-dækning:'), txt(' 18 unit tests + 1706 eksisterende fortsat grønne (1724/1738 total). Dækker schema-struktur, match-logik for alle 5 filtre, bidirectional companyType-match, stiftet range-clamping, options-dedup, narrowVirksomhedFilters type-safety.')),
  p(strong('Ikke i denne ticket:')),
  ul(
    li(p(code('789b'), txt(' regnskab (cvr_regnskab + ETL)'))),
    li(p(code('789c'), txt(' ejerforhold (GDPR PII)'))),
    li(p(code('789d'), txt(' deltager (tsvector)'))),
    li(p(code('789e'), txt(' cross-domain (EJF-berigelse)'))),
    li(p(code('789f'), txt(' presets + misc'))),
    li(p(code('/api/cvr/count'), txt(' endpoint — matchCount beregnes client-side fra allerede-hentet resultat'))),
  ),
  p(strong('Commit: '), code('e8c1205'), txt('. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-805/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-805/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-805/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-805 → In Review' : `⚠️ ${r.status}`);
}
