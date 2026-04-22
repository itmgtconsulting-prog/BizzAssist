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

const plainBody = (text) => ({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const notes = {
  'BIZZ-707': 'Code-review PASS. Commit f49258e. /api/domain/[id]/templates POST — assertDomainAdmin first, feature-flag gate, placeholder auto-detection (regex for {{x}}, {x}, [X], [[x]] med overlap-elimination), text extraction + preview, 11 unit-tests for placeholders. Transitioned til Done.',
  'BIZZ-709': 'Code-review PASS. Commit 114eb86. /api/domain/[id]/training-docs routes — assertDomainAdmin first på POST+PATCH+DELETE, 20 MB cap, doc_type enum enforced, filter-chips i UI, parse_status-badge rendering. Transitioned til Done.',
  'BIZZ-710': 'Code-review PASS. Commit bc90896. /versions route med MAX_VERSIONS=10 enforced, rollback bumps counter (ikke decrement), audit-log ved rollback, UI Versions-tab med upload+rollback. Transitioned til Done.',
  'BIZZ-713': 'Code-review PASS. Commit 90c7122. Case detail + upload: assertDomainMember på GET/POST, assertDomainAdmin på DELETE, MAX_FILE_SIZE_MB=50, 50-doc-per-case cap, soft-delete via deleted_at, CaseDetailClient med drag-drop + parse-status-badges. Transitioned til Done.',
  'BIZZ-714': 'Code-review PASS. Commit d157db3. domainTextExtraction.ts understøtter docx (mammoth), pdf (pdf-parse), txt (utf-8), eml (mailparser); .msg returnerer unsupported graceful. MAX_EXTRACTED_CHARS=500k med parse_status=truncated. Never throws. 8 unit-tests. Transitioned til Done.',
  'BIZZ-718': 'Code-review PASS. Commit efe7220. /audit-log route med assertDomainAdmin først, 4 filter-params, CSV-escape for quotes/commas/newlines, limit 500 JSON / 5000 CSV, scoped til domain_id. UI med filter-inputs + tabel + CSV-export-knap. Transitioned til Done.',
  'BIZZ-719': 'Code-review PASS. Commit 40aaa90. /api/cron/domain-retention med verifyCronSecret (bearer + x-vercel-cron=1) som første action, DEFAULT_RETENTION_MONTHS=24 konfigureable, tombstone + cascade purge. /export-all med assertDomainAdmin først, dækker alle 10 tabeller + audit-log. Transitioned til Done.',
  'BIZZ-721': 'Code-review PASS. Commit 159c763. TemplateEditorClient med 5 tabs + auto-save (3s idle debounce med dirty/saving/saved state). PATCH route med assertDomainAdmin først + PATCHABLE-whitelist. Mindre deferrals noteret (mammoth preview, placeholder-description expansion) — ikke blockers. Transitioned til Done.',
};

for (const [key, text] of Object.entries(notes)) {
  const r = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: plainBody(text) });
  console.log(r.status === 201 ? `✅ ${key} plain-text comment posted` : `❌ ${key} ${r.status} ${r.body.slice(0, 150)}`);
}
