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
  p(strong('File-generation lib shipped — foundation for DocGen tool-use')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('app/lib/aiFileGeneration.ts'), txt(' — rene pure-functions der producerer Buffer-output til upload i ai-generated bucket'))),
    li(p(code('generateXlsx()'), txt(' exceljs: auto-filter, frozen header, width-auto-fit, formula-escape, Date/undefined coercion'))),
    li(p(code('generateCsv()'), txt(' UTF-8 BOM + CRLF + semicolon default, RFC-4180 escape (wrap + doubled quotes), formula-escape'))),
    li(p(code('generateDocx()'), txt(' minimalt DOCX via PizZip + inline OOXML — INGEN base-template-file i repoet. Title/subtitle/sections med XML-escape'))),
    li(p(code('fillDocxTemplate()'), txt(' docxtemplater med nullGetter (manglende placeholder → tom streng). Reuse af BIZZ-744 pattern.'))),
    li(p(code('fillXlsxTemplate()'), txt(' iter-2 stub, kaster informativ fejl'))),
    li(p(code('sanitizeFilename() + escapeFormula()'), txt(' OWASP helpers eksponeret for test + genbrug'))),
    li(p(strong('Zod schemas:'), txt(' eksporteret saa tool-dispatcher (BIZZ-813) kan reject malformet AI-output foer generator kaldes'))),
  ),
  p(strong('Security:')),
  ul(
    li(p(txt('OWASP formula-injection: =/+/-/@ prefix apostrof i XLSX + CSV'))),
    li(p(txt('Filename sanitize: path-seps, .., control-chars, max 100 chars, empty → "file"'))),
    li(p(txt('5MB MAX_OUTPUT_BYTES per generator'))),
    li(p(txt('Zod hard limits: 50 cols, 10k rows, 500 char/cell'))),
  ),
  p(strong('Test-dækning:'), txt(' 28 unit tests — happy path + edge cases (formula-injection, XML-escape, delimiter/newline wrapping, danske tegn, undefined cells, manglende docx-placeholders, schema violations). 1761/1775 total grønne.')),
  p(strong('Afhængigheder:'), txt(' Ingen nye deps. Genbruger exceljs + docxtemplater + pizzip fra package.json.')),
  p(strong('Unblocker:'), txt(' BIZZ-813 (/api/ai/generate-file endpoint) kan nu starte.')),
  p(strong('Commit: '), code('3bb430b'), txt('. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-811/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-811/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-811/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-811 → In Review' : `⚠️ ${r.status}`);
}
