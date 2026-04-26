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

const body = doc(
  h(2, 'Iter 1 shipped — tab-layout på kundesager'),
  p(strong('Scope iter 1: '), txt('layout-alignment (ticket-bullet 1). Tab-bar rundt om eksisterende indhold — matches person/virksomhed/ejendom detail-pages.')),
  h(3, 'Tabs'),
  ul(
    li(p(code('Overblik'), txt(' — sagsdetaljer form + save + "Generér dokument"-knap'))),
    li(p(code('Dokumenter'), txt(' — upload zone + doc-liste (eksisterende UI)'))),
    li(p(code('AI Assistent'), txt(' — placeholder card med shortcut til den nuværende generate-modal. Iter 2 wire\'r AIChatPanel.'))),
  ),
  h(3, 'Skabelon-valg (ticket-bullet 2)'),
  p(txt('Dækket delvist af den eksisterende '), code('openGenerateModal()'), txt(' flow der allerede loader '), code('/api/domain/[id]/templates'), txt(' og viser filtered-by-status=active dropdown. Modal rydder skabelon + user-instructions og fyrer '), code('POST /api/domain/[id]/case/[caseId]/generate'), txt('.')),
  h(3, 'Iter 2 scope (parked)'),
  ul(
    li(p(strong('AI-dialog: '), txt('integrér '), code('AIChatPanel.tsx'), txt(' med case + template-kontekst som AIPageContext extension'))),
    li(p(strong('Document-selection: '), txt('checkbox-liste over case docs + attached template docs fra BIZZ-743 junction'))),
    li(p(strong('Ny API: '), code('POST /api/domain/[id]/case/[caseId]/ai'), txt(' med case+skabelon kontekst'))),
    li(p(strong('DB: '), code('case_ai_messages'), txt(' tabel for chat-historik per sag'))),
    li(p(strong('Preview + iterativ redigering: '), txt('side-by-side preview af generated doc, AI-feedback loop indtil brugeren godkender og gemmer'))),
  ),
  p(strong('Commit: '), code('f99f3cd'), txt('. Tests 1626/1640 grønne. '), strong('→ In Review (partial — AI wiring i iter 2).'))
);

const cr = await req('POST', `/rest/api/3/issue/BIZZ-745/comment`, { body });
console.log(cr.status === 201 ? '✅ BIZZ-745 comment' : `❌ ${cr.status}`);
const tr = await req('GET', `/rest/api/3/issue/BIZZ-745/transitions`);
const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
if (target) {
  const r = await req('POST', `/rest/api/3/issue/BIZZ-745/transitions`, { transition: { id: target.id } });
  console.log(r.status === 204 ? '  ✅ BIZZ-745 → In Review' : `  ⚠️ ${r.status}`);
}
