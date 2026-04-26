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

const perTicket = {
  'BIZZ-782': { type: 'doc', version: 1, content: [
    p(strong('Iter 1 shipped — scope-color chips + info-chips under header')),
    ul(
      li(p(strong('Scope chips:'), txt(' '), code('app/lib/scopeColors.ts'), txt(' exporter '), code('SCOPE_COLORS'), txt(' map — '), code('read:properties'), txt('=emerald, '), code('read:companies'), txt('=blue, '), code('read:people'), txt('=purple, '), code('read:ai'), txt('=amber. '), code('TokensPageClient'), txt(' chips bruger nu per-scope farver i stedet for hardcoded blå.'))),
      li(p(strong('Info-chips under H1:'), txt(' plan-badge (Basis/Professionel/Enterprise) + tokens remaining/total badge (eller "Ubegrænset" badge). Farve-kode: emerald hvis ≥50% tilbage, amber hvis 20-50%, rød hvis <20%.'))),
      li(p(strong('Create-key modal:'), txt(' panel border switched fra '), code('border-slate-700/50'), txt(' til '), code('border-blue-500/30'), txt(' for bedre visuelt link til primary action.'))),
    ),
    p(strong('Iter 2 (parkeret):'), txt(' scope-color chip også i create-key modal scope-picker; hover-tooltip med scope-beskrivelse; "Copy scope URL" quick-action.')),
    p(strong('Commit: '), code('4e50bc4'), txt('. Tests 1640/1654 grønne. '), strong('→ In Review.')),
  ]},
  'BIZZ-784': { type: 'doc', version: 1, content: [
    p(strong('Iter 1 shipped — udfaset-filter på matrikel-søgning')),
    ul(
      li(p(code('/api/ejerlejligheder'), txt(' — ny '), code('includeUdfasede'), txt(' query param (default false). Tinglysning-path sætter '), code('udfaset=true'), txt(' hvis '), code('ejendomsVurdering=0 AND grundVaerdi=0'), txt(' (heuristic, proper BBR-status lookup er iter 2). Filteret fjerner '), code('udfaset===true'), txt(' men beholder '), code('udfaset===null'), txt(' (ukendt = aktiv).'))),
      li(p(code('UniversalSearchPageClient'), txt(' matrikel-mode — useEffect læser nu '), code('hideRetiredProperties'), txt(' state (filter-panel toggle fra BIZZ-774) og sender '), code('includeUdfasede=true'), txt(' når toggle er off.'))),
      li(p(strong('DAWA fallback path:'), txt(' returnerer '), code('udfaset=null'), txt(' (kan ikke afgøres uden BBR-lookup) — rows vises altid.'))),
    ),
    p(strong('Iter 2 (parkeret):'), txt(' proper BBR-status code lookup (status 4=nedlagt / 10=udgået / 11=under opdeling). Kræver query mod BBR Enhed.statusKode via '), code('fetchBbrData.ts'), txt('.')),
    p(strong('Commit: '), code('4e50bc4'), txt('. Tests 1640/1654 grønne. '), strong('→ In Review.')),
  ]},
  'BIZZ-783': { type: 'doc', version: 1, content: [
    p(strong('Parkeret — scope too large for single ticket')),
    p(txt('AI chat migration fra localStorage til Supabase er en stor feature der bør splittes i 3 selvstændige delleverancer før implementation:')),
    ul(
      li(p(code('BIZZ-783a'), txt(' — DB schema: '), code('ai_chat_sessions'), txt(' (id, tenant_id, user_id, title, last_msg_at, archived_at) + '), code('ai_chat_messages'), txt(' (id, session_id, role, content jsonb, tokens, created_at). RLS per tenant_id. Migration + types.'))),
      li(p(code('BIZZ-783b'), txt(' — API: '), code('/api/ai/sessions'), txt(' CRUD + '), code('/api/ai/sessions/[id]/messages'), txt(' append-stream. Wire '), code('AIChatPanel'), txt(' til at session-ID persisterer on mount og streaming writes flytter fra useState til '), code('flushTo DB on pause'), txt('.'))),
      li(p(code('BIZZ-783c'), txt(' — UI: session-sidebar med history, rename, archive, share-link (tenant-scoped). Migration-helper der engangs-importerer eksisterende '), code('localStorage'), txt(' sessions til DB ved første login efter release.'))),
    ),
    p(strong('Non-code overvejelser:'), txt(' GDPR retention (hvor længe gemmer vi chat-historik? forslag: 12 måneder, matcher '), code('/api/cron/purge-old-data'), txt('). Export til ZIP/JSON. Cross-device sync er primary value prop.')),
    p(strong('Afventer:'), txt(' ARCHITECT signoff på 3-way split og retention policy før 783a startes. '), strong('→ Blocked.')),
  ]},
};

for (const [key, body] of Object.entries(perTicket)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const targetName = key === 'BIZZ-783' ? /^blocked$/i : /^in review$/i;
  const target = (JSON.parse(tr.body).transitions || []).find((t) => targetName.test(t.name));
  if (target) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → ${target.name}` : `  ⚠️ ${r.status}`);
  } else {
    console.log(`  ⚠️ ${key}: no matching transition found. Available: ${(JSON.parse(tr.body).transitions || []).map(t=>t.name).join(', ')}`);
  }
}
