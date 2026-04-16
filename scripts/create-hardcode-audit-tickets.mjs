/**
 * Creates JIRA tickets for hardcoded values audit findings.
 * Each ticket covers a category of hardcoded values that should be
 * configurable — functional values must be manageable via admin frontend.
 *
 * Run: JIRA_API_TOKEN=xxx node scripts/create-hardcode-audit-tickets.mjs
 */

const JIRA_HOST = 'bizzassist.atlassian.net';
const JIRA_EMAIL = 'itmgtconsulting@gmail.com';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'BIZZ';

if (!JIRA_TOKEN) {
  console.error('Missing JIRA_API_TOKEN environment variable');
  process.exit(1);
}

const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE_URL = `https://${JIRA_HOST}/rest/api/3`;

async function jiraRequest(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${AUTH}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`JIRA ${method} ${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Helper: create ADF document from sections */
function adf(...blocks) {
  return { type: 'doc', version: 1, content: blocks };
}
function heading(level, text) {
  return {
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text }],
  };
}
function paragraph(text) {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}
function bulletList(items) {
  return {
    type: 'bulletList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
    })),
  };
}
function codeBlock(text) {
  return {
    type: 'codeBlock',
    attrs: { language: 'typescript' },
    content: [{ type: 'text', text }],
  };
}

// ---------------------------------------------------------------------------
// Ticket definitions
// ---------------------------------------------------------------------------

const tickets = [
  {
    summary: 'refactor: extract hardcoded external api endpoints to admin-configurable settings',
    priority: 'High',
    labels: ['hardcode-audit', 'refactor', 'admin-ui'],
    description: adf(
      heading(2, 'Baggrund'),
      paragraph(
        '8+ eksterne API-endpoints er hardcoded direkte i kildekoden. Disse bør kunne konfigureres via admin-frontend, så endpoints kan ændres uden en ny deploy (f.eks. ved skift fra test til produktion, eller ved URL-ændringer hos leverandør).'
      ),
      heading(2, 'Berørte filer og endpoints'),
      bulletList([
        'app/lib/dawa.ts:72 — https://api.dataforsyningen.dk',
        'app/lib/dar.ts:39-40 — https://graphql.datafordeler.dk/DAR/v1 + MatGaeld662 WFS',
        'app/lib/fetchBbrData.ts:181-185 — BBR WFS + BBR GraphQL v2 + Dataforsyningen',
        'app/lib/dfCertAuth.ts:24 — Datafordeler OAuth token endpoint',
        'app/lib/dfTokenCache.ts:16 — Duplicate OAuth token endpoint',
        'app/api/salgshistorik/route.ts:65-66 — EJF GraphQL + auth',
        'app/api/salgshistorik/cvr/route.ts:63-64 — EJF endpoints (duplicate)',
        'app/api/cvr-search/route.ts:51 — CVR ElasticSearch endpoint',
        'app/api/regnskab/route.ts:57 — Virk offentliggørelser ES endpoint',
        'app/api/ai/person-article-search/route.ts:277,401 — Brave Search endpoint',
        'app/api/matrikelkort/route.ts:252-254 — Overpass API mirrors (3 URLs)',
        'app/api/jord/route.ts — Miljøportalen endpoint',
        'app/api/jord/pdf/route.ts:56 — Miljøportalen PDF endpoint',
        'app/lib/email.ts:14 — Resend API endpoint',
      ]),
      heading(2, 'Løsning'),
      paragraph(
        'Opret en admin-side (/dashboard/admin/config) med en sektion for "Eksterne API-endpoints". Gem i Supabase-tabel (system_config). Fald tilbage til env vars, og sidst til hardcoded defaults.'
      ),
      codeBlock(
        `// app/lib/serviceConfig.ts
interface ServiceEndpoints {
  datafordelerGraphQL: string;
  datafordelerAuth: string;
  dataforsyningen: string;
  cvrElasticSearch: string;
  braveSearch: string;
  resendApi: string;
  miljoeportalen: string;
  overpassMirrors: string[];
}

// Priority: DB config → env var → hardcoded default
export async function getEndpoints(): Promise<ServiceEndpoints> { ... }`
      ),
      heading(2, 'Acceptance criteria'),
      bulletList([
        '[ ] Alle eksterne endpoints hentes fra system_config tabel',
        '[ ] Admin UI til at redigere endpoints under /dashboard/admin/config',
        '[ ] Fallback-kæde: DB → env var → hardcoded default',
        '[ ] Cache i LRU (5 min TTL) så DB ikke rammes på hvert request',
        '[ ] Audit log ved ændringer',
        '[ ] Eksisterende env vars virker stadig som override',
      ])
    ),
  },
  {
    summary: 'refactor: extract hardcoded email addresses to admin-configurable settings',
    priority: 'High',
    labels: ['hardcode-audit', 'refactor', 'admin-ui'],
    description: adf(
      heading(2, 'Baggrund'),
      paragraph(
        'Email-adresser (afsender, modtager, support) er hardcoded i 15+ filer. Disse skal kunne ændres via admin-frontend uden redeploy.'
      ),
      heading(2, 'Berørte filer'),
      bulletList([
        'app/lib/service-manager-alerts.ts:21-22 — noreply@bizzassist.dk, support@pecuniait.com',
        'app/api/cron/daily-report/route.ts:31-32 — FROM/TO hardcoded',
        'app/api/cron/daily-status/route.ts:41-42 — FROM/TO hardcoded',
        'app/api/cron/deep-scan/route.ts:44-45 — FROM/TO hardcoded',
        'app/api/cron/service-scan/route.ts:50-51 — FROM/TO hardcoded',
        'app/api/support/chat/route.ts:169 — admin@bizzassist.dk hardcoded i fejlbesked',
        'app/components/OnboardingModal.tsx:320-321 — support@bizzassist.dk',
        'app/components/SupportChatWidget.tsx:57,76 — admin@bizzassist.dk',
        'app/components/Footer.tsx:67,70 — support@pecuniait.com',
        'app/privacy/PrivacyPageClient.tsx — support@pecuniait.com (4 steder)',
        'app/terms/TermsPageClient.tsx — support@pecuniait.com (flere steder)',
        'app/cookies/CookiesPageClient.tsx:139-140,240-241 — support@pecuniait.com',
      ]),
      heading(2, 'Løsning'),
      paragraph(
        'Admin UI-sektion for "Email-konfiguration" med felter for: afsender-email, support-email, admin-notifikation-email, cron-rapport-modtagere. Gem i system_config tabel.'
      ),
      heading(2, 'Acceptance criteria'),
      bulletList([
        '[ ] Email-adresser hentes fra system_config (DB)',
        '[ ] Admin UI til at redigere under /dashboard/admin/config',
        '[ ] Cron-rapport modtagere: liste af emails (array)',
        '[ ] UI-komponenter bruger centraliseret email-config',
        '[ ] Fallback til env vars → hardcoded defaults',
      ])
    ),
  },
  {
    summary: 'refactor: extract hardcoded company/legal entity data to admin-configurable settings',
    priority: 'High',
    labels: ['hardcode-audit', 'refactor', 'admin-ui'],
    description: adf(
      heading(2, 'Baggrund'),
      paragraph(
        '"Pecunia IT ApS", CVR 44718502, og adresse "Søbyvej 11, 2650 Hvidovre" er hardcoded i 15+ steder. Hvis virksomheden skifter navn, adresse, eller CVR skal alle filer rettes manuelt.'
      ),
      heading(2, 'Berørte filer'),
      bulletList([
        'app/lib/email.ts:98 — Email footer med fuldt firmanavn + CVR + adresse',
        'app/api/cron/daily-report/route.ts:499 — Email footer (duplikat)',
        'app/api/cron/deep-scan/route.ts:645 — Email footer (duplikat)',
        'app/api/cron/service-scan/route.ts:557 — Email footer (duplikat)',
        'app/api/cron/daily-status/route.ts:525 — Email footer (duplikat)',
        'app/api/tinglysning/dokument/route.ts:617,726,816 — PDF generation (3 steder)',
        'app/api/export/pdf/route.ts:85,181 — PDF metadata',
        'app/lib/translations.ts:166-168,722-724 — Translation keys',
        'app/privacy/PrivacyPageClient.tsx:52,255 — Privacy policy (DA+EN)',
        'app/terms/TermsPageClient.tsx:52,320 — Terms of Service (DA+EN)',
      ]),
      heading(2, 'Løsning'),
      paragraph(
        'Admin UI-sektion for "Virksomhedsoplysninger" med felter: firmanavn, CVR, adresse, postnr, by. Bruges i email footers, PDF-generering, juridiske sider, og translations.'
      ),
      codeBlock(
        `// system_config tabel
key: 'company_info'
value: {
  name: 'Pecunia IT ApS',
  cvr: '44718502',
  address: 'Søbyvej 11',
  postalCode: '2650',
  city: 'Hvidovre'
}`
      ),
      heading(2, 'Acceptance criteria'),
      bulletList([
        '[ ] Alle Pecunia IT-referencer erstattet med dynamisk config',
        '[ ] Admin UI til redigering af virksomhedsdata',
        '[ ] PDF-generering bruger dynamisk firmanavn + CVR',
        '[ ] Email footers bruger dynamisk data',
        '[ ] Privacy/Terms sider bruger dynamisk data',
        '[ ] Translations opdateret til at bruge config-værdier',
      ])
    ),
  },
  {
    summary: 'refactor: extract hardcoded rate limits and timeouts to admin-configurable settings',
    priority: 'Medium',
    labels: ['hardcode-audit', 'refactor', 'admin-ui'],
    description: adf(
      heading(2, 'Baggrund'),
      paragraph(
        'Rate limits, fetch timeouts, og login throttle-værdier er hardcoded. Disse har direkte funktionel påvirkning og bør kunne justeres fra admin-UI uden redeploy — f.eks. ved DDoS, performance-problemer, eller ændrede SLA-krav.'
      ),
      heading(2, 'Berørte filer'),
      bulletList([
        'app/lib/globalRateLimit.ts:33,36,39 — ANON_LIMIT=200, AUTH_LIMIT=500, WINDOW=10s',
        'app/lib/rateLimit.ts:63,78,93,108 — Per-route limits: 60/10/30 req/min, 500 req/day',
        'app/lib/loginThrottle.ts:24,27,30 — MAX_ATTEMPTS=5, LOCKOUT=900s, COUNTER_TTL=1800s',
        'app/lib/dawa.ts:169,189,248,262,284 — DAWA fetch timeouts (3000-5000ms)',
        'app/lib/tlFetch.ts:41 — Tinglysning timeout=55000ms',
        'app/api/jord/pdf/route.ts:24 — Miljøportalen timeout=30000ms',
        'app/api/ejendomme-by-owner/route.ts:89 — MAX_CVR=30 batch size',
        'app/api/knowledge/upload/route.ts:31,34 — MAX_FILE=1MB, MAX_CHARS=50000',
        'app/api/support/chat/route.ts:313 — MAX_CONTENT_CHARS=10000',
        'app/api/ai/chat/route.ts:1296 — MAX_CONTENT_CHARS=10000',
      ]),
      heading(2, 'Løsning'),
      paragraph(
        'Admin UI-sektion for "Rate Limits & Timeouts" med kategorier: Global rate limits, API-specifikke limits, Login sikkerhed, Fetch timeouts, Upload limits. Gem i system_config med cache.'
      ),
      heading(2, 'Admin UI felter'),
      bulletList([
        'Global: anon limit, auth limit, window (sekunder)',
        'Login: max forsøg, lockout-tid, counter TTL',
        'Timeouts: DAWA, Tinglysning, Miljøportalen, generelt',
        'Upload: max filstørrelse (bytes), max tegn',
        'Batch: max CVR per request',
      ]),
      heading(2, 'Acceptance criteria'),
      bulletList([
        '[ ] Alle rate limits hentes fra system_config',
        '[ ] Admin UI med real-time preview af nuværende værdier',
        '[ ] Ændringer træder i kraft inden for 5 min (cache TTL)',
        '[ ] Validering: minimum/maximum grænser forhindrer farlige værdier',
        '[ ] Audit log ved ændringer',
        '[ ] Fallback til env vars → hardcoded defaults',
      ])
    ),
  },
  {
    summary: 'refactor: extract hardcoded cache ttls to admin-configurable settings',
    priority: 'Medium',
    labels: ['hardcode-audit', 'refactor', 'admin-ui'],
    description: adf(
      heading(2, 'Baggrund'),
      paragraph(
        '10+ API-ruter har hardcoded HTTP cache headers (s-maxage, stale-while-revalidate) og in-memory cache TTLs. Disse påvirker performance og dataopdatering direkte og bør kunne justeres via admin-UI.'
      ),
      heading(2, 'Berørte filer'),
      bulletList([
        'app/api/vurdering-forelobig/route.ts — s-maxage=86400 (24t)',
        'app/api/cvr/route.ts — s-maxage=1800 (30min)',
        'app/api/cvr/bbox/route.ts — s-maxage=300 (5min)',
        'app/api/cvr/[cvr]/route.ts — s-maxage=3600 (1t)',
        'app/api/jord/route.ts — s-maxage=86400 (24t)',
        'app/api/energimaerke/route.ts — s-maxage=3600 (1t)',
        'app/api/matrikel/route.ts — s-maxage=86400 (24t)',
        'app/api/person-search/route.ts — s-maxage=300 (5min)',
        'app/api/search/route.ts — s-maxage=60 (1min)',
        'app/api/ejendomme-by-owner/route.ts — s-maxage=1800 (30min)',
        'app/api/tinglysning/summarisk/route.ts:51 — XML_CACHE_TTL=5min (in-memory)',
        'app/api/analysis/run/route.ts:328 — CACHE_TTL=5min (in-memory)',
        'app/api/ai/chat/route.ts:405 — TOOL_CACHE_TTL=5min (in-memory)',
      ]),
      heading(2, 'Løsning'),
      paragraph(
        'Admin UI-sektion for "Cache-konfiguration" med en tabel over alle API-ruter og deres cache-indstillinger. Grupperet efter datakilde (Datafordeler, CVR, Tinglysning, osv.).'
      ),
      heading(2, 'Acceptance criteria'),
      bulletList([
        '[ ] Alle cache TTLs hentes fra system_config',
        '[ ] Admin UI med oversigt: rute → s-maxage → stale-while-revalidate',
        '[ ] "Nulstil til default" knap per rute',
        '[ ] Validering: min 0s, max 604800s (1 uge)',
        '[ ] Cache-clear knap til at invalidere in-memory caches',
      ])
    ),
  },
  {
    summary: 'refactor: extract hardcoded domain urls (bizzassist.dk) to use env var consistently',
    priority: 'High',
    labels: ['hardcode-audit', 'refactor'],
    description: adf(
      heading(2, 'Baggrund'),
      paragraph(
        '"https://bizzassist.dk" er hardcoded i 12+ filer uden fallback til NEXT_PUBLIC_APP_URL. Dette betyder at test/preview-miljøer genererer forkerte URLs i emails, sitemaps, robots.txt, og CORS headers.'
      ),
      heading(2, 'Berørte filer'),
      bulletList([
        'app/robots.ts:37 — SEO robots.txt peger altid på prod',
        'app/sitemap.ts:33 — XML sitemap peger altid på prod',
        'app/lib/email.ts:162,362 — Email-links peger altid på prod',
        'app/api/cron/daily-report/route.ts:528 — Rapport-links',
        'app/api/cron/deep-scan/route.ts — Scan-links',
        'app/api/cron/monitor-email/route.ts:173 — Monitor-links',
        'app/api/cron/service-scan/route.ts:474 — Service-links',
        'app/api/wms/route.ts:89 — CORS origin hardcoded til prod',
        'app/api/webhooks/vercel-deploy/route.ts:359 — Webhook handler',
        'app/api/admin/service-manager/route.ts:230 — Admin links',
        'app/api/admin/release-agent/route.ts:110 — Release agent',
      ]),
      heading(2, 'Løsning'),
      paragraph(
        'Erstat alle "https://bizzassist.dk" med process.env.NEXT_PUBLIC_APP_URL. Opret helper-funktion getAppUrl() der fejler eksplicit hvis env var mangler (fail fast).'
      ),
      codeBlock(
        `// app/lib/appUrl.ts
export function getAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) throw new Error('NEXT_PUBLIC_APP_URL is not configured');
  return url.replace(/\\/$/, '');
}`
      ),
      heading(2, 'Acceptance criteria'),
      bulletList([
        '[ ] Alle hardcoded "bizzassist.dk" erstattet med getAppUrl()',
        '[ ] robots.txt og sitemap.xml bruger korrekt domæne i alle miljøer',
        '[ ] Emails indeholder korrekte links i test-miljø',
        '[ ] CORS i wms/route.ts bruger dynamisk origin',
        '[ ] Build fejler hvis NEXT_PUBLIC_APP_URL mangler',
      ])
    ),
  },
  {
    summary: 'feat: create admin system config page for managing hardcoded values',
    priority: 'High',
    labels: ['hardcode-audit', 'admin-ui', 'feature'],
    description: adf(
      heading(2, 'Baggrund'),
      paragraph(
        'Flere JIRA tickets (se linked issues) kræver at hardcoded værdier flyttes til en admin-konfigurerbar løsning. Denne ticket dækker den fælles infrastruktur: database-tabel, API-endpoints, og admin-UI.'
      ),
      heading(2, 'Krav'),
      heading(3, '1. Database: system_config tabel'),
      codeBlock(
        `CREATE TABLE system_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,       -- 'endpoints', 'email', 'company', 'rate_limits', 'cache'
  key TEXT NOT NULL UNIQUE,     -- 'datafordeler_graphql_url', 'support_email', etc.
  value JSONB NOT NULL,         -- flexible value (string, number, object, array)
  description TEXT,             -- human-readable description for admin UI
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

