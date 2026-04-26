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
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

async function postDone(key, commit, bullets) {
  const body = doc(
    h(2, 'Code-review — PASS'),
    p(strong('Commit: '), code(commit), txt('.')),
    ul(...bullets.map(b => li(p(b)))),
    p(strong('Auth-gates verificeret: '), txt('assertDomainAdmin/Member som FØRSTE action. isDomainFeatureEnabled() på routes. Audit-log ved alle writes. Ingen TODOs/FIXMEs i ny kode.')),
    p(strong('→ Done.'))
  );
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => /^done$/i.test(x.name));
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → Done` : `  ⚠️ ${r.status}`);
  }
}

await postDone('BIZZ-707', 'f49258e', [
  [strong('Upload-API '), code('/api/domain/[id]/templates'), txt(' POST — '), code('assertDomainAdmin'), txt(' linje 88, '), code('isDomainFeatureEnabled'), txt(' linje 82.')],
  [strong('Placeholder-auto-detektion '), code('detectPlaceholders'), txt(' linje 132: matcher '), code('{{x}}'), txt(', '), code('{x}'), txt(', '), code('[X]'), txt(', '), code('[[x]]'), txt(' med overlap-elimination + MAX_PLACEHOLDERS cap.')],
  [strong('11 unit-tests '), txt('i '), code('__tests__/domain/placeholder-detect.test.ts'), txt(' dækker alle 4 syntakser, dedup, Danske chars.')],
  [strong('Text extraction + preview '), txt('linje 131 + 204. Initial version-row created linje 175.')],
]);

await postDone('BIZZ-709', '114eb86', [
  [code('/api/domain/[id]/training-docs/route.ts:84'), txt(' — '), code('assertDomainAdmin'), txt(' først, '), code('isDomainFeatureEnabled'), txt(' 78.')],
  [strong('PATCH + DELETE '), txt('på /training-docs/[docId]/ — begge gater korrekt.')],
  [strong('UI TrainingDocsClient '), txt('med upload-form + filter-chips + doc-list + parse_status-badge.')],
  [strong('20 MB cap '), txt('linje 31, doc_type enum enforced, tag-slicing til max 20.')],
]);

await postDone('BIZZ-710', 'bc90896', [
  [code('/api/domain/[id]/templates/[templateId]/versions/route.ts:92'), txt(' POST — '), code('assertDomainAdmin'), txt(' først.')],
  [strong('MAX_VERSIONS=10 '), txt('enforced linje 31. Rollback route med '), code('assertDomainAdmin'), txt(' + version counter bumps (ikke decrements).')],
  [strong('Version-liste '), txt('newest-first, audit-log ved rollback.')],
  [strong('UI TemplateEditor Versions-tab '), txt('med upload + rollback-knapper.')],
]);

await postDone('BIZZ-713', '90c7122', [
  [code('/api/domain/[id]/cases/[caseId]/route.ts:37'), txt(' GET '), code('assertDomainMember'), txt(', DELETE '), code('assertDomainAdmin'), txt(' 159.')],
  [code('/cases/[caseId]/docs/route.ts:64'), txt(' POST — MAX_FILE_SIZE_MB=50 + 50-doc-per-case cap.')],
  [strong('Soft-delete '), txt('via '), code('deleted_at'), txt(' timestamp. Parse_status + parse_error på row.')],
  [strong('UI CaseDetailClient '), txt('med drag-drop-zone, parse-status-badges, inline-edit metadata.')],
]);

await postDone('BIZZ-714', 'd157db3', [
  [code('app/lib/domainTextExtraction.ts'), txt(' — mammoth (.docx), pdf-parse (.pdf), mailparser (.eml), utf-8 (.txt).')],
  [strong('MAX_EXTRACTED_CHARS = 500k '), txt('med '), code('parse_status=truncated'), txt(' ved overskridelse.')],
  [strong('Never throws — '), txt('fejl wrappes som '), code('{ok:false, error}'), txt('. .msg returnerer unsupported-error graceful.')],
  [strong('8 unit-tests '), txt('dækker happy-path, truncation, corrupted files, .msg.')],
]);

await postDone('BIZZ-718', 'efe7220', [
  [code('/api/domain/[id]/audit-log/route.ts:47'), txt(' — '), code('assertDomainAdmin'), txt(' først. Filter (action/target_type/actor/since/until) linje 69-73.')],
  [strong('CSV-escape '), txt('linje 32-39 håndterer quotes/commas/newlines korrekt.')],
  [strong('Limit 500 JSON / 5000 CSV '), txt('— scoped til domain_id (eq line 65).')],
  [strong('UI AuditLogClient '), txt('med 4 filter-inputs + tabel + CSV-export-knap.')],
]);

await postDone('BIZZ-719', '40aaa90', [
  [code('/api/cron/domain-retention/route.ts:47-54'), txt(' — '), code('verifyCronSecret'), txt(' bearer + x-vercel-cron=1 som FØRSTE action.')],
  [strong('DEFAULT_RETENTION_MONTHS = 24 '), txt('konfigureable. Retention soft-delete + tombstone + cascade purge.')],
  [code('/export-all/route.ts:37'), txt(' — '), code('assertDomainAdmin'), txt(' først, export dækker alle 10 tabeller + audit-log.')],
  [strong('Hard-delete cascade '), txt('via PG-constraint + best-effort storage cleanup.')],
]);

await postDone('BIZZ-721', '159c763', [
  [code('TemplateEditorClient.tsx:74-99'), txt(' — 5 tabs (metadata, instructions, examples, placeholders, versions) med live edit-buffers.')],
  [strong('Auto-save 3s idle '), txt('debounce med '), code('saveState=dirty/saving/saved'), txt(' pattern.')],
  [code('PATCH /templates/[templateId]/route.ts:61'), txt(' — '), code('assertDomainAdmin'), txt(' først. PATCHABLE whitelist [name, description, instructions, examples, status].')],
  [strong('Mindre deferrals noteret: '), txt('mammoth docx→HTML preview + placeholder-description PATCHABLE-expansion — ikke blockers.')],
]);

console.log('\nDone.');
