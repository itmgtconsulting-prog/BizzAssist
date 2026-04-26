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
  p(strong('DB-laget shipped — ai_chat_sessions + ai_chat_messages per tenant')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('Migration 073'), txt(' — ny RPC provision_ai_chat_tables(schema, tenant_id) der opretter begge tabeller idempotent i et givet tenant_xxx-schema. DO-loop patcher alle eksisterende tenants via PERFORM.'))),
    li(p(strong('Schema:'), txt(' ai_chat_sessions (id/tenant_id/user_id/title/context_type+id/last_msg_at/archived_at/timestamps) + ai_chat_messages (session_id/role/content JSONB/tokens/model/tool_calls JSONB). 4 indexes (user_lastmsg/tenant/retention/context) + 2 messages-indexes.'))),
    li(p(strong('RLS user-scoped:'), txt(' SELECT user_id=auth.uid() AND is_tenant_member, UPDATE user_id=auth.uid() (title+archive), service_role full write. Messages SELECT via EXISTS-check mod owner-session.'))),
    li(p(strong('Triggers:'), txt(' set_updated_at genbrug fra migration 002. ON DELETE CASCADE fra auth.users (GDPR Art 17) og session→messages.'))),
    li(p(code('lib/db/tenant.ts'), txt(' — provisionTenantSchema() kalder nu provision_ai_chat_tables efter provision_tenant_ai_tables (ikke-fatal fejl-logging matcher BIZZ-644 mønster).'))),
    li(p(code('/api/cron/purge-old-data'), txt(' — ny step i per-tenant loop: DELETE ai_chat_sessions WHERE last_msg_at < 12mo AND archived_at IS NULL. Messages cascader. TenantPurgeResult udvidet med aiChatSessionsDeleted.'))),
  ),
  p(strong('GDPR + ISO compliance:')),
  ul(
    li(p(txt('Art 5(1)(e) retention: 12 mdr default på last_msg_at (archived ekskluderet)'))),
    li(p(txt('Art 17 cascade delete: auth.users → sessions → messages'))),
    li(p(txt('ISO 27001 A.9: per-user RLS policies verificeres via EXISTS-subquery'))),
  ),
  p(strong('Afventer:')),
  ul(
    li(p(code('BIZZ-819'), txt(' — /api/ai/sessions CRUD + /api/ai/chat server-side persist + Realtime'))),
    li(p(code('BIZZ-820'), txt(' — AIChatContext → Supabase+Realtime + localStorage migration + privacy-page sub-processor'))),
  ),
  p(strong('Deployment:'), txt(' Migration skal koeres i dev/test/prod via Management API. Idempotent — sikker at re-koere. 819/820 er blocked paa denne migration.')),
  p(strong('Commit: '), code('72297ea'), txt('. Tests 1733/1747 fortsat gronne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-818/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-818/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-818/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-818 → In Review' : `⚠️ ${r.status}`);
}