-- RLS: only super_admin can read/write
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;`
      ),
      heading(3, '2. API: /api/admin/config'),
      bulletList([
        'GET — hent alle config-værdier (eller filtreret på category)',
        'PATCH — opdater én config-værdi (kun super_admin)',
        'Audit log ved alle ændringer',
      ]),
      heading(3, '3. Server-side helper: getConfig()'),
      codeBlock(
        `// app/lib/systemConfig.ts
const cache = new LRUCache<string, unknown>({ max: 200, ttl: 5 * 60 * 1000 });

export async function getConfig<T>(key: string, defaultValue: T): Promise<T> {
  // 1. Check LRU cache
  // 2. Check Supabase system_config
  // 3. Check process.env[key]
  // 4. Return defaultValue
}`
      ),
      heading(3, '4. Admin UI: /dashboard/admin/config'),
      bulletList([
        'Tabs per kategori: Endpoints, Email, Virksomhed, Rate Limits, Cache',
        'Formular med validering per felt',
        '"Gem" knap med optimistic update',
        '"Nulstil til default" per felt',
        'Historik/audit log visning',
        'Søgefunktion på tværs af alle indstillinger',
      ]),
      heading(2, 'Acceptance criteria'),
      bulletList([
        '[ ] system_config tabel oprettet med RLS (super_admin only)',
        '[ ] API endpoint med GET/PATCH + audit logging',
        '[ ] getConfig() helper med LRU cache (5 min TTL)',
        '[ ] Admin UI med alle kategorier og felter',
        '[ ] Seed-script der populerer default-værdier',
        '[ ] Mindst én eksisterende hardcoded værdi migreret som proof-of-concept',
      ])
    ),
  },
];

// ---------------------------------------------------------------------------
// Build failure ticket (separate from hardcode audit)
// ---------------------------------------------------------------------------

const buildFailureTicket = {
  summary: 'fix(deps): vercel build failure on dependabot production-dependencies bump',
  priority: 'High',
  labels: ['bug', 'build', 'dependencies'],
  issueType: 'Bug',
  description: adf(
    heading(2, 'Problem'),
    paragraph(
      'Dependabot PR (branch: dependabot/npm_and_yarn/production-dependencies-314277b125) fejler i Vercel build. PR bumper 11 pakker inkl. @anthropic-ai/sdk. Deployment ID: dpl_GTnCX4fPHyE6Agsux1LC49NkjDKx.'
    ),
    heading(2, 'Detaljer'),
    bulletList([
      'Branch: dependabot/npm_and_yarn/production-dependencies-314277b125',
      'Commit: chore(deps): Bump the production-dependencies group across 1 directory with 11 updates',
      'Pakker: @anthropic-ai/sdk + 10 andre production dependencies',
      'Deploy webhook: build fejlede 16. apr, 12:03',
      'Afvist af Service Manager: "No actual compilation error, missing file, or logic defect visible"',
    ]),
    heading(2, 'Root cause'),
    paragraph(
      'Build-fejlen skyldes sandsynligvis en breaking change i en af de 11 opdaterede pakker. Service Manager kunne ikke identificere den præcise fejl uden Vercel build logs. Kræver manuel inspektion af build output.'
    ),
    heading(2, 'Løsning'),
    bulletList([
      '1. Hent Vercel build logs for deployment dpl_GTnCX4fPHyE6Agsux1LC49NkjDKx',
      '2. Identificer hvilken pakke der forårsager fejlen',
      '3. Pin den problematiske pakke til sidste fungerende version, eller fix breaking change',
      '4. Kør npm audit for at sikre ingen nye CVEs',
      '5. Merge PR når build er grøn',
    ]),
    heading(2, 'Acceptance criteria'),
    bulletList([
      '[ ] Build er grøn på develop efter dependency bump',
      '[ ] Ingen nye npm audit critical/high findings',
      '[ ] Alle tests bestået',
    ])
  ),
};

tickets.push(buildFailureTicket);

// ---------------------------------------------------------------------------
// Main — create all tickets
// ---------------------------------------------------------------------------

async function main() {
  console.log('BizzAssist — Hardcode Audit JIRA Ticket Creator\n');
  console.log(`Creating ${tickets.length} tickets...\n`);

  const created = [];

  for (const ticket of tickets) {
    try {
      const result = await jiraRequest('POST', '/issue', {
        fields: {
          project: { key: PROJECT_KEY },
          summary: ticket.summary,
          description: ticket.description,
          issuetype: { name: ticket.issueType || 'Story' },
          priority: { name: ticket.priority },
          labels: ticket.labels,
        },
      });
      console.log(`✓ ${result.key}: ${ticket.summary}`);
      console.log(`  → https://${JIRA_HOST}/browse/${result.key}`);
      created.push(result.key);
    } catch (err) {
      console.error(`✗ Failed: ${ticket.summary}`);
      console.error(`  Error: ${err.message}\n`);
    }
  }

  console.log(`\n--- Done: ${created.length}/${tickets.length} tickets created ---`);
  console.log('Keys:', created.join(', '));
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
