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
  p(strong('generate-file endpoint + Claude tool shipped')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('POST /api/ai/generate-file'), txt(' — zod-valideret input med 3 modes. Mode scratch kalder aiFileGeneration-lib for alle formater. Mode attached_template henter binaer via user-scoped ai_file lookup + fillDocxTemplate (DOCX only i iter 1). Mode domain_template returnerer 501 — parkeret til BIZZ-816.'))),
    li(p(strong('Upload + tracking:'), txt(' resultat uploades til ai-generated/{userId}/{uuid}-{title}.{ext}, insert ai_file row med expires_at=+24t + metadata, signed download URL 24t. Orphan-cleanup ved DB-fejl.'))),
    li(p(strong('Response:'), txt(' { file_id, file_name, download_url, preview_text, bytes, format }'))),
  ),
  p(strong('Claude tool integration i /api/ai/chat:')),
  ul(
    li(p(code('generate_document'), txt(' tool definition tilfoejet til TOOLS-array med format enum + mode enum + scratch/attached_template schemas + title.'))),
    li(p(code('executeTool'), txt(' case: POST til /api/ai/generate-file med cookie-forwarding.'))),
    li(p(strong('Wrapper-laget splitter resultatet:'), txt(' emit SSE-event '), code('{generated_file:{file_id,file_name,download_url,preview_text,bytes,format}}'), txt(' saa klienten kan vise chip straks. Claude-facing tool_result stripper download_url (undgaar URL i markdown-svar).'))),
    li(p(strong('TOOL_STATUS:'), txt(' "Genererer fil…"'))),
    li(p(strong('SYSTEM_PROMPT udvidet:'), txt(' Fil-generering-section med format-valg-heuristik (excel→xlsx, word→docx, csv→csv), mode-valg (scratch vs attached_template), KUN-ved-eksplicit-anmodning regel, KORT-kvittering efter tool-call.'))),
  ),
  p(strong('Parkeret til iters:')),
  ul(
    li(p(code('BIZZ-816'), txt(' mode=domain_template (proxy til /api/domain/[id]/case/[caseId]/generate)'))),
    li(p(code('BIZZ-817'), txt(' fast 500-token fee + Sentry observability'))),
    li(p(txt('previous_file_id iteration (ikke kritisk for MVP)'))),
    li(p(txt('scanSuspiciousContent i attached templates (security review kan ske i BIZZ-817 E2E-tests)'))),
    li(p(txt('XLSX template-fill (fillXlsxTemplate er stub — iter 2)'))),
  ),
  p(strong('Acceptkriterier:')),
  ul(
    li(p(txt('✅ Zod reject malformet format ("pdf") med informativ fejl'))),
    li(p(txt('✅ Mode scratch genererer XLSX/CSV/DOCX fra scratch'))),
    li(p(txt('✅ Mode attached_template fylder DOCX placeholders via fillDocxTemplate'))),
    li(p(txt('✅ SSE-event emitteres foer tool_result returnerer til Claude'))),
    li(p(txt('✅ Claude-facing tool_result har INGEN download_url'))),
    li(p(txt('⏳ Token-accounting 500 fee — BIZZ-817'))),
    li(p(txt('⏳ Rate-limit 10/min — eksisterende aiRateLimit daekker midlertidigt'))),
  ),
  p(strong('Unblocker:'), txt(' BIZZ-814 (client-side download-chip + DocPreview) kan nu starte. SSE-event format er defineret og dokumenteret.')),
  p(strong('Commit: '), code('9c1f969'), txt('. Tests 1761/1775 fortsat gronne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-813/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-813/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-813/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-813 → In Review' : `⚠️ ${r.status}`);
}
