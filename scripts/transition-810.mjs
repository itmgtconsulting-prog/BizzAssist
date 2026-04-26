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
  p(strong('Storage-infra shipped — foundation for AI DocGen 8-series')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('Migration 074'), txt(' — 2 private storage-buckets (ai-attachments 50MB alle MIME, ai-generated 10MB XLSX/DOCX/CSV/PDF/TXT whitelist) via storage.buckets INSERT idempotent. storage.objects policies: service_role only.'))),
    li(p(code('public.ai_file'), txt(' tabel (user-scoped RLS): id, user_id (CASCADE), kind ENUM(attachment|generated), conv_id, file_path, file_name, file_type, size_bytes, metadata JSONB, expires_at. 3 indexes (expires_at/user+kind+created/conv_id). RLS: user SELECT+DELETE egne, service_role ALL.'))),
    li(p(code('/api/cron/purge-ai-files'), txt(' — hourly cron (07 * * * *). CRON_SECRET + x-vercel-cron verified. Fetch expired rows (cap 500/run), batch-delete i storage pr bucket, saa DB-delete. Storage-fejl logges men blokerer ikke — undgaar orphaned rows.'))),
    li(p(code('vercel.json'), txt(' opdateret med cron-schedule.'))),
  ),
  p(strong('GDPR + Edge cases:')),
  ul(
    li(p(txt('Art 5(1)(c) data minimisation: 24t default TTL'))),
    li(p(txt('Art 17 cascade delete fra auth.users'))),
    li(p(txt('Art 32 security: private buckets + signed URLs + RLS'))),
    li(p(txt('Storage-delete race condition: best-effort warn-log, fortsaetter'))),
    li(p(txt('Bucket-konflikt: ON CONFLICT DO NOTHING idempotent'))),
  ),
  p(strong('Afventer (blockede 810 var paa disse):')),
  ul(
    li(p(code('BIZZ-811'), txt(' AI DocGen 2/8: file-generation lib (XLSX/CSV/DOCX)'))),
    li(p(code('BIZZ-812'), txt(' AI DocGen 3/8: /api/ai/attach persisterer binaer + file_id'))),
    li(p(code('BIZZ-813'), txt(' AI DocGen 4/8: /api/ai/generate-file endpoint + tool'))),
    li(p(code('BIZZ-814-817'), txt(' client + preview + templates + tests'))),
  ),
  p(strong('Deployment:'), txt(' Migration skal koeres via Management API i dev/test/prod. Idempotent — safe at re-koere. Bucket-policies skal verificeres i Supabase Studio efter migration.')),
  p(strong('Commit: '), code('a073ec3'), txt('. Tests 1733/1747 fortsat gronne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-810/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-810/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-810/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-810 → In Review' : `⚠️ ${r.status}`);
}
