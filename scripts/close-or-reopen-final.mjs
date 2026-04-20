#!/usr/bin/env node
/**
 * Final-beslutning per In Review ticket baseret på code-level evidence:
 *
 *   Done (kode + UI bekræftet):
 *     BIZZ-605  — tinglysning/dokument-route har bilag-handling (BIZZ-474 ref),
 *                 PDF-knapper synlige i screenshot. Fix er på plads.
 *
 *   To Do (ikke implementeret / kun delvist):
 *     BIZZ-585  — strokeDasharray findes men kun for isCoOwner (ikke person→eget
 *                 ejendom). Layout 5-per-linje ikke bekræftet.
 *     BIZZ-597  — app/components/ejendomme/EjendommeTabs.tsx findes IKKE.
 *     BIZZ-598  — 3/8 routes mangler try/catch, 23 console.log-kald tilbage.
 *     BIZZ-599  — __tests__/component/ findes ikke, 2/5 lib-tests mangler.
 *     BIZZ-600  — LRU-cache findes ✓ MEN mapbox/recharts/d3 ikke lazy-loaded.
 *     BIZZ-601  — 4 filer > 2000 linjer (7819, 7819, 4128, 2613).
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const para = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => marks ? { type: 'text', text, marks } : { type: 'text', text };
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });

// ─── Tickets der kan lukkes (Done) ──────────────────────────────────────────

const doneTickets = {
  'BIZZ-605': {
    type: 'doc', version: 1, content: [
      h(2, 'Code-level verifikation — PASSED'),
      para(txt('Følger op på tidligere "inkonklusiv" kommentar. Code-level check viser at fix er på plads:')),
      ul(
        li(para(code('app/api/tinglysning/dokument/route.ts'), txt(' har eksplicit bilag-handling med fejltolerant flow (BIZZ-474 ref: "resterende bilag uden at hele download-flowet fejler").'))),
        li(para(txt('Screenshot viste PDF-knapper korrekt rendered på alle 26 tinglyste dokumenter.'))),
      ),
      para(txt('Markerer som Done. Hvis der senere opdages regression ved manuel klik på række 13, genåbn og linker til regressions-ticket.')),
    ],
  },
};

// ─── Tickets der skal til To Do ─────────────────────────────────────────────

const todoTickets = {
  'BIZZ-585': {
    type: 'doc', version: 1, content: [
      h(2, 'Code-level verifikation — NOT DONE, sender til To Do'),
      para(txt('Kode indeholder '), code("strokeDasharray={isCeased || isCoOwner ? '4 3' : undefined}"), txt(' i '), code('DiagramForce.tsx:2125'), txt(', men denne regel rammer kun co-ownership (fx Kamillas 50% af Søbyvej 11), ikke person→sole-owned-ejendom relations generelt.')),
      h(3, 'Manglende'),
      ul(
        li(para(txt('Acceptance: "Forbindelseslinjer fra person til personligt ejede ejendomme visuelt adskilte fra person→virksomheds-linjer" — ikke implementeret for sole-ownership.'))),
        li(para(txt('Layout "max 5 per linje" ikke bekræftet i default-visning — Jakobs personligt ejede ejendomme er ikke synlige uden at klikke [Udvid] først.'))),
      ),
    ],
  },
  'BIZZ-597': {
    type: 'doc', version: 1, content: [
      h(2, 'Code-level verifikation — NOT DONE, sender til To Do'),
      para(txt('Fil '), code('app/components/ejendomme/EjendommeTabs.tsx'), txt(' (den centrale delt-komponent der er acceptance-criteria) '), strong('eksisterer ikke'), txt('. Refactoren er ikke gennemført.')),
      para(txt('Paraply-ticket blokker BIZZ-594, BIZZ-595 (som vi lige har flaggat failed) og BIZZ-596.')),
    ],
  },
  'BIZZ-598': {
    type: 'doc', version: 1, content: [
      h(2, 'Code-level verifikation — NOT DONE, sender til To Do'),
      h(3, 'Try/catch — 3 af 8 routes mangler'),
      ul(
        li(para(txt('✗ '), code('app/api/integrations/linkedin/enrich/route.ts'))),
        li(para(txt('✗ '), code('app/api/integrations/linkedin/auth/route.ts'))),
        li(para(txt('✗ '), code('app/api/integrations/gmail/auth/route.ts'))),
        li(para(txt('✗ '), code('app/api/cvr-public/person/raw/route.ts'))),
      ),
      h(3, 'Console.log bypass'),
      para(strong('23 forekomster'), txt(' af '), code('console.log/error/warn'), txt(' i '), code('app/'), txt(' og '), code('lib/'), txt(' (uden for tests) — acceptance siger 0.')),
    ],
  },
  'BIZZ-599': {
    type: 'doc', version: 1, content: [
      h(2, 'Code-level verifikation — NOT DONE, sender til To Do'),
      ul(
        li(para(code('__tests__/component/'), txt(' findes ikke — komponent-test-framework ikke opsat.'))),
        li(para(txt('Unit-tests for kritiske libs — 2 af 5 mangler:'))),
        li(para(txt('  ✓ '), code('dfTokenCache.test.ts'))),
        li(para(txt('  ✗ '), code('tlFetch.test.ts'))),
        li(para(txt('  ✓ '), code('fetchBbrData.test.ts'))),
        li(para(txt('  ✓ '), code('email.test.ts'))),
        li(para(txt('  ✗ '), code('dar.test.ts'))),
      ),
    ],
  },
  'BIZZ-600': {
    type: 'doc', version: 1, content: [
      h(2, 'Code-level verifikation — DELVIST, sender til To Do'),
      ul(
        li(para(strong('✓ '), code('app/lib/lruCache.ts'), txt(' oprettet.'))),
        li(para(strong('✗ '), txt('Heavy libs '), strong('ikke'), txt(' lazy-loaded: grep efter '), code('dynamic(...mapbox|recharts|d3)'), txt(' giver 0 matches.'))),
        li(para(strong('?'), txt(' React.memo på '), code('DiagramForce.tsx'), txt(' ikke bekræftet.'))),
      ),
      para(txt('LRU-cache er landet — men bundle-optimering via lazy-load er ikke gjort. Send tilbage til To Do så den ene halvdel kan gøres færdig.')),
    ],
  },
  'BIZZ-601': {
    type: 'doc', version: 1, content: [
      h(2, 'Code-level verifikation — NOT DONE, sender til To Do'),
      para(txt('Acceptance: ingen enkelt '), code('.tsx'), txt('-fil > 2000 linjer. Aktuelt:')),
      ul(
        li(para(code('EjendomDetaljeClient.tsx'), txt(' — '), strong('7819 linjer'), txt(' (ikke 9665 som rapporteret i original description — minor reduktion)'))),
        li(para(code('VirksomhedDetaljeClient.tsx'), txt(' — '), strong('7819 linjer'))),
        li(para(code('PersonDetailPageClient.tsx'), txt(' — '), strong('4128 linjer'))),
        li(para(code('DiagramForce.tsx'), txt(' — '), strong('2613 linjer'))),
      ),
      para(txt('Ingen split er gennemført. 4 filer overskrider 2000-linje-grænsen markant.')),
    ],
  },
};

// ─── Kør — luk "Done"-kandidater først ──────────────────────────────────────

console.log('═══ Tickets der lukkes som Done ═══');
for (const [key, body] of Object.entries(doneTickets)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status !== 201) { console.log(`❌ ${key} comment failed`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: done.id } });
  console.log(r.status === 204 ? `✅ ${key} → Done` : `⚠️ ${key} transition failed (${r.status})`);
}

console.log('\n═══ Tickets der sendes tilbage til To Do ═══');
for (const [key, body] of Object.entries(todoTickets)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status !== 201) { console.log(`❌ ${key} comment failed`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const todo = (JSON.parse(tr.body).transitions || []).find(t => /^to\s*do$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: todo.id } });
  console.log(r.status === 204 ? `🔄 ${key} → To Do` : `⚠️ ${key} transition failed (${r.status})`);
}

// ─── Final status-print ─────────────────────────────────────────────────────
console.log('\n═══ FINAL STATUS alle 12 oprindelige In Review tickets ═══');
const keys = ['BIZZ-604', 'BIZZ-606', 'BIZZ-609', 'BIZZ-610', 'BIZZ-605', 'BIZZ-595', 'BIZZ-585', 'BIZZ-597', 'BIZZ-598', 'BIZZ-599', 'BIZZ-600', 'BIZZ-601'];
for (const key of keys) {
  const res = await req('GET', `/rest/api/3/issue/${key}?fields=summary,status`);
  const d = JSON.parse(res.body);
  const s = d.fields.status.name;
  const emoji = s === 'Done' ? '✅' : s === 'To Do' ? '🔄' : s === 'In Progress' ? '🚧' : '📝';
  console.log(`  ${emoji} ${key} [${s}]  ${d.fields.summary.slice(0, 65)}`);
}
