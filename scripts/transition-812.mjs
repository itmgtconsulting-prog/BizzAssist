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
  p(strong('Attach-persistens shipped — file_id threader gennem chat-flow')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('/api/ai/attach'), txt(' — efter extractTextFromBuffer succes, upload buffer til ai-attachments/{userId}/{uuid}-{sanitizedName} + insert ai_file row med expires_at=+24t. Best-effort: upload/DB-fejl logges men blokerer ikke chat-flow. Orphan-cleanup hvis DB-insert fejler. Bruger sanitizeFilename fra BIZZ-811.'))),
    li(p(strong('Response:'), txt(' tilføjet file_id?: string | null — null hvis persistens fejlede.'))),
    li(p(strong('ChatAttachmentMeta/ChatAttachment:'), txt(' udvidet med file_id i chatStorage.ts + AIChatPanel + ChatPageClient.'))),
    li(p(strong('Chat-request:'), txt(' begge surfaces (drawer + fullpage) filtrerer attachments med file_id !== null, mapper til { file_id, name, file_type } og sender som attachments-array i POST /api/ai/chat-body.'))),
    li(p(code('/api/ai/chat'), txt(' — ChatRequestBody udvidet med optional attachments-field. Kun pass-through i denne ticket; tool-dispatcher bruger dem i BIZZ-813.'))),
  ),
  p(strong('Backwards-compat:')),
  ul(
    li(p(txt('Hvis file_id null eller persistens fejl: chat-flow fortsætter som før (tekst-injection)'))),
    li(p(txt('Eksisterende samtaler uden file_id paavirkes ikke'))),
  ),
  p(strong('Acceptkriterier:')),
  ul(
    li(p(txt('✅ Upload en fil → file_id returneres (verificeres i dev)'))),
    li(p(txt('✅ Blob eksisterer i ai-attachments bucket + row i ai_file'))),
    li(p(txt('✅ Cron fra BIZZ-810 sletter efter 24t (backdated expires_at manuel test)'))),
    li(p(txt('✅ Drawer + fullpage sender file_id med i next chat request'))),
    li(p(txt('✅ Attachment-chips uændrede i history'))),
  ),
  p(strong('Unblocker:'), txt(' BIZZ-813 (/api/ai/generate-file endpoint + Claude tool generate_document) kan nu starte — attachments er tilgængelige i request-body.')),
  p(strong('Commit: '), code('f7006b1'), txt('. Tests 1761/1775 fortsat gronne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-812/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-812/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-812/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-812 → In Review' : `⚠️ ${r.status}`);
}
