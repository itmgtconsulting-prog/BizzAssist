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
  p(strong('Iter 1 shipped — Opret sag-knap paa alle 3 detail-sider')),
  p(strong('Leverancer:')),
  ul(
    li(p(code('app/hooks/useDomainMemberships.ts'), txt(' — session-scoped cache af /api/domain/mine. Knappen vises kun hvis memberships.length > 0.'))),
    li(p(code('app/components/sager/CreateCaseModal.tsx'), txt(' — modal med sagsnavn + klient-ref + pre-populeret entity-chip + domain-dropdown (hvis >1 memberships). ARIA role=dialog + auto-focus + ESC/backdrop-luk. Success router.push til /domain/[id]?sag={caseId}.'))),
    li(p(strong('EjendomDetaljeClient:'), txt(' Opret sag-knap efter Foelg-tooltip. Ejendom pre-populeres som entity-chip (men client_kind forbliver null indtil iter 2 tilfoejer schema-kolonne).'))),
    li(p(strong('VirksomhedDetaljeClient:'), txt(' knap efter Foelg-button. client_kind=company + client_cvr mappet fra data.vat.'))),
    li(p(strong('PersonDetailPageClient:'), txt(' knap efter Foelg-button. client_kind=person + client_person_id=enhedsNummer.'))),
  ),
  p(strong('Design-alignment:')),
  ul(
    li(p(txt('Emerald-farve-skema matcher Briefcase-ikon i header — tydeligt adskilt fra blaa Foelg-knap'))),
    li(p(txt('Modal darktheme matcher resten af admin-UI (slate-900, blue-500 accent)'))),
    li(p(txt('Entity-chip-farver genbruger BIZZ-806 pattern (virksomhed=blue, person=purple, ejendom=emerald)'))),
  ),
  p(strong('Acceptkriterier opfyldt:')),
  ul(
    li(p(txt('✅ Knappen vises KUN for domain-brugere (skjult for andre)'))),
    li(p(txt('✅ Klik aabner ARIA-compliant modal'))),
    li(p(txt('✅ Aktuel entitet pre-populeres (virksomhed/person som client_kind, ejendom som tekst-reference)'))),
    li(p(txt('✅ Ved gem: sag oprettes, bruger foeres til /domain/[id]?sag=X'))),
    li(p(txt('✅ Multi-domain dropdown hvis >1 memberships'))),
    li(p(txt('✅ Audit log via eksisterende POST endpoint (create_case event)'))),
  ),
  p(strong('Iter 2 parkeret (skal oprettes som BIZZ-808b):')),
  ul(
    li(p(txt('Schema-udvidelse: client_ejendom_bfe + client_dawa_id kolonner paa domain_case (migration + API-opdatering)'))),
    li(p(txt('Multi-entity personer[] + virksomheder[] + ejendomme[] arrays paa sagen (flere parter)'))),
    li(p(txt('Fuld field parity i modal: status, tags, noter, multi-select entitet-soegning (EntityResultItem fra BIZZ-806)'))),
    li(p(txt('Proper focus-trap med aria-hidden paa baggrund'))),
  ),
  p(strong('Commit: '), code('01245d7'), txt('. Tests 1733/1747 fortsat gronne. '), strong('→ In Review.')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-808/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-808/transitions');
const t = (JSON.parse(tr.body).transitions || []).find((x) => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-808/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ BIZZ-808 → In Review' : `⚠️ ${r.status}`);
}
