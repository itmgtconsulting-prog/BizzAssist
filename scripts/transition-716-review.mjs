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
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

const body = doc(
  h(2, 'Iteration 2 — enrichWithBizzData implementeret'),
  p(txt('Reviewer-feedback adresseret: entity-data-enrichment er ikke længere deferred — '), code('buildGenerationContext'), txt(' kalder '), code('enrichEntities({ cvrs, bfes })'), txt(' og array\'et rendes nu i '), code('userPromptParts'), txt(' som Claude faktisk ser.')),
  h(3, 'Ny fil: app/lib/domainEnrichEntities.ts'),
  cb(
`Kilder (alle lokale — ingen intern HTTP fra server):
  CVR  →  cvr_virksomhed (navn, adresse_json, branche, stiftet,
          status, virksomhedsform, ansatte_aar)
  BFE  →  ejf_ejerskab (status='gældende') — current owners
          + fetchBbrAreasByBfe (boligAreal / erhvervsAreal / samlet)

Caps for at beskytte prompt-budget:
  MAX_ENTITIES_PER_TYPE   = 8  (soft-cap pr. kind)
  PER_ENTITY_CHAR_CAP     = 2000 (JSON chars pr. entity)

Ingen kast — per-entity fejl swallowes + logges; caller får partial.`,
    'text'
  ),
  h(3, 'Wire-up i domainPromptBuilder.ts'),
  cb(
`// step 4 i buildGenerationContext:
let bizzassist: BizzAssistEntity[] = [];
try {
  bizzassist = await enrichEntities({
    cvrs: entities.cvrs,
    bfes: entities.bfes,
  });
} catch (err) {
  warnings.push('entity-enrichment-unavailable');
}

// token-accounting inkluderer nu bizzassist_data
tokens += bizzassist.reduce(
  (s, e) => s + estimateTokens(...stringified data...),
  0
);`,
    'typescript'
  ),
  h(3, 'Wire-up i /api/domain/:id/case/:caseId/generate/route.ts'),
  cb(
`context.bizzassist_data.length > 0
  ? \`BizzAssist reference data (CVR / BFE lookups for entities in
    the case docs):\\n\${context.bizzassist_data
      .map(e => \`=== \${e.kind.toUpperCase()} \${e.id} ===\\n\${...}\`)
      .join('\\n\\n')}\`
  : null,`,
    'typescript'
  ),
  h(3, 'Unit-tests (6 nye)'),
  ul(
    li(p(txt('empty input → empty output'))),
    li(p(code('cvr_virksomhed'), txt(' batch-fetch returnerer shape med navn + branche'))),
    li(p(code('MAX_ENTITIES_PER_TYPE'), txt(' cap respekteres selv ved 12 inputs'))),
    li(p(txt('BFE enrichment joiner '), code('ejf_ejerskab'), txt(' owners + BBR areas'))),
    li(p(txt('Supabase throw swallowes — caller får tom array'))),
    li(p(code('PER_ENTITY_CHAR_CAP'), txt(' truncerer 5k-char payloads med "…[truncated]"'))),
  ),
  p(strong('Test-status: '), txt('1613/1627 grønne (+6 nye), type-check clean. Commit: '), code('a767abe'), txt('.')),
  p(strong('→ In Review.'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-716/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-716 comment' : `❌ ${cr.status} ${cr.body}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-716/transitions`);
const transitions = JSON.parse(tr.body).transitions || [];
const target = transitions.find(t => /^in review$/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-716/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? `  ✅ BIZZ-716 → ${target.name}` : `  ⚠️ ${r.status} ${r.body}`);
}
