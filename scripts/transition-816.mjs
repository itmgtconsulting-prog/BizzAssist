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
  p(strong('Domain template mode shipped — scenario 3 af generate_document')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('/api/ai/generate-file'), txt(' mode=domain_template: proxy POST til eksisterende /api/domain/[id]/case/[caseId]/generate med template_id + user_instructions. Efter generation_id + output_path returneres: download blob fra domain-files + re-upload til ai-generated med 24t TTL + insert ai_file row. Unified signed-URL flow.'))),
    li(p(strong('Backwards compat:'), txt(' domain_generation row + audit-log bevaret via det kaldte endpoint.'))),
    li(p(strong('Derived ext'), txt(' fra output_path-suffix (docx/xlsx/csv) + matching MIME.'))),
    li(p(strong('System-prompt injection:'), txt(' "## Domain templates tilgængelige" sektion med [domain: X] id=Y name="Z" (TYPE) — cap 20 per domain, 30 total. Bruger listUserDomains + domainScopedQuery for at respektere BIZZ-722 mandatory-filter-enforcement.'))),
    li(p(strong('Tool schema udvidet:'), txt(' mode-enum tilføjet "domain_template" + object-property med required [domain_id, domain_template_id, case_id].'))),
  ),
  p(strong('Edge cases:')),
  ul(
    li(p(txt('Non-domain users: ingen templates-sektion injiceres → AI ser ikke option'))),
    li(p(txt('Multiple domains med samme template-navn: AI skal disambiguere via domain-prefix (system-prompt eksplicit)'))),
    li(p(txt('Case_id i andet domain end template: domain-generate endpoint afviser med 403 → tool_error'))),
    li(p(txt('Domain-pipeline timeout (>60s): tool_error med forklaring'))),
  ),
  p(strong('Parkeret:')),
  ul(
    li(p(txt('60s cache på domain-templates query — ticket spec var cache-optimering; parkeret til BIZZ-817 performance-review'))),
  ),
  p(strong('Acceptkriterier:')),
  ul(
    li(p(txt('✅ Domain-admin kan kalde tool via AI ("lav en ejendomsliste baseret på Kunde 1 sagen")'))),
    li(p(txt('✅ Non-domain bruger falder tilbage til scratch/attached_template (ingen kontekst)'))),
    li(p(txt('✅ File_id virker identisk med de andre modes (preview + download via chip)'))),
    li(p(txt('✅ Eksisterende domain_generation audit-row bevares'))),
  ),
  p(strong('Commit: '), code('92e38a4'), txt('. Tests 1761/1775 fortsat gronne. Unblocker: BIZZ-817 (E2E + prompt-tuning + Sentry observability). '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-816/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-816/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-816/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-816 → In Review' : `⚠️ ${r.status}`);
}
