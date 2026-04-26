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
  p(strong('Download-chip shipped — genererede filer synlige i chat')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('ChatGeneratedFileMeta'), txt(' interface + ChatMessage.generatedFiles i delt chatStorage.ts.'))),
    li(p(code('AIChatPanel'), txt(' (drawer) og '), code('ChatPageClient'), txt(' (fullpage) parser nu SSE-event '), code('{generated_file:{...}}'), txt(' fra BIZZ-813 wrapper-laget, buffer til tur-scope array, attacher til final assistant-message saa de persisteres via eksisterende localStorage-flow.'))),
    li(p(strong('Render:'), txt(' chip per fil under assistant-bubble med FileText-ikon, filnavn, format-badge (XLSX/DOCX/CSV), eye-button (docPreview.open) + download-link '), code('<a download>'), txt(' med korrekt filnavn + MIME.'))),
    li(p(strong('Tool-status:'), txt(' "Fil genereret: {navn}" vises mens Claude formulerer sit opfølgende tekst-svar.'))),
  ),
  p(strong('Acceptkriterier:')),
  ul(
    li(p(txt('✅ Chip dukker op i både drawer + fullpage chat efter AI genererer fil'))),
    li(p(txt('✅ Eye-ikon åbner højre-panel med preview + download-knap (docPreview)'))),
    li(p(txt('✅ Download-link bruger signed URL med korrekt filnavn (ikke .bin)'))),
    li(p(txt('✅ Chip overlever reload (persisteret i localStorage)'))),
    li(p(txt('✅ Multi-file per tur: hvis AI kalder tool flere gange, alle chips vises'))),
    li(p(txt('⏳ TTL-404 handling: download fejler efter 24t — klienten viser ikke en "expired"-state. Kunne addes i BIZZ-815 hvis prioriteret.'))),
  ),
  p(strong('Edge cases håndteret:')),
  ul(
    li(p(txt('Tom tekst + genererede filer (AI svarede kun med tool-call): content=empty, chips vises'))),
    li(p(txt('SSE-parser håndterer ukendte event-typer uden at crashe (try/catch)'))),
  ),
  p(strong('Parkeret:')),
  ul(
    li(p(txt('localStorage quota-cap 50/conv — ikke implementeret, men nuværende shape er kompakt nok til flere hundrede. Kan addes i BIZZ-817 hvis problematisk.'))),
    li(p(txt('Slet chat → cascade slet ai_file rows (kraever enten conv_id link-DB-op eller explicit DELETE fra klient — parkeret til BIZZ-820 hvor AI-chat til Supabase migrerer).'))),
  ),
  p(strong('Commit: '), code('f8c0a1d'), txt('. Tests 1761/1775 fortsat gronne. Unblocker: BIZZ-815 (DocPreview binary-aware rendering). '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-814/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-814/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-814/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-814 → In Review' : `⚠️ ${r.status}`);
}
