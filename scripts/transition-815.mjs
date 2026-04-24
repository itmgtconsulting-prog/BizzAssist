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
  p(strong('DocPreview binary-aware rendering shipped')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('DocPreviewContent'), txt(' udvidet med '), code('kind: text | table | slides'), txt(' + '), code('columns'), txt(' + '), code('rows'), txt('. Bagudkompatibel — callers uden kind får default text.'))),
    li(p(code('DocPreviewPanel'), txt(' renderer tabel via ny TablePreview-komponent: sticky header, zebra rows, cell truncation med title-tooltip, row-meta footer, "vis alle" toggle (200 → 500 rækker).'))),
    li(p(code('xlsxToPreviewTable()'), txt(' + '), code('csvToPreviewTable()'), txt(' i aiFileGeneration-lib. XLSX via exceljs.load med Date/formula/richText coercion. CSV via RFC-4180 mini-parser (BOM-strip + auto-detect delimiter + quoted-field escape). Cap 500 rows × 50 cols.'))),
    li(p(code('/api/ai/generate-file'), txt(' returnerer nu '), code('preview_kind'), txt(' + '), code('preview_columns'), txt(' + '), code('preview_rows'), txt(' for XLSX/CSV (best-effort — parse-fejl falder tilbage til text). DOCX beholder preview_text som før.'))),
    li(p(strong('Threading:'), txt(' SSE-event '), code('generated_file'), txt(' + ChatGeneratedFileMeta + Message.generatedFiles i begge surfaces. AIChatPanel + ChatPageClient docPreview.open() passer kind/columns/rows gennem.'))),
  ),
  p(strong('Acceptkriterier:')),
  ul(
    li(p(txt('✅ XLSX-fil viser HTML-tabel med korrekte kolonnenavne'))),
    li(p(txt('✅ CSV-fil: samme HTML-tabel, æøå renderes korrekt (UTF-8 BOM strip)'))),
    li(p(txt('✅ DOCX-fil: text-preview som før'))),
    li(p(txt('✅ >200 rækker: kun første vises, "vis alle" udvider til 500'))),
    li(p(txt('⏳ Playwright screenshot-regression: ikke i denne iter (parkeret til BIZZ-817 E2E-suite)'))),
  ),
  p(strong('Edge cases:')),
  ul(
    li(p(txt('Tom sheet/parse-fejl → text-fallback (preview_text)'))),
    li(p(txt('exceljs formula-cell: prefer result → text → String(value)'))),
    li(p(txt('CSV auto-detect komma vs semikolon fra første linje'))),
    li(p(txt('Cell >200px: truncate med full-text i title-tooltip'))),
  ),
  p(strong('Commit: '), code('0b675e6'), txt('. Tests 1761/1775 fortsat gronne. Unblocker: BIZZ-816 (domain_template mode). '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-815/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-815/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-815/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-815 → In Review' : `⚠️ ${r.status}`);
}
