#!/usr/bin/env node
/**
 * Poster verifikations-kommentarer på de resterende In Review tickets:
 *   BIZZ-595  FEJL: Ejendomme-tab viser "Kommer snart" — ikke implementeret
 *   BIZZ-605  Inkonklusiv: PDF-buttons findes men Playwright-selektor fandt kun 2 af 26
 *   BIZZ-585  Inkonklusiv: Diagram viser virksomheds-chain, men Jakobs personlige ejendomme
 *             ikke synlige uden at klikke "Udvid" først
 *   BIZZ-597  Code-review-ticket — ikke browser-verificérbar (paraply-refactor)
 *   BIZZ-598  Code-review — try/catch + logger + any-typer (ikke browser-verificérbar)
 *   BIZZ-599  Code-review — test coverage (kræver npm test:coverage)
 *   BIZZ-600  Code-review — lazy-load + memo + LRU cache (kræver bundle-analyse)
 *   BIZZ-601  Code-review — split oversized components (kræver filstørrelse-check)
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
const em = (s) => txt(s, [{ type: 'em' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });

const comments = {
  'BIZZ-595': {
    type: 'doc', version: 1, content: [
      h(2, 'Playwright-verifikation 2026-04-20 — FAILED'),
      para(strong('Bug ikke løst. '), txt('På Jakob Juul Rasmussens person-side (/dashboard/owners/4000115446) under Ejendomme-tabben vises stadig placeholder-teksten '), code('"Kommer snart"'), txt(' i stedet for de 9 personligt ejede ejendomme.')),
      h(3, 'Observeret'),
      ul(
        li(para(txt('Tab "Ejendomme" er highlighted, men indholdet viser Oversigts-layoutet med "Ejerandele", "Bestyrelse", "Direktion", "Stifter/andre" — og en "Ejendomme — Kommer snart"-sektion.'))),
        li(para(txt('Ingen af de 9 kendte personligt ejede adresser (Søbyvej 11, Vigerslevvej 146, H C Møllersvej 21, Horsekildevej 26, Hovager 8, m.fl.) er synlige.'))),
      ),
      h(3, 'Evidence'),
      ul(li(para(txt('Screenshot: '), code('/tmp/verify-screenshots/bizz-595-v2-ejendomme-tab.png'))))    ,
      h(3, 'Status'),
      para(txt('Ticket forbliver '), strong('In Review'), txt(' — bør sendes tilbage til "In Progress" eller "To Do". Implementation på test.bizzassist.dk er ikke fuldført.')),
    ],
  },
  'BIZZ-605': {
    type: 'doc', version: 1, content: [
      h(2, 'Playwright-verifikation 2026-04-20 — INKONKLUSIV'),
      para(txt('På '), code('/dashboard/ejendomme/dd4a90de-b126-4438-824f-3677efab2bd0'), txt(' (Thorvald Bindesbølls Plads 18, 3. th) → Tinglysning-tab.')),
      h(3, 'Hvad screenshot viser'),
      ul(
        li(para(txt('Tinglyste dokumenter-tabel renderer med 1 Adkomst (Skøde), 2 Hæftelser (Anden hæftelse, Realkreditpantebrev), og 23 Servitutter.'))),
        li(para(txt('PDF-knapper er synlige som orange pille-badges ved hver række.'))),
      ),
      h(3, 'Hvad Playwright ikke kunne gøre'),
      ul(
        li(para(txt('Playwright-selektoren fandt kun 2 af de ~26 PDF-links — knapperne er sandsynligvis '), code('<button>'), txt('-elementer med '), code('onClick={() => window.open(...)}'), txt(' (ikke '), code('<a href>'), txt('), hvilket selektoren ikke matchede.'))),
        li(para(txt('Kunne derfor ikke klikke præcist på række 13 og tælle antal åbnede faner — hovedacceptance-kriteriet.'))),
      ),
      h(3, 'Anbefaling'),
      para(txt('Manuel verifikation af 2 minutter: åbn siden, klik PDF på '), code('SERVITUT-række 13 "DEKLARATION OM TILSLUTNINGS..."'), txt(' og tæl antal åbnede faner. Forventet: 1 (hoveddok). Før fix: 3 (hoveddok + 2 bilag).')),
      h(3, 'Evidence'),
      ul(li(para(txt('Screenshot: '), code('/tmp/verify-screenshots/bizz-605-tinglysning-tab.png'))))    ,
    ],
  },
  'BIZZ-585': {
    type: 'doc', version: 1, content: [
      h(2, 'Playwright-verifikation 2026-04-20 — INKONKLUSIV'),
      para(txt('JaJR Holding ApS → Diagram. Diagrammet renderes korrekt med virksomheds-hierarki (Jakob → JaJR Holding ApS → datterselskaber). MEN:')),
      h(3, 'Det der mangler i default-visning'),
      ul(
        li(para(txt('Jakob Juul Rasmussen-noden har kun '), strong('én'), txt(' udgående edge (til JaJR Holding ApS) — ingen "separat linje" med personligt ejede ejendomme er synlig i default.'))),
        li(para(txt('Der er 0 stiplede edges i hele diagrammet — hele kravet om "stiplede emerald-linjer til person→ejendom-relationer" er ikke synligt.'))),
      ),
      h(3, 'Hypotese'),
      para(txt('Personligt ejede ejendomme kræver sandsynligvis klik på '), code('[Udvid]'), txt('-knap på Jakobs node først. Hvis det er design-intent, er ticketet OK — men ticketets acceptance-criteria siger '), em('"placeres på separat linje under personen"'), txt(' uden forbehold om klik, så default-renderingen bør vise dem.')),
      h(3, 'Anbefaling'),
      para(txt('Manuel verifikation: åbn JaJR Holding → Diagram. Klik '), code('[Udvid]'), txt(' på Jakobs node. Forventet: 1-2 rækker med 5+1 ejendomme + stiplede emerald-linjer + ejerandel-labels (100%, 50% osv.) på hver linje.')),
      h(3, 'Evidence'),
      ul(li(para(txt('Screenshot: '), code('/tmp/verify-screenshots/bizz-585-v3-diagram.png'))))    ,
    ],
  },
  'BIZZ-597': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikations-note 2026-04-20 — ikke browser-verificérbar'),
      para(strong('Paraply-refactor-ticket. '), txt('Dækker 3+ sammenflettede arbejdsstrømme (Backend API-symmetri, delt '), code('EjendommeTabs.tsx'), txt('-komponent, alignment-fix af tabs). Kan ikke verificeres med ét browser-scenarie — kræver kode-review af diff.')),
      para(txt('Delelementerne (BIZZ-594, BIZZ-595, BIZZ-596) bør verificeres individuelt. BIZZ-595 er netop flagged som failed i separat kommentar. BIZZ-594/596 verificeres bedst som del af deres egne tickets.')),
      h(3, 'Anbefalet verifikations-procedure'),
      ul(
        li(para(txt('Kode-review PR'))),
        li(para(code('npm test'), txt(' + '), code('tsc --noEmit'), txt(' grønne'))),
        li(para(txt('Spot-check: både virksomhed- og person-siden renderer Ejendomme-tabben med identisk layout (per BIZZ-580 pattern)'))),
      ),
    ],
  },
  'BIZZ-598': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikations-note 2026-04-20 — ikke direkte browser-verificérbar'),
      para(txt('Code-review-ticket: try/catch i 8 routes, erstat console.log med logger, fjern any-typer. Verifikation kræver:')),
      ul(
        li(para(code('grep -r "console.log\\|console.error\\|console.warn" app/ lib/'), txt(' → 0 matches (uden for __tests__)'))),
        li(para(code('grep -r ": any\\|as any" app/ lib/'), txt(' → alle matches har '), code('eslint-disable-line'), txt('-kommentar med begrundelse'))),
        li(para(txt('Manuel browser-test af de 8 berørte routes: '), code('/api/admin/support-analytics'), txt(', '), code('/api/ejendom/[id]'), txt(', '), code('/api/link-verification'), txt(', osv. — tjek at de returnerer '), code('"Ekstern API fejl"'), txt(' ved fejl, ikke stack-trace.'))),
        li(para(code('npm test'), txt(' + '), code('tsc --noEmit'), txt(' grønne'))),
      ),
    ],
  },
  'BIZZ-599': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikations-note 2026-04-20 — ikke browser-verificérbar'),
      para(txt('Test coverage-ticket. Ingen UI-ændring. Verificeres med:')),
      ul(
        li(para(code('npm run test:coverage'))),
        li(para(txt('Forventet: branch-coverage ≥ 65% (op fra 55.89% baseline).'))),
        li(para(txt('Forventet: nye test-filer i '), code('__tests__/component/'), txt(' (komponent-tests) + '), code('__tests__/unit/'), txt(' (dfTokenCache, tlFetch, fetchBbrData, email, dar).'))),
      ),
    ],
  },
  'BIZZ-600': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikations-note 2026-04-20 — delvist browser-verificérbar (Network-tab)'),
      para(txt('Performance-ticket. Kan delvist verificeres i browser via DevTools:')),
      ul(
        li(para(txt('DevTools → Network → Filter: JS. Først-load bundle-size bør være ~100 KB+ mindre end før (mapbox, recharts, d3 lazy-loaded).'))),
        li(para(txt('Åbn '), code('/dashboard/kort'), txt(' — check at mapbox-gl først loades efter navigation til kort.'))),
        li(para(txt('LRU-cache: søg samme CVR/adresse to gange og verificér at andet kald er hurtigt (cache-hit).'))),
        li(para(code('npm run build'), txt(' → bundle-rapport viser reduceret first-load JS.'))),
      ),
      para(em('Ikke inkluderet i denne Playwright-batch — skal verificeres manuelt med DevTools + build-output.')),
    ],
  },
  'BIZZ-601': {
    type: 'doc', version: 1, content: [
      h(2, 'Verifikations-note 2026-04-20 — ikke browser-verificérbar'),
      para(txt('Refactor-ticket — split store komponenter. Verificeres med:')),
      ul(
        li(para(code('find app -name "*.tsx" | xargs wc -l | sort -rn | head -20'), txt(' → ingen enkelt fil > 2000 linjer'))),
        li(para(txt('HMR-speed: dev-server reload af '), code('/dashboard/ejendomme/[id]'), txt(' bør være ~1-2s (< 2s target)'))),
        li(para(code('npm test'), txt(' + '), code('npm run test:e2e'), txt(' grønne — ingen regression'))),
      ),
    ],
  },
};

for (const [key, body] of Object.entries(comments)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(c.status === 201 ? `✅ ${key} comment posted` : `❌ ${key} failed (${c.status}): ${c.body.slice(0, 200)}`);
}
