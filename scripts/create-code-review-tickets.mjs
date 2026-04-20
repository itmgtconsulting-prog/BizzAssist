#!/usr/bin/env node
/**
 * Creates multiple JIRA tickets from 2026-04-20 security/code/test review.
 *
 * Security + ISO 27001 review: NO gaps found (excellent posture).
 * Code quality + test coverage: 6 actionable bodies of work identified.
 *
 * Run: node scripts/create-code-review-tickets.mjs
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

// ADF helpers
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

const tickets = [
  {
    summary: 'API hardening: try/catch + erstat console.log med logger + fjern any-typer',
    priority: 'High',
    labels: ['code-quality', 'security', 'hardening'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          'Code review 2026-04-20 fandt tre relaterede hardening-opgaver der bør samles i én PR da de rører samme filer: (1) 10 API-ruter mangler eksplicit try/catch omkring external fetches/DB-kald, (2) 7 steder i prod-kode kalder console.log/error/warn direkte i stedet for app/lib/logger.ts, (3) 12 forekomster af : any eller as any uden dokumenteret begrundelse.'
        ),
        h(2, '1. Try/catch mangler (HIGH)'),
        p(
          'Produktions-ruter der har external fetches eller DB-writes uden try/catch — kaskader exceptions til bruger med rå fejlbesked:'
        ),
        bullets([
          'app/api/admin/support-analytics/route.ts',
          'app/api/ejendom/[id]/route.ts',
          'app/api/notification-preferences/route.ts',
          'app/api/integrations/linkedin/enrich/route.ts',
          'app/api/integrations/linkedin/auth/route.ts',
          'app/api/integrations/gmail/auth/route.ts',
          'app/api/link-verification/route.ts',
          'app/api/cvr-public/person/raw/route.ts',
        ]),
        p('Diagnostiske probe-ruter er OK (disabled med 410 Gone).'),
        h(2, '2. console.log bypasser logger (MEDIUM)'),
        bullets([
          'app/lib/apiErrorHandler.ts — console.error i error handler',
          'app/lib/requestLogger.ts — 2× console.log debug',
          'app/api/analysis/run/route.ts — 2× console.error (tool call + SSE)',
          'app/api/links/route.ts — 2× console.error (link verification)',
        ]),
        p('Erstat med logger.error()/logger.log(). Sikr at ingen PII logges (emails, CVR, navn).'),
        h(2, '3. any-typer (MEDIUM)'),
        bullets([
          'app/lib/notifications.ts — 1 occurrence',
          'app/api/ejerskab/person-properties/route.ts — 3 occurrences (OK — Supabase types ikke regeneret post-migration 046)',
          'app/api/ejerskab/person-bridge/route.ts — 1 (samme grund)',
          'app/api/cron/ingest-ejf-bulk/route.ts — 5 (samme grund)',
          'app/api/cron/daily-status/route.ts — 1',
          'app/dashboard/companies/[cvr]/VirksomhedDetaljeClient.tsx — 1',
        ]),
        p(
          'For EJF-relaterede: regenerer Supabase types efter migrations 046-048 er landet i prod, og fjern any-casts. For øvrige: erstat med proper TypeScript interfaces.'
        ),
        h(2, 'Acceptance'),
        bullets([
          'Alle 8 produktions-ruter har try/catch der returnerer \"Ekstern API fejl\" til klienten og logger detaljer til Sentry',
          'Ingen console.log/error/warn calls i app/ og lib/ (undtaget tests)',
          'Alle any-casts enten fjernet eller forklaret med eslint-disable + kommentar',
          'npm test + tsc --noEmit grønne',
        ]),
      ],
    },
  },
  {
    summary: 'Test coverage: komponent-tests + lib-tests for kritiske untested-filer',
    priority: 'High',
    labels: ['test', 'coverage', 'quality'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          'Code review 2026-04-20: nuværende coverage (lines 71.59%, functions 73.78%, branches 55.89%) rammer CLAUDE.md-thresholds, men to kritiske kategorier er helt uden tests.'
        ),
        h(2, '1. Komponent-tests (HIGH — 0 findes i dag)'),
        p(
          'Der findes ingen komponent-tests (kun unit + integration + E2E). Top-prioritet (højest linje-tal, mest adfærd):'
        ),
        bullets([
          'DiagramForce.tsx (2522 linjer) — node positioning, overflow state, expand/collapse, drag persistence',
          'PropertyMap.tsx (1714 linjer) — Mapbox style toggle, matrikel GeoJSON, zoom persistence',
          'DiagramSimple.tsx, DiagramDagre.tsx, DiagramFlow.tsx — diagram-varianter',
          'AIChatPanel.tsx — streaming, error recovery, tool rendering',
          'BugReportModal.tsx, OnboardingModal.tsx, VerifiedLinks.tsx — focus trap, keyboard nav, form validation',
          'SupportChatWidget.tsx, NotifikationsDropdown.tsx — dropdown adfærd',
          'PaategningTimeline.tsx (3.7% coverage)',
        ]),
        h(2, '2. Lib-tests (HIGH — kritiske auth/fetch-filer uden dækning)'),
        bullets([
          'dfTokenCache.ts (84 linjer, 8.69%) — Datafordeler OAuth token caching + refresh',
          'tlFetch.ts (212 linjer, 32.83%) — Tinglysning API proxy med timeout/retry',
          'fetchBbrData.ts (1574 linjer, 48.53%) — BBR data normalization',
          'email.ts (611 linjer, 55.29%) — Resend-transactionals (approval, payment, failed-payment templates)',
          'dar.ts (1658 linjer) — DAR address resolution',
          'dawa.ts, dfCertAuth.ts, dfProxy.ts — netværks-utilities',
          'companyInfo.ts (75%) — CVR-status enum-transitions',
        ]),
        h(2, '3. E2E-coverage (MEDIUM — kun smoke/homepage i dag)'),
        p('Kun 2 E2E-suites findes. Manglende dækning af kernedflows:'),
        bullets([
          '/dashboard (søgning, recent entities)',
          '/dashboard/ejendomme/[id] (property detail — 9665 linjer)',
          '/dashboard/companies/[cvr] (company detail — 7819 linjer)',
          '/dashboard/owners/[enhedsNummer]',
          '/dashboard/kort, /dashboard/compare, /dashboard/settings*',
          '/dashboard/admin/* (user management, plans, support)',
        ]),
        h(2, '4. Stripe webhook edge cases (LOW)'),
        bullets([
          'invoice.payment_action_required (SCA/3D-Secure)',
          'customer.updated (metadata sync)',
          'Signature-verification: expired signature + mangled header',
        ]),
        h(2, 'Acceptance'),
        bullets([
          'Komponent-test-framework opsat (Vitest + @testing-library/react)',
          '__tests__/component/ mappe oprettet med 5 prioriterede komponent-suites',
          '__tests__/unit/ udvidet med de 5 kritiske lib-filer (dfTokenCache, tlFetch, fetchBbrData, email, dar)',
          '__tests__/e2e/ udvidet med dashboard-flow-tests (minimum 3 nye specs)',
          'Branch coverage løftes fra 55.89% til 65%+',
        ]),
      ],
    },
  },
  {
    summary: 'Performance: lazy-load heavy libs (mapbox, recharts, d3) + React.memo + LRU cache',
    priority: 'Medium',
    labels: ['performance', 'bundle', 'optimization'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          'Code review 2026-04-20 fandt tre performance-opgaver: heavy libs er ikke dynamisk importeret, store komponenter re-renderer unødvendigt, og der er ingen LRU-cache for gentagne external API-calls (trods CLAUDE.md-krav).'
        ),
        h(2, '1. Heavy libraries ikke lazy-loaded (MEDIUM)'),
        p(
          'Følgende biblioteker er på kritisk-path trods at de kun bruges i specifikke komponenter:'
        ),
        bullets([
          'mapbox-gl (3.20.0) — kun brugt i PropertyMap.tsx. Skal wrappes i next/dynamic({ ssr: false })',
          'recharts (3.8.0) — CompanySkabChart.tsx (18.75% coverage). Skal lazy-loades',
          'd3-force (3.0.0) — DiagramForce.tsx. Skal lazy-loades',
        ]),
        p('Forventet besparelse: 100-150 KB initial JS bundle, ~300ms hurtigere FCP.'),
        h(2, '2. React.memo manglende (MEDIUM)'),
        bullets([
          'DiagramForce.tsx — eksporteret som plain function, ikke memoiseret. Forældre-renders trigger hele D3-simulering',
          'Verificer øvrige store komponenter (PropertyMap har allerede memo + useCallback)',
          'expandPersonDynamic useCallback har extensionNodes i deps → genoprettes ved hvert state-update. Overvej useRef-pattern',
        ]),
        h(2, '3. LRU-cache mangler (MEDIUM)'),
        p(
          'CLAUDE.md: \"LRU cache (max 150 entries) for repeated external API calls within a session.\" Ingen LRU-impl fundet i app/lib/.'
        ),
        bullets([
          'dar.ts (DAR adresse-lookup) — samme adresser slås typisk op flere gange',
          'dawa.ts (postnr→kommune) — deterministisk input/output, oplagt cache-kandidat',
          'fetchBbrData.ts (BBR field lookup) — pr. adresse-key',
          'fetchEjerskab/salgshistorik — cache pr. BFE',
        ]),
        p(
          'Forslag: lav app/lib/lruCache.ts wrapper (eller brug lru-cache npm pkg) med max 150 entries + TTL.'
        ),
        h(2, '4. N+1 query pattern (MEDIUM)'),
        p(
          'app/api/cvr/[cvr]/route.ts indeholder loop-baseret fetch der bør batch-hentes. Audit samtlige Supabase from().select() calls i loops.'
        ),
        h(2, '5. Event listener cleanup (LOW)'),
        p(
          'PropertyMap.tsx har document.addEventListener(mousedown/touchstart) — verificer cleanup i useEffect return.'
        ),
        h(2, 'Acceptance'),
        bullets([
          'mapbox-gl, recharts, d3-force alle lazy-loaded via next/dynamic',
          'npm run build viser initial bundle reduceret med 100KB+',
          'DiagramForce.tsx wrappet i React.memo',
          'app/lib/lruCache.ts oprettet og brugt i min. 3 external API-wrappers',
          'Potentielle N+1 queries audited + batch-refaktoreret',
          'PropertyMap.tsx event cleanup verificeret',
        ]),
      ],
    },
  },
  {
    summary: 'Refactor: split oversized components (>1500 linjer) i subcomponents',
    priority: 'Medium',
    labels: ['refactor', 'code-quality', 'maintainability'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          'Code review 2026-04-20: 10 .tsx-filer er >1500 linjer. De bremser HMR, gør kode-review svær, og skaber merge-konflikter. BIZZ-597 (person/virksomhed alignment) vil naturligt reducere nogle af dem via delt EjendommeTabs-komponent.'
        ),
        h(2, 'Top 10 store filer'),
        bullets([
          'app/dashboard/ejendomme/[id]/EjendomDetaljeClient.tsx — 9665 linjer',
          'app/dashboard/companies/[cvr]/VirksomhedDetaljeClient.tsx — 7819 linjer',
          'app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx — 3895 linjer',
          'app/components/diagrams/DiagramForce.tsx — 2522 linjer',
          'app/dashboard/kort/KortPageClient.tsx — 1889 linjer',
          'app/dashboard/settings/SettingsPageClient.tsx — 1758 linjer',
          'app/components/ejendomme/PropertyMap.tsx — 1714 linjer',
          'app/dashboard/admin/plans/PlansClient.tsx — 1683 linjer',
          'app/dashboard/layout.tsx — 1564 linjer',
          'app/dashboard/admin/users/UsersClient.tsx — 1529 linjer',
        ]),
        h(2, 'Strategi per top-3'),
        p('EjendomDetaljeClient.tsx (9665) — split per tab:'),
        bullets([
          'EjendomOverblikTab.tsx, EjendomBBRTab.tsx, EjendomEjerforholdTab.tsx',
          'EjendomOekonomiTab.tsx, EjendomSKATTab.tsx, EjendomTinglysningTab.tsx, EjendomDokumenterTab.tsx',
          'Share state via useContext eller lift til page-level',
        ]),
        p('VirksomhedDetaljeClient.tsx (7819) — lignende tab-split'),
        p(
          'DiagramForce.tsx (2522) — split i DiagramCanvas, NodeRenderer, PhysicsEngine, expandPersonDynamic extract til useExpandPerson hook'
        ),
        h(2, 'Acceptance'),
        bullets([
          'Ingen enkelt .tsx-fil > 2000 linjer',
          'Ingen regression (alle E2E + unit tests grønne)',
          'HMR-speed målbart forbedret (dev-server reload < 2s)',
          'PR kan reviewes i rimelig tid (ikke monolitisk)',
        ]),
        h(2, 'Afhængigheder'),
        p(
          'Afvent BIZZ-597 (person/virksomhed alignment) først — den reducerer naturligt person-client og etablerer delte tab-components som pattern.'
        ),
      ],
    },
  },
  {
    summary: 'npm audit: fix moderate CVE (protocol-buffers-schema prototype pollution)',
    priority: 'Low',
    labels: ['security', 'dependencies'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          'npm audit viser 1 moderate vulnerability: protocol-buffers-schema < 3.6.1 (prototype pollution). Ingen high/critical CVEs.'
        ),
        h(2, 'Opgave'),
        bullets([
          'Kør npm audit fix og verificer at package-lock.json opdateres',
          'Alternativt: overrides i package.json hvis den transitive dep ikke kan opdateres direkte',
          'Kør npm test + npm run build for at sikre ingen regressioner',
          'Dokumentér resolution i docs/security/ hvis relevant',
        ]),
        h(2, 'Acceptance'),
        bullets([
          'npm audit rapporterer 0 moderate/high/critical CVEs',
          'CI build grøn',
          'package.json + package-lock.json committet',
        ]),
      ],
    },
  },
  {
    summary: 'Tilføj loading.tsx skeleton til /dashboard/pvoplys',
    priority: 'Low',
    labels: ['ux', 'loading'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          'Code review 2026-04-20: /dashboard/pvoplys er eneste dashboard-rute uden sibling loading.tsx. CLAUDE.md kræver loading skeleton på alle dashboard-ruter.'
        ),
        h(2, 'Opgave'),
        bullets([
          'Opret app/dashboard/pvoplys/loading.tsx',
          'Match stilen fra andre dashboard-loading-skeletons (fx app/dashboard/ejendomme/loading.tsx)',
          'Dark theme, bilingual ikke påkrævet (skeleton er visuelt)',
        ]),
        h(2, 'Acceptance'),
        bullets([
          'app/dashboard/pvoplys/loading.tsx eksisterer',
          'Skeleton matcher visuelt med øvrige dashboard-ruter',
          'Ingen layout-shift ved navigation',
        ]),
      ],
    },
  },
];

// Create all tickets
console.log(`Creating ${tickets.length} tickets...\n`);
const created = [];
for (const t of tickets) {
  const payload = {
    fields: {
      project: { key: PROJECT_KEY },
      summary: t.summary,
      description: t.description,
      issuetype: { name: 'Task' },
      priority: { name: t.priority },
      labels: t.labels,
    },
  };
  const res = await req('POST', '/rest/api/3/issue', payload);
  if (res.status !== 201) {
    console.error(`FAIL: ${t.summary}`);
    console.error('  →', res.status, res.body.slice(0, 200));
    continue;
  }
  const key = JSON.parse(res.body).key;
  created.push({ key, summary: t.summary });
  console.log(`✓ ${key} — ${t.summary}`);
}

console.log(`\nCreated ${created.length}/${tickets.length} tickets.`);
for (const c of created) {
  console.log(`  https://${HOST}/browse/${c.key}`);
}
