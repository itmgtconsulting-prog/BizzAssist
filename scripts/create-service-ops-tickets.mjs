/**
 * BizzAssist — Service Management & Operations Review JIRA Tickets
 *
 * Covers infrastructure monitoring, resource alerting, certificate management,
 * cron health, external API monitoring — integrated with Service Manager Agent
 * and Release Agent.
 *
 * Run: JIRA_API_TOKEN=<token> node scripts/create-service-ops-tickets.mjs
 */

const JIRA_HOST = 'bizzassist.atlassian.net';
const JIRA_EMAIL = 'itmgtconsulting@gmail.com';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'BIZZ';

if (!JIRA_TOKEN) {
  console.error('ERROR: Set JIRA_API_TOKEN environment variable');
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
  if (!res.ok) throw new Error(`JIRA ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function createIssue({ summary, description, issueType, priority, labels }) {
  return jiraRequest('POST', '/issue', {
    fields: {
      project: { key: PROJECT_KEY },
      summary,
      description: { type: 'doc', version: 1, content: description },
      issuetype: { name: issueType },
      priority: { name: priority },
      labels: labels || [],
    },
  });
}

const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const h = (t, l = 3) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const bl = (items) => ({
  type: 'bulletList',
  content: items.map((i) => ({ type: 'listItem', content: [p(i)] })),
});
const cb = (t, lang = '') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const lv = (label, value) => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: `${label}: `, marks: [{ type: 'strong' }] },
    { type: 'text', text: value },
  ],
});

const tickets = [
  // ── EPIC ─────────────────────────────────────────────────────────────────
  {
    summary: 'EPIC: Service management & operations — monitoring, alerting, resource management',
    issueType: 'Epic',
    priority: 'Highest',
    labels: ['ops', 'monitoring', 'service-manager', 'infrastructure'],
    description: [
      p('Operations review af BizzAssist infrastruktur, monitoring og ressource-styring. Integreret med eksisterende Service Manager Agent og Release Agent.'),
      h('Nuværende styrker'),
      bl([
        '✅ Service Manager: Hourly scan af Vercel builds + runtime errors',
        '✅ Auto-fix pipeline: Claude foreslår fixes → auto-approval rules → Release Agent',
        '✅ 11 cron jobs konfigureret (service-scan, monitor-email, daily-report, etc.)',
        '✅ Email + SMS alerting for kritiske issues',
        '✅ Vercel deploy webhook integration med auto-fix trigger',
        '✅ GitHub Actions: daily health checks (tsc, lint, test, audit)',
        '✅ Activity audit log i service_manager_activity tabel',
      ]),
      h('Kritiske blindspots'),
      bl([
        '❌ Supabase database: størrelse, connections, performance — ikke monitoreret',
        '❌ Upstash Redis: memory, eviction, latency — ikke monitoreret',
        '❌ mTLS certifikater: udløbsdato ikke tracket — Tinglysning + Datafordeler',
        '❌ Eksterne API\'er: Datafordeler, CVR ES, Tinglysning tilgængelighed — ikke checket',
        '❌ Cron job failures: ingen alert hvis et job fejler eller ikke kører',
        '❌ Claude API token budget: forbrug trackes men ingen budget-alerts',
        '❌ Automatisk rollback: ingen revert ved fejlslået deploy',
        '❌ Checkly: konfigureret men ingen checks implementeret',
        '❌ Centraliseret logging: kun ephemere Vercel logs',
      ]),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 1: Udvid /api/health med deep checks
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P0][OPS] Udvid /api/health med deep infrastructure checks (DB, Redis, eksterne API\'er)',
    issueType: 'Story',
    priority: 'Highest',
    labels: ['ops', 'monitoring', 'health-check', 'service-manager', 'p0'],
    description: [
      h('Nuværende tilstand'),
      p('/api/health eksisterer med basic checks (API alive + Supabase getSession probe). Det er utilstrækkeligt til at opdage reelle infrastruktur-problemer.'),
      h('Ønskede checks'),
      cb(
        `GET /api/health?deep=true

{
  "status": "healthy|degraded|critical",
  "version": "1.2.3",
  "timestamp": "2026-04-14T10:00:00Z",
  "checks": {
    "api": { "status": "ok", "latency_ms": 2 },
    "database": {
      "status": "ok",
      "latency_ms": 15,
      "connections_used": 12,
      "connections_max": 50,
      "storage_mb": 1240,
      "storage_limit_mb": 8000
    },
    "redis": {
      "status": "ok",
      "latency_ms": 3,
      "memory_used_mb": 45,
      "memory_max_mb": 256,
      "keys": 12340
    },
    "external_apis": {
      "datafordeler": { "status": "ok", "latency_ms": 120 },
      "cvr_es": { "status": "ok", "latency_ms": 200 },
      "tinglysning": { "status": "ok", "latency_ms": 150 },
      "emo": { "status": "ok", "latency_ms": 100 },
      "stripe": { "status": "ok" },
      "resend": { "status": "ok" }
    },
    "certificates": {
      "tinglysning_mtls": { "expires": "2026-08-15", "days_remaining": 123 },
      "datafordeler_mtls": { "expires": "2026-12-01", "days_remaining": 231 }
    },
    "cron": {
      "last_service_scan": "2026-04-14T09:00:00Z",
      "last_daily_report": "2026-04-14T07:00:00Z"
    }
  }
}`,
        'json'
      ),
      h('Implementering'),
      bl([
        'Supabase: SELECT count(*) FROM tenants (connectivity) + pg_stat_activity for connections',
        'Redis: Upstash REST API redis.info() for memory + key count',
        'External APIs: HEAD/GET med 5s timeout til hvert endpoint',
        'Certifikater: Parse X509 expiry fra certifikat-filer eller Base64 env vars',
        'Cron: Query service_manager_scans for seneste scan timestamp',
        'Cache: Deep check resultat 30 sekunder (undgå spam)',
      ]),
      h('Integration med Service Manager'),
      bl([
        'Service Manager service-scan cron kalder /api/health?deep=true som del af hourly scan',
        'Hvis health status === "degraded" eller "critical" → tilføj som issue i scan results',
        'Critical alerts for: DB connections > 80%, Redis memory > 80%, cert expires < 30 dage',
        'Tilføj nyt issue type: "infrastructure_warning" og "infrastructure_error"',
      ]),
      h('Berørte filer'),
      bl([
        'app/api/health/route.ts — udvid med deep checks',
        'app/api/cron/service-scan/route.ts — integrer health check i scan flow',
        'app/lib/service-manager-alerts.ts — tilføj infrastructure issue types til critical criteria',
      ]),
      lv('Effort', 'M (3-5 dage)'),
      lv('Risk', 'Lav — additive; eksisterende health endpoint bevares'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 2: Certificate expiry monitoring
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P0][OPS] mTLS certifikat-udløbs monitoring og rotation alerts',
    issueType: 'Story',
    priority: 'Highest',
    labels: ['ops', 'certificates', 'tinglysning', 'datafordeler', 'service-manager', 'p0'],
    description: [
      h('Problem'),
      p('BizzAssist bruger mTLS certifikater til Tinglysning og Datafordeler. Certifikat-udløb monitoreres IKKE. Når et certifikat udløber, stopper alle relaterede API-kald øjeblikkeligt — tinglysning, ejerskab, vurdering, og salgshistorik bliver utilgængelige.'),
      h('Certifikater i brug'),
      bl([
        'Tinglysning mTLS: TINGLYSNING_CERT_B64 / TINGLYSNING_CERT_PATH (password: TINGLYSNING_CERT_PASSWORD)',
        'Datafordeler cert: DATAFORDELER_CERT_PFX_BASE64 / DATAFORDELER_CERT_PATH (password: DATAFORDELER_CERT_PASSWORD)',
        'Begge bruges via: app/lib/tlFetch.ts og app/lib/dfCertAuth.ts',
      ]),
      h('Løsning'),
      bl([
        '1. Certifikat-parser: Opret app/lib/certExpiry.ts der parser PFX/P12 certifikater og returnerer udløbsdato',
        '2. Health check integration: Tilføj cert expiry til /api/health?deep=true (se relateret ticket)',
        '3. Service Manager integration: Tilføj "certificate_expiry" som issue type i service-scan',
        '4. Alert tresholds:',
        '   - 60 dage: INFO i daily-report ("Certifikat udløber om 60 dage")',
        '   - 30 dage: WARNING email til support + JIRA ticket',
        '   - 14 dage: CRITICAL alert (email + SMS) + JIRA P1 ticket',
        '   - 7 dage: BLOCKER alert hver dag + eskalering',
        '5. Cron check: Tilføj cert-check til daily-status cron (kører kl. 06:00)',
      ]),
      h('Teknisk detalje'),
      cb(
        `import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

function getCertExpiry(pfxBase64: string, password: string): Date {
  const pfx = Buffer.from(pfxBase64, 'base64');
  // Parse PFX → extract cert → read notAfter
  // Node.js 20+ har X509Certificate class
  const cert = new X509Certificate(pfx);
  return new Date(cert.validTo);
}`,
        'typescript'
      ),
      h('Berørte filer'),
      bl([
        'Ny: app/lib/certExpiry.ts — certifikat parser utility',
        'app/api/cron/daily-status/route.ts — tilføj cert expiry check',
        'app/api/cron/service-scan/route.ts — tilføj cert issue type',
        'app/lib/service-manager-alerts.ts — tilføj cert expiry til critical criteria',
      ]),
      lv('Effort', 'S (1-2 dage)'),
      lv('Risk', 'KRITISK hvis ikke implementeret — cert udløb = total service outage for tinglysning/ejerskab'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 3: Cron heartbeat monitoring
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P0][OPS] Cron job heartbeat monitoring — alert når jobs fejler eller ikke kører',
    issueType: 'Story',
    priority: 'Highest',
    labels: ['ops', 'monitoring', 'cron', 'heartbeat', 'service-manager', 'p0'],
    description: [
      h('Problem'),
      p('11 cron jobs kører i produktion. Hvis et job fejler (500 error) eller ikke triggerer (Vercel cron issue), er der INGEN alert. Fejlede cron jobs logges til console men monitoreres ikke. Vigtige processer (BBR events, property polling, purge-old-data) kan stå stille i dage uden at nogen opdager det.'),
      h('Nuværende cron jobs'),
      bl([
        'service-scan (hourly) — kritisk for hele monitoring-pipeline',
        'monitor-email (hvert 5. min) — alert-inbox overvågning',
        'daily-report (07:00) — daglig statistik',
        'daily-status (06:00) — infrastruktur-status',
        'deep-scan (03:30) — code quality scan',
        'poll-properties (03:00) — ejendomsovervågning for brugere',
        'pull-bbr-events (hver 6. time) — BBR ændringer fra Datafordeler',
        'warm-cache (04:00) — ISR cache opvarmning',
        'generate-sitemap (søndage) — SEO sitemaps',
        'purge-old-data — GDPR data sletning',
        'ai-feedback-triage — AI feedback processing',
      ]),
      h('Løsning: Heartbeat tabel + watchdog'),
      cb(
        `-- Ny tabel: cron_heartbeats
CREATE TABLE public.cron_heartbeats (
  job_name TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL,
  last_status TEXT NOT NULL, -- 'success' | 'error'
  last_duration_ms INT,
  last_error TEXT,
  expected_interval_minutes INT NOT NULL, -- forventet kørsel interval
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Hvert cron job skriver:
INSERT INTO cron_heartbeats (job_name, last_run_at, last_status, last_duration_ms, expected_interval_minutes)
VALUES ('service-scan', now(), 'success', 4500, 60)
ON CONFLICT (job_name) DO UPDATE SET
  last_run_at = EXCLUDED.last_run_at,
  last_status = EXCLUDED.last_status,
  last_duration_ms = EXCLUDED.last_duration_ms;`,
        'sql'
      ),
      h('Watchdog cron'),
      bl([
        'Nyt cron job: /api/cron/watchdog (kører hvert 30. min)',
        'Checker cron_heartbeats: er last_run_at ældre end expected_interval_minutes × 2?',
        'Hvis ja → CRITICAL alert (email + SMS): "[job_name] har ikke kørt i [X] minutter"',
        'Hvis last_status === "error" → WARNING alert med last_error',
        'Integrér med Service Manager: watchdog issues vises i admin dashboard',
      ]),
      h('Implementering'),
      bl([
        'Opret migration: cron_heartbeats tabel',
        'Tilføj heartbeat write til ALLE 11 cron jobs (shared helper: app/lib/cronHeartbeat.ts)',
        'Opret /api/cron/watchdog route',
        'Tilføj til vercel.json: "*/30 * * * *"',
        'Integrer med /api/health?deep=true (vis cron status)',
      ]),
      lv('Effort', 'M (3-5 dage)'),
      lv('Risk', 'Høj uden — stille cron-fejl kan betyde GDPR non-compliance (purge), manglende BBR events, eller dødt monitoring'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 4: External API health monitoring
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P1][OPS] External API availability monitoring med Service Manager integration',
    issueType: 'Story',
    priority: 'High',
    labels: ['ops', 'monitoring', 'external-api', 'service-manager', 'p1'],
    description: [
      h('Problem'),
      p('BizzAssist afhænger af 8+ eksterne API\'er. Ingen af dem monitoreres for tilgængelighed eller performance. Hvis Datafordeler eller CVR ES er nede, får brugere fejl uden at operations-teamet advares.'),
      h('Eksterne API\'er der skal monitoreres'),
      bl([
        'Datafordeler GraphQL (graphql.datafordeler.dk) — BBR, MAT, DAR, VUR, EJF',
        'Datafordeler Auth (auth.datafordeler.dk) — OAuth token endpoint',
        'CVR ElasticSearch (distribution.virk.dk) — virksomhedsdata',
        'Tinglysning (www.tinglysning.dk) — tingbogsdata via mTLS',
        'Vurderingsportalen (api-fs.vurderingsportalen.dk) — foreløbige vurderinger',
        'EMO Energy (emoweb.dk) — energimærker',
        'DAWA (api.dataforsyningen.dk) — adresser (indtil juli 2026)',
        'Miljøportalen (jord-public-api.miljoeportal.dk) — jordforurening',
      ]),
      h('Løsning'),
      bl([
        'Opret app/lib/externalApiHealth.ts med probe-funktioner per API',
        'Hver probe: HEAD/GET request med 5s timeout, returnerer { status, latency_ms, error }',
        'Integrer i service-scan cron: kald alle probes hvert hour',
        'Ny issue type i Service Manager: "external_api_down" (severity: error)',
        'Ny issue type: "external_api_slow" (severity: warning, threshold: >2000ms)',
        'Critical alert kriterier: Datafordeler, CVR ES, eller Tinglysning nede',
        'Tilføj til /api/health?deep=true response',
      ]),
      h('Probe implementering'),
      cb(
        `interface ApiProbeResult {
  service: string;
  status: 'ok' | 'slow' | 'down' | 'error';
  latency_ms: number;
  error?: string;
}

async function probeDatafordeler(): Promise<ApiProbeResult> {
  const start = Date.now();
  try {
    const res = await fetch('https://graphql.datafordeler.dk/BBR/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - start;
    return {
      service: 'datafordeler',
      status: latency > 2000 ? 'slow' : 'ok',
      latency_ms: latency,
    };
  } catch (e) {
    return { service: 'datafordeler', status: 'down', latency_ms: Date.now() - start, error: String(e) };
  }
}`,
        'typescript'
      ),
      h('Service Manager dashboard'),
      p('Vis external API status som dedikeret sektion i /dashboard/admin/service-manager med trafiklysindikatorer (grøn/gul/rød) per API.'),
      lv('Effort', 'M (3-5 dage)'),
      lv('Risk', 'Medium — probes kan give false positives ved transient errors; brug 2/3 failures som threshold'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 5: Claude API budget monitoring
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P1][OPS] Claude API token budget monitoring og forbrugs-alerts',
    issueType: 'Story',
    priority: 'High',
    labels: ['ops', 'monitoring', 'ai', 'budget', 'claude', 'p1'],
    description: [
      h('Problem'),
      p('Claude API tokens trackes i ai_token_usage tabellen per tenant, men der er INGEN budget-alerts. En runaway-prompt, fejlagtig loop, eller høj brugeraktivitet kan brænde hele API-budgettet uden advarsel.'),
      h('Nuværende tilstand'),
      bl([
        '✅ ai_token_usage tabel logger: tenant_id, user_id, tokens_input, tokens_output, model, created_at',
        '✅ /api/subscription/track-tokens registrerer forbrug efter hver AI-kald',
        '❌ Ingen budget-grænse per tenant',
        '❌ Ingen global budget-alert',
        '❌ Ingen daglig/ugentlig forbrugsrapport',
        '❌ Ingen throttling ved budget-overskridelse',
      ]),
      h('Løsning'),
      bl([
        '1. Dagligt forbrug check i daily-report cron:',
        '   - Total tokens brugt de seneste 24 timer',
        '   - Top 5 tenants efter forbrug',
        '   - Sammenligning med forgående dag (% ændring)',
        '2. Budget alerts:',
        '   - Daglig budget: CLAUDE_DAILY_BUDGET_TOKENS env var (default: 5.000.000)',
        '   - 80% threshold: WARNING i daily-report',
        '   - 95% threshold: CRITICAL alert (email + SMS) + throttle nye requests',
        '   - 100% overskridelse: AI chat returner "Budget overskredet" besked',
        '3. Per-tenant limits:',
        '   - Free plan: 50.000 tokens/dag',
        '   - Pro plan: 500.000 tokens/dag',
        '   - Enterprise: configurable',
        '4. Service Manager integration:',
        '   - "ai_budget_warning" issue type i service-scan',
        '   - Vis forbrug i admin dashboard',
      ]),
      h('Berørte filer'),
      bl([
        'app/api/cron/daily-report/route.ts — tilføj token forbrug sektion',
        'app/api/ai/chat/route.ts — tilføj budget check FØR Claude kald',
        'app/api/subscription/track-tokens/route.ts — tilføj budget alert trigger',
        'app/lib/service-manager-alerts.ts — tilføj ai_budget_warning',
      ]),
      lv('Effort', 'M (3-5 dage)'),
      lv('Risk', 'Høj uden — uventet stort forbrug kan koste tusindvis af kroner'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 6: Supabase database resource monitoring
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P1][OPS] Supabase database resource monitoring (størrelse, connections, performance)',
    issueType: 'Story',
    priority: 'High',
    labels: ['ops', 'monitoring', 'database', 'supabase', 'service-manager', 'p1'],
    description: [
      h('Problem'),
      p('Supabase database monitoreres KUN med et simpelt count(*) ping i daily-status. Kritiske metrics som storage-forbrug, connection pool, slow queries, og tabel-vækst trackes ikke.'),
      h('Hvad der skal monitoreres'),
      bl([
        'Database størrelse (MB) vs. plan limit — alert ved 80%',
        'Connection pool: aktive connections vs. max (Supabase free: 50, pro: 200)',
        'Tabel-vækst: audit_log, ai_messages, recent_entities størrelse over tid',
        'Slow queries (>1000ms) — kræver pg_stat_statements extension',
        'Dead tuples / bloat (autovacuum effektivitet)',
        'Index usage ratio (ubrugte indexes = unødvendig overhead)',
      ]),
      h('Implementering'),
      cb(
        `-- Queries til monitoring (kør via Supabase service role):

-- Database størrelse
SELECT pg_database_size(current_database()) / 1024 / 1024 AS size_mb;

-- Aktive connections
SELECT count(*) AS active_connections
FROM pg_stat_activity
WHERE state = 'active';

-- Største tabeller
SELECT schemaname, relname, pg_total_relation_size(schemaname||'.'||relname) / 1024 / 1024 AS size_mb
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(schemaname||'.'||relname) DESC
LIMIT 20;

-- Dead tuples (bloat)
SELECT schemaname, relname, n_dead_tup, n_live_tup,
  round(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 1) AS dead_pct
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;`,
        'sql'
      ),
      h('Service Manager integration'),
      bl([
        'Tilføj database metrics til /api/health?deep=true',
        'Tilføj til daily-status rapport: DB size, top 10 tabeller, connection count',
        'Service Manager issue types: "db_storage_warning" (80%), "db_storage_critical" (90%)',
        'Vis database metrics i admin dashboard (ny sektion eller under service-manager)',
      ]),
      h('Alert tresholds'),
      bl([
        'Storage > 80% af plan limit → WARNING email',
        'Storage > 90% → CRITICAL alert + JIRA P1 ticket',
        'Connections > 80% af max → WARNING',
        'Dead tuples > 20% af tabel → WARNING (vacuum needed)',
      ]),
      lv('Effort', 'M (3-5 dage)'),
      lv('Risk', 'Høj uden — database full = total service outage'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 7: Upstash Redis monitoring
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P1][OPS] Upstash Redis resource monitoring (memory, keys, eviction)',
    issueType: 'Task',
    priority: 'High',
    labels: ['ops', 'monitoring', 'redis', 'upstash', 'p1'],
    description: [
      h('Problem'),
      p('Redis bruges til rate limiting (global + per-endpoint) og search caching. Hvis Redis løber tør for memory, evictes rate limit keys → rate limiting stopper → API kan overbelastes.'),
      h('Hvad der skal monitoreres'),
      bl([
        'Memory brugt vs. plan limit (Upstash free: 256MB)',
        'Total key count',
        'Eviction rate (keys der smittes ud af memory)',
        'Command latency (gennemsnitlig response tid)',
        'Daily command count (forbrug vs. plan limit)',
      ]),
      h('Implementering'),
      bl([
        'Upstash REST API: REDIS_REST_URL + REDIS_REST_TOKEN',
        'Command: INFO memory, INFO stats, DBSIZE',
        'Tilføj til /api/health?deep=true og daily-status cron',
        'Alert: memory > 80% → WARNING, > 90% → CRITICAL',
      ]),
      lv('Effort', 'S (1-2 dage)'),
      lv('Risk', 'Medium — Redis OOM = rate limiting failure → potential abuse'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 8: Automated rollback capability
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P1][OPS] Automatisk rollback i Release Agent ved fejlslået deploy',
    issueType: 'Story',
    priority: 'High',
    labels: ['ops', 'release-agent', 'rollback', 'service-manager', 'p1'],
    description: [
      h('Problem'),
      p('Release Agent kan create-hotfix, deploy-to-test, og promote-to-prod. Men der er INGEN rollback-funktion. Hvis en deploy introducerer fejl, kræves manuelt revert via GitHub/Vercel.'),
      h('Nuværende flow'),
      cb(
        `Hotfix approved → Release Agent creates branch + PR → PR merged → Vercel deploys
→ Service Manager detekterer fejl (hourly scan) → ???? (ingen automatisk rollback)`,
        'text'
      ),
      h('Ønsket flow'),
      cb(
        `Deploy merged → Vercel builds → Service Manager scan efter 15 min →
If new errors > previous baseline → AUTOMATIC ROLLBACK:
  1. Revert commit via GitHub API
  2. Vercel redeploys til forrige version
  3. CRITICAL alert: "Automatisk rollback udført — [årsag]"
  4. JIRA ticket oprettet med deploy diff og error details`,
        'text'
      ),
      h('Implementering'),
      bl([
        'Ny Release Agent action: "rollback"',
        '  - Input: commit SHA at revert to (typisk forrige deploy)',
        '  - GitHub API: POST /repos/{owner}/{repo}/git/refs (revert commit)',
        '  - Vercel: trigger redeploy af forrige commit',
        '  - Notification: email + SMS + JIRA ticket',
        'Post-deploy health check:',
        '  - Service Manager kører scan 15 minutter efter merge til main',
        '  - Sammenligner error count med pre-deploy baseline',
        '  - Hvis errors > baseline + 3 → trigger rollback',
        'Manual rollback:',
        '  - Ny knap i Release Manager UI: "Rollback til forrige version"',
        '  - Kræver RELEASE_CONFIRMATION_TOKEN (samme guard som promote-to-prod)',
      ]),
      h('Berørte filer'),
      bl([
        'app/api/admin/release-agent/route.ts — tilføj "rollback" action',
        'app/api/cron/service-scan/route.ts — tilføj post-deploy baseline comparison',
        'app/dashboard/admin/release-manager/ReleaseManagerClient.tsx — rollback knap',
      ]),
      lv('Effort', 'L (1-2 uger)'),
      lv('Risk', 'Medium — automatisk rollback kræver robust baseline comparison for at undgå false positives'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 9: Checkly synthetic monitoring
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P1][OPS] Implementer Checkly synthetic monitoring checks',
    issueType: 'Task',
    priority: 'High',
    labels: ['ops', 'monitoring', 'checkly', 'synthetic', 'p1'],
    description: [
      h('Problem'),
      p('Checkly er konfigureret (checkly.config.ts) med EU regions og check-discovery (__checks__/**/*.check.ts), men der er INGEN faktiske check-filer implementeret. Synthetic monitoring kører ikke.'),
      h('Checks der skal oprettes'),
      bl([
        '__checks__/health.check.ts — /api/health endpoint (hver 5. min)',
        '__checks__/login.check.ts — Login page renders korrekt',
        '__checks__/dashboard.check.ts — Dashboard loads after auth',
        '__checks__/search.check.ts — Søgning returnerer resultater',
        '__checks__/property-detail.check.ts — Ejendomsside loader',
        '__checks__/company-detail.check.ts — Virksomhedsside loader',
        '__checks__/stripe-checkout.check.ts — Checkout page accessible',
        '__checks__/external-api.check.ts — External API probes (Datafordeler, CVR)',
      ]),
      h('Checkly alert integration'),
      bl([
        'Alert channel: Email til support@pecuniait.com',
        'Webhook alert → /api/cron/monitor-email (integreres med Service Manager)',
        'Degradation threshold: 2 failures i træk → alert',
        'Recovery notification: send "resolved" when check passes again',
      ]),
      lv('Effort', 'S (1-2 dage)'),
      lv('Risk', 'Lav — additive monitoring; ingen eksisterende funktionalitet påvirkes'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 10: Centralized log aggregation
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P2][OPS] Centraliseret log aggregation (Vercel logs → Sentry/Logtail)',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['ops', 'logging', 'observability', 'p2'],
    description: [
      h('Problem'),
      p('Server-side logs eksisterer kun som ephemere Vercel runtime logs. Når en serverless function afslutter, forsvinder loggen. Der er ingen mulighed for at søge i historiske logs, correlere requests, eller analysere patterns.'),
      h('Nuværende tilstand'),
      bl([
        '✅ app/lib/logger.ts — structured logger (suppresses non-errors i prod)',
        '✅ app/lib/requestLogger.ts — structured JSON med timestamp, method, path, status, duration',
        '✅ x-request-id header genereres i proxy.ts for correlation',
        '✅ Sentry fanger errors men IKKE alle log entries',
        '❌ Ingen persistent log storage',
        '❌ Ingen log search/query capability',
        '❌ Ingen log-baseret alerting (f.eks. "5x 500 errors på /api/vurdering i 10 min")',
      ]),
      h('Anbefalede løsninger'),
      bl([
        'Option A: Vercel Log Drains → Logtail/Better Stack (nativ Vercel integration)',
        'Option B: Vercel Log Drains → Datadog (mere avanceret, dyrere)',
        'Option C: Sentry breadcrumbs + performance monitoring (allerede delvist konfigureret)',
        'Anbefaling: Option A (Logtail) — bedst balance mellem pris og funktionalitet',
      ]),
      h('Implementering'),
      bl([
        '1. Opret Logtail/Better Stack konto',
        '2. Konfigurer Vercel Log Drain (Project Settings → Log Drains)',
        '3. Opret dashboards: Error rate, latency percentiles, top endpoints',
        '4. Opret alerts: Error spike, latency spike, 5xx rate > threshold',
        '5. Integrer med Service Manager: log-baseret alerts trigger service-scan issues',
      ]),
      lv('Effort', 'M (3-5 dage inkl. dashboard setup)'),
      lv('Risk', 'Lav — additive; Vercel Log Drains er native integration'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 11: Service Manager scan expansion
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P2][OPS] Udvid Service Manager scan med infrastructure + resource checks',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['ops', 'service-manager', 'monitoring', 'expansion', 'p2'],
    description: [
      h('Kontekst'),
      p('Service Manager scanner pt. KUN Vercel deployment status + runtime error events. Med de nye health checks (BIZZ tickets ovenfor) kan Service Manager udvides til at scanne hele infrastrukturen og oprette issues for alle anomalier.'),
      h('Nye issue types for Service Manager'),
      cb(
        `// Eksisterende (4):
type: 'build_error' | 'runtime_error' | 'type_error' | 'config_error'

// Nye (8):
type: 'infrastructure_warning'   // DB connections high, Redis memory high
type: 'infrastructure_error'     // DB unreachable, Redis OOM
type: 'certificate_expiry'       // mTLS cert expires soon
type: 'external_api_down'        // Datafordeler, CVR, Tinglysning etc.
type: 'external_api_slow'        // Response >2000ms
type: 'cron_failure'             // Cron job fejlet eller missing heartbeat
type: 'ai_budget_warning'        // Claude token budget >80%
type: 'resource_exhaustion'      // Storage, connections, rate limits near capacity`,
        'typescript'
      ),
      h('Udvidet scan flow'),
      cb(
        `Hourly service-scan:
  1. [Existing] Check Vercel deployments → build_error
  2. [Existing] Check Vercel runtime logs → runtime_error
  3. [NEW] Call /api/health?deep=true → infrastructure_* issues
  4. [NEW] Check cron_heartbeats → cron_failure issues
  5. [NEW] Check cert expiry → certificate_expiry issues
  6. [NEW] Check AI token budget → ai_budget_warning issues
  7. [NEW] Probe external APIs → external_api_* issues
  8. Aggregate all issues → save to service_manager_scans
  9. Critical issues → immediate alert (email + SMS)
  10. All issues → daily digest`,
        'text'
      ),
      h('Service Manager dashboard udvidelse'),
      bl([
        'Ny "Infrastructure" tab i admin dashboard',
        'Traffic light indicators: DB (🟢/🟡/🔴), Redis (🟢/🟡/🔴), APIs (🟢/🟡/🔴), Certs (🟢/🟡/🔴)',
        'Historisk trend: resource usage over seneste 7 dage',
        'Quick actions: "Trigger manual scan", "Force cert check", "Probe APIs now"',
      ]),
      h('Auto-fix integration'),
      p('Infrastructure issues kan typisk IKKE auto-fixes af Claude (de kræver operational actions, ikke kode-ændringer). Men Service Manager kan:'),
      bl([
        'Oprette JIRA tickets automatisk for infrastructure issues',
        'Eskalere via SMS for critical issues',
        'Foreslå operational runbooks (link til docs)',
        'Trigger Vercel redeploy for cache-relaterede issues',
      ]),
      h('Berørte filer'),
      bl([
        'app/api/cron/service-scan/route.ts — udvid med infrastruktur-checks',
        'app/api/admin/service-manager/scan/route.ts — udvid med nye issue types',
        'app/lib/service-manager-alerts.ts — tilføj nye critical criteria',
        'app/dashboard/admin/service-manager/ServiceManagerClient.tsx — ny infrastructure sektion',
        'supabase/migrations/ — evt. nye tabeller (cron_heartbeats)',
      ]),
      lv('Effort', 'L (1-2 uger — afhænger af health check + heartbeat tickets)'),
      lv('Risk', 'Lav — bygger på eksisterende Service Manager arkitektur'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 12: Stripe webhook & payment monitoring
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P2][OPS] Stripe webhook delivery + payment failure monitoring',
    issueType: 'Task',
    priority: 'Medium',
    labels: ['ops', 'monitoring', 'stripe', 'payments', 'p2'],
    description: [
      h('Problem'),
      p('Stripe webhooks er implementeret med signatur-verifikation, men der er ingen monitoring af: webhook delivery failures (Stripe sender men BizzAssist svarer ikke), payment failure rate trending, eller subscription churn alerts.'),
      h('Hvad der mangler'),
      bl([
        'Webhook delivery failure tracking — Stripe retrier automatisk, men BizzAssist ved ikke om webhooks misses',
        'Payment failure rate — trend over tid (normal vs. anomali)',
        'Subscription churn alerts — uventet høj churn rate',
        'Webhook processing latency — for langsom processing kan timeout',
        'Failed event types — hvilke events fejler oftest?',
      ]),
      h('Løsning'),
      bl([
        'Log webhook events til ny tabel: stripe_webhook_log (event_type, status, processing_time_ms, error, created_at)',
        'Tilføj til daily-report: webhook success rate, payment failure count, churn rate',
        'Alert: payment failure rate > 10% i 24 timer → WARNING',
        'Alert: 5+ webhook processing failures i 1 time → CRITICAL',
        'Stripe Dashboard webhook logs kan også bruges som backup monitoring',
      ]),
      lv('Effort', 'S (1-2 dage)'),
      lv('Risk', 'Medium — missed webhooks kan betyde subscription-status ude af sync'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 13: Vercel resource usage alerts
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P2][OPS] Vercel resource usage monitoring (function duration, bandwidth, build minutes)',
    issueType: 'Task',
    priority: 'Medium',
    labels: ['ops', 'monitoring', 'vercel', 'resources', 'p2'],
    description: [
      h('Problem'),
      p('Vercel har plan-baserede limits for serverless function duration, bandwidth, og build minutes. BizzAssist monitorerer deployment status men IKKE resource usage. Overskridelse kan betyde throttling eller ekstra-fakturering.'),
      h('Hvad der skal monitoreres'),
      bl([
        'Function Execution Duration — slow functions kan timeout (10s hobby, 60s pro)',
        'Bandwidth — CDN + API traffic mod plan limit',
        'Build Minutes — CI/CD usage mod plan limit',
        'Serverless Function Invocations — antal kald mod plan limit',
        'Edge Function Invocations — antal edge kald',
        'Cron Job Invocations — 500/dag (pro plan)',
      ]),
      h('Implementering'),
      bl([
        'Vercel REST API: GET /v6/usage (kræver VERCEL_API_TOKEN)',
        'Tilføj til daily-report cron: resource usage som % af limit',
        'Alert: >80% af any limit → WARNING i daily-report',
        'Alert: >95% → CRITICAL alert email',
        'Vis i Service Manager dashboard: usage bars per resource',
      ]),
      lv('Effort', 'S (1-2 dage)'),
      lv('Risk', 'Medium — overskridelse kan betyde service degradation eller uventet fakturering'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // 14: Alert escalation & on-call
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P2][OPS] Alert escalation policy og on-call rotation',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['ops', 'alerting', 'escalation', 'on-call', 'p2'],
    description: [
      h('Problem'),
      p('Alle alerts sendes til en enkelt email (support@pecuniait.com). Der er ingen eskalering, ingen on-call rotation, og ingen garanti for at alerts læses inden for SLA.'),
      h('Nuværende alert-kanaler'),
      bl([
        'Email: support@pecuniait.com (alle alerts)',
        'SMS: Twilio til ét nummer (kun critical issues fra Release Agent)',
        'JIRA: tickets oprettes af GitHub Actions ved CI failures',
        'Ingen Slack, PagerDuty, eller OpsGenie integration',
      ]),
      h('Ønsket escalation policy'),
      cb(
        `Level 1 (0-15 min):
  Email + Slack notification til #ops channel

Level 2 (15-30 min, ingen ack):
  SMS til on-call person

Level 3 (30-60 min, ingen ack):
  SMS til backup on-call + telefonopkald

Level 4 (60+ min, ingen ack):
  Eskalér til Jakob Juul Rasmussen (CEO/CTO)`,
        'text'
      ),
      h('Implementering'),
      bl([
        'Option A: OpsGenie/PagerDuty integration (dedikeret on-call platform)',
        'Option B: Custom escalation i app/lib/service-manager-alerts.ts:',
        '  - alert_acknowledgments tabel (alert_id, acknowledged_by, acknowledged_at)',
        '  - Escalation cron (hvert 15. min): check unacknowledged alerts → eskalér',
        '  - On-call schedule tabel (week, primary_email, backup_email, phone)',
        'Anbefaling: OpsGenie (Atlassian) — integrerer med JIRA',
      ]),
      lv('Effort', 'M (3-5 dage for custom, 1-2 dage for OpsGenie)'),
      lv('Risk', 'Høj uden — kritiske alerts kan overses i weekenden eller om natten'),
    ],
  },
];

async function main() {
  console.log('Creating service management & operations JIRA tickets...\n');

  let epicKey = null;

  for (const ticket of tickets) {
    try {
      const result = await createIssue(ticket);
      const key = result.key;

      if (ticket.issueType === 'Epic') {
        epicKey = key;
        console.log(`✓ EPIC ${key}: ${ticket.summary}`);
      } else {
        console.log(`  ✓ ${key}: ${ticket.summary}`);
        if (epicKey) {
          try {
            await jiraRequest('POST', '/issueLink', {
              type: { name: 'Epic-Story Link' },
              inwardIssue: { key },
              outwardIssue: { key: epicKey },
            });
          } catch { /* silently skip */ }
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`✗ FAILED: ${ticket.summary}`);
      console.error(`  ${err.message}\n`);
    }
  }

  console.log('\nDone! Check https://bizzassist.atlassian.net/jira/software/projects/BIZZ/boards');
}

main().catch(console.error);
