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
  p(strong('Iter 1 shipped — resizable fullheight panel + default open')),
  ul(
    li(p(strong('Fullheight:'), txt(' panel-aside er allerede placeret indenfor '), code('flex-1 flex min-h-0'), txt(' container der fylder fra tab-bar til viewport-bund. Aside har '), code('overflow-y-auto'), txt(' så lange filter-lister scrollér i panelet, ikke i main content.'))),
    li(p(strong('Resizable divider:'), txt(' ny komponent '), code('app/components/ResizableDivider.tsx'), txt(' — pointer-capture drag-handle med '), code('role="separator"'), txt(' + '), code('aria-orientation="vertical"'), txt(' + '), code('aria-valuenow/min/max'), txt('. Clamp 280-600px, default 360px. Kan genbruges til BIZZ-773 split-view.'))),
    li(p(strong('Default open:'), txt(' første gang man lander på /dashboard/search er panelet åbent. Bruger kan lukke (ny chevron-right knap i panel-header) eller trække divider. Begge præferencer persisteres til localStorage.'))),
    li(p(strong('CLAUDE.md:'), txt(' '), code('bizzassist-search-filters-open'), txt(' + '), code('bizzassist-search-filter-width'), txt(' tilføjet til godkendt-tabellen med justifikation (per-device layout).'))),
  ),
  p(strong('Iter 2 scope (parkeret — hver kan være egen ticket):')),
  ul(
    li(p(code('BIZZ-786a'), txt(' — Mobile bottom-sheet: ved viewport < 768px renderer panelet som bund-sheet i stedet for side-panel. Floating "Filtre"-knap åbner, tap-outside lukker.'))),
    li(p(code('BIZZ-786b'), txt(' — Keyboard-støtte på divider: '), code('ArrowLeft/Right'), txt(' justerer bredde ±10px, '), code('Home/End'), txt(' går til min/max. '), code('tabIndex={0}'), txt(' (er pt. -1 pga. peg-primary workflow).'))),
    li(p(code('BIZZ-786c'), txt(' — Collapsed-state rail: smal (32px) vertikal bar langs højre kant med roteret "Filtre"-label når '), code('filterOpen=false'), txt('. Klik re-åbner.'))),
    li(p(code('BIZZ-786d'), txt(' — Smooth animation: '), code('transition-[width]'), txt(' på open/close (150ms) + fade-in/out på panel-indhold.'))),
  ),
  p(strong('Commit: '), code('3d1b835'), txt('. Tests 1640/1654 grønne. '), strong('→ In Review (iter 1).')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-786/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status} ${cr.body}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-786/transitions');
const t = (JSON.parse(tr.body).transitions || []).find(x => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-786/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ → In Review' : `⚠️ ${r.status}`);
}
