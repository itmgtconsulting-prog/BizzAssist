#!/usr/bin/env node
/**
 * Batch-transition shipped tickets to In Review with a uniform comment.
 * BIZZ-746/747/750/757/749/758/752 — all shipped in commit 60ef3f5.
 */
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
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

const perTicket = {
  'BIZZ-746': [
    p(strong('Shipped — clickable rows i /dashboard/admin/domains')),
    p(txt('Hele '), code('<tr>'), txt(' har nu '), code('onClick → router.push'), txt(' til '), code('/dashboard/admin/domains/[id]'), txt('. Action-column har '), code('stopPropagation'), txt(' så Suspendér/Slet-knapperne stadig virker uden at navigere. Commit '), code('60ef3f5'), txt('.')),
  ],
  'BIZZ-747': [
    p(strong('Shipped — search + status-filter i templates list')),
    p(txt('Tilføjet søgefelt (name + description lowercase-includes) + status-dropdown (alle/aktive/arkiveret) i '), code('TemplatesListClient.tsx'), txt('. Empty-state skelner "no templates" vs "no match". Commit '), code('60ef3f5'), txt('.')),
  ],
  'BIZZ-750': [
    p(strong('Shipped — search + role-filter i domain users list')),
    p(txt('Tilføjet email/navn-søgning + role-dropdown (alle/admin/member) i '), code('DomainUsersClient.tsx'), txt('. Matches /dashboard/admin/users-pattern. Commit '), code('60ef3f5'), txt('.')),
  ],
  'BIZZ-757': [
    p(strong('Shipped — grøn admin / slate member badges')),
    p(txt('Opdateret '), code('DomainUsersClient.tsx'), txt(' role-badge: admin er nu grøn (emerald-500/20) med border, member er slate. Matches ticket-spec. Commit '), code('60ef3f5'), txt('.')),
  ],
  'BIZZ-749': [
    p(strong('Shipped — AdminNavTabs på ai-feedback + release-manager')),
    p(txt('Begge sider wrapper nu '), code('<AdminNavTabs>'), txt(' så brugeren kan navigere ud til de andre admin-sider. activeTab-værdien matcher ikke nogen TAB-id så der er ingen active-highlight (konsistent "mellem"-status). Commit '), code('60ef3f5'), txt('.')),
  ],
  'BIZZ-758': [
    p(strong('Shipped — breadcrumb på case detail')),
    p(txt('Ny breadcrumb-nav i '), code('CaseDetailClient.tsx'), txt(': Domain > Sager > [case navn]. Erstatter "Tilbage til sager"-link. Commit '), code('60ef3f5'), txt('.')),
  ],
  'BIZZ-752': [
    p(strong('Shipped — "Tilbage til dashboard"-links fjernet fra 5 domain admin sub-pages')),
    p(txt('De duplikerede back-links i users/templates/training/audit/settings er fjernet. '), code('DomainAdminTabs'), txt(' (BIZZ-742) har allerede en back-arrow + breadcrumb-header så links var redundante og tvetydige. Commit '), code('60ef3f5'), txt('.')),
  ],
};

for (const [key, body] of Object.entries(perTicket)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: doc(...body) });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const target = (JSON.parse(tr.body).transitions || []).find(t => /^in review$/i.test(t.name));
  if (target) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → In Review` : `  ⚠️ ${r.status}`);
  }
}
