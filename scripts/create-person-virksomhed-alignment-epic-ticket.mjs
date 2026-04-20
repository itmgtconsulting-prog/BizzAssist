#!/usr/bin/env node
/**
 * Creates a consolidated JIRA ticket for full alignment of person vs.
 * virksomhed detail pages (Diagram-tab + Ejendomme-tab).
 *
 * Dette er en paraply-ticket der dækker BIZZ-594 + 595 + 596 via en samlet
 * 3-fase plan: backend-symmetri, delt UI-komponent, person-diagram fix.
 *
 * Run: node scripts/create-person-virksomhed-alignment-epic-ticket.mjs
 */

import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'BIZZ';

if (!EMAIL || !TOKEN) {
  console.error('Missing JIRA_EMAIL or JIRA_API_TOKEN in .env.local');
  process.exit(1);
}

const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const p = (...nodes) => ({
  type: 'paragraph',
  content: nodes.map((n) => (typeof n === 'string' ? { type: 'text', text: n } : n)),
});
const h = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
  })),
});
const ordered = (items) => ({
  type: 'orderedList',
  content: items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
  })),
});
const code = (text, lang = 'typescript') => ({
  type: 'codeBlock',
  attrs: { language: lang },
  content: [{ type: 'text', text }],
});

const description = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'Baggrund'),
    p(
      'Person-detaljesiden er ikke alignet med virksomhedsdetaljesiden på hverken Diagram- eller Ejendomme-tabben. Analyse 2026-04-20 afdækkede at de bruger delvist separat kode selvom 80% er identisk funktionalitet. Denne paraply-ticket dækker den samlede refactor der løser BIZZ-594, BIZZ-595 og BIZZ-596 på én gang.'
    ),
    h(2, 'Gap-analyse (observeret)'),
    bullets([
      'Diagram: person-diagram bruger buildPersonDiagramGraph() separat fra virksomhedens buildDiagramGraph() — drift risiko',
      'Diagram: person-diagram bygger graf INLINE hver render (ingen useMemo) → D3-simulering kører constantly',
      'Diagram: person-diagram inkluderer IKKE bulk-data (person-properties) → personens egne ejendomme vises ikke på hans eget diagram',
      'Ejendomme: person-tab mangler kompleks-gruppering (ejerlejligheder ser dårligt ud)',
      'Ejendomme: person-tab bruger per-kort enrichment (N+1 API calls) frem for batch (preEnrichedByBfe)',
      'Ejendomme: person-tab viser ikke personligt ejede ejendomme fra ejf_ejerskab',
      'API: /api/ejendomme-by-owner returnerer ejerandel for CVR-queries men IKKE for enhedsNummer-queries (asymmetri)',
      'API: /api/ejerskab/person-properties returnerer kun { bfes[] } — ikke ejerandel/virkning_fra',
      'UI: Kamillas 50%-ejerskab af Søbyvej 11 vises forkert pga. hardcoded 100% på bulk-data edges (BIZZ-585)',
    ]),
    h(2, 'Løsning — 3 faser'),
    h(3, 'Fase 1 — Backend-symmetri'),
    p('Gør API-overfladen identisk for CVR- og person-queries:'),
    ordered([
      'Udvid /api/ejerskab/person-properties til at returnere { bfe, ejerandel_taeller, ejerandel_naevner, virkning_fra, status } per BFE (ikke bare bfes[])',
      'Tilføj ejerandel-ekstraktion i /api/ejendomme-by-owner hentBfeByPerson() — samme map-logik som hentBfeByCvr() bruger i dag',
      'Backward compat: behold bfes[]-feltet i person-properties response så eksisterende klienter ikke breakes; tilføj properties[]-felt med de rige data',
    ]),
    h(3, 'Fase 2 — Delt UI-komponent'),
    p(
      'Udtræk app/components/ejendomme/EjendommeTabs.tsx som fælles komponent brugt af både person- og virksomheds-detaljesider:'
    ),
    code(
      `interface EjendommeTabsProps {
  mode: 'cvr' | 'person';
  ownerId: string;              // CVR eller enhedsNummer
  ejendommeData: EjendomSummary[];
  ejendommeLoading: boolean;
  ejendommeFetchComplete: boolean;
  visSolgte: boolean;
  setVisSolgte: (v: boolean) => void;
  preEnrichedByBfe?: Map<number, EnrichedFields>;
  filterChips?: FilterChip[];   // optional, kun person har (BIZZ-399)
  lang: 'da' | 'en';
}`
    ),
    p('Intern logik:'),
    bullets([
      'Grouping by CVR + kompleks-gruppering per adresse (BIZZ-461)',
      'Progressive enrichment via preEnriched-prop eller per-kort fallback',
      'Sold/active toggle',
      'Filter chips (hvis prop givet)',
      'Empty states for missing keys/access',
    ]),
    p(
      'Virksomhedsside og personside reducerer til thin wrappers der henter data og passer til EjendommeTabs.'
    ),
    h(3, 'Fase 3 — Person-diagram fix'),
    ordered([
      'Wrap diagramGraph i useMemo i PersonDetailPageClient.tsx (samme pattern som VirksomhedDetaljeClient.tsx linje 540-573)',
      'Auto-kald expandPersonDynamic for root-node ved mount når person har enhedsNummer — matcher forventning om at personens ejendomme vises uden manuel Udvid-klik',
      'Brug udvidet API-response til at sætte korrekt ejerandel på kanterne (fix BIZZ-585 hardcoded 100%)',
      'Fjern buildPersonDiagramGraph alternativt, eller saml det med buildDiagramGraph i en unified builder der håndterer både company-rooted og person-rooted grafer',
    ]),
    h(2, 'Tickets der dækkes af denne refactor'),
    bullets([
      'BIZZ-594 — person-diagram: ejendomme mangler + forkert ejerandel for Kamilla',
      'BIZZ-595 — person-Ejendomme-tab: personligt ejede ejendomme vises ikke',
      'BIZZ-596 — person-Ejendomme: align datafelter + funktionalitet med virksomhedsfanen',
    ]),
    p('Når denne ticket er done, kan BIZZ-594/595/596 lukkes som duplicates.'),
    h(2, 'Acceptance criteria'),
    bullets([
      'Person-diagram for Jakob viser alle 9 gældende personligt ejede ejendomme uden manuel Udvid (inkl. Søbyvej 11)',
      'Kanterne på person→ejendom viser korrekt ejerandel (50% på Søbyvej 11 for Jakob, 50% for Kamilla)',
      'Person-Ejendomme-tab har identisk layout + funktionalitet som virksomheds-tab (side-by-side visuel sammenligning viser ingen forskel udover badges for "personligt ejet")',
      'Progressive enrichment (areal, vurdering) fungerer på begge via batch-endpoint',
      'Kompleks-gruppering (ejerlejligheder) virker på person-siden',
      'Ingen regression på virksomhedssiden',
      'Ingen duplikering af UI-logik mellem person- og virksomhedskode',
    ]),
    h(2, 'Teststrategi'),
    bullets([
      'Unit: EjendommeTabs-komponent med begge modes',
      'Integration: person-properties returnerer rich data, ejendomme-by-owner symmetric ejerandel',
      'E2E (Playwright): naviger til Jakob → Diagram → alle 9 BFEs synlige, Søbyvej 11 viser 50%',
      'E2E: naviger til Jakob → Ejendomme-tab → alle 9 personligt ejede + virksomhedsejede synlige',
      'E2E: naviger til JAJR Ejendomme 2 ApS → Ejendomme-tab → 3 ejendomme synlige (ingen regression)',
      'Visuel: sammenlign screenshots side-by-side',
    ]),
    h(2, 'Estimat'),
    bullets([
      'Fase 1 (backend): S — 2-4 timer',
      'Fase 2 (refactor): L — 1-2 dage',
      'Fase 3 (diagram): M — 4-8 timer',
      'Test + fix: M — 4-8 timer',
      'Samlet: M-L — 2-3 dages arbejde',
    ]),
    h(2, 'Referencer'),
    bullets([
      'app/dashboard/companies/[cvr]/VirksomhedDetaljeClient.tsx — reference-impl (linje 540-573, 2425-2725)',
      'app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx — person-variant (linje 1974-2014, 2017-2280+)',
      'app/components/diagrams/DiagramData.ts — buildDiagramGraph + buildPersonDiagramGraph',
      'app/api/ejerskab/person-properties/route.ts — skal udvides',
      'app/api/ejendomme-by-owner/route.ts — skal udvides i hentBfeByPerson()',
      'PropertyOwnerCard.tsx — allerede fælles, genbruges',
    ]),
  ],
};

const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary: 'Align person- og virksomheds-detaljesider (Diagram + Ejendomme) — refactor',
    description,
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    labels: ['refactor', 'person', 'virksomhed', 'alignment', 'diagram', 'ejendomme', 'paraply'],
  },
};

const created = await req('POST', '/rest/api/3/issue', payload);
if (created.status !== 201) {
  console.error('Create failed:', created.status, created.body);
  process.exit(1);
}
const key = JSON.parse(created.body).key;
console.log(`Created: ${key}`);
console.log(`\nDone: https://${HOST}/browse/${key}`);
