/**
 * BizzAssist — Enterprise, IT Security & Go-Live Readiness JIRA Tickets
 *
 * Based on comprehensive audit covering:
 * - OWASP security review
 * - ISO 27001 compliance
 * - GDPR deep audit
 * - Infrastructure readiness
 * - Test coverage gaps
 * - Dependency vulnerabilities
 *
 * Run: JIRA_API_TOKEN=<token> node scripts/create-go-live-readiness-tickets.mjs
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

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const heading = (text, level = 3) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const bulletList = (items) => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [p(item)] })),
});
const codeBlock = (text, language = '') => ({
  type: 'codeBlock',
  attrs: { language },
  content: [{ type: 'text', text }],
});
const labelValue = (label, value) => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: `${label}: `, marks: [{ type: 'strong' }] },
    { type: 'text', text: value },
  ],
});

const tickets = [
  // ── EPIC ─────────────────────────────────────────────────────────────────
  {
    summary: 'EPIC: Go-live readiness — security, compliance & infrastructure audit',
    issueType: 'Epic',
    priority: 'Highest',
    labels: ['go-live', 'security', 'compliance', 'audit'],
    description: [
      p(
        'Enterprise readiness audit gennemført 14. april 2026. Dækker OWASP, ISO 27001, GDPR, infrastruktur, test coverage og dependency security. Alle findings er prioriteret efter go-live impact.'
      ),
      heading('Audit-områder'),
      bulletList([
        'P0 (BLOCKER) — Skal fixes FØR go-live: 7 tickets',
        'P1 (CRITICAL) — Skal fixes inden for 1. sprint: 5 tickets',
        'P2 (IMPORTANT) — Inden for 1. kvartal: 4 tickets',
      ]),
      heading('Positive findings'),
      bulletList([
        '✅ Nonce-baseret CSP implementeret korrekt',
        '✅ Komplet HTTP security headers (HSTS 2 år, X-Frame-Options DENY)',
        '✅ Stærk login throttling (15-min lockout ved 5 forsøg)',
        '✅ MFA/AAL2 enforcement i proxy.ts',
        '✅ PII masking i Sentry replays (maskAllText + blockAllMedia)',
        '✅ Sikker fil-upload validering (MIME whitelist, 1MB limit)',
        '✅ Rate limiting i to lag (global + per-endpoint)',
        '✅ Ingen hardcoded secrets i source code',
        '✅ RLS isolation tests i CI',
        '✅ Struktureret logging uden PII (ISO 27001 A.12.4)',
        '✅ 61 testfiler, 8 CI jobs, pre-commit hooks enforced',
      ]),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // P0 — BLOCKERS (must fix before go-live)
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P0][SECURITY] Opgrader Next.js til 16.2.3+ — DoS sårbarhed (GHSA-q4gf-8mx6-v5v3)',
    issueType: 'Task',
    priority: 'Highest',
    labels: ['go-live', 'security', 'vulnerability', 'p0', 'blocker'],
    description: [
      heading('Sårbarhed'),
      p(
        'Next.js 16.0.0-16.2.2 har en HIGH severity Denial of Service sårbarhed med Server Components (GHSA-q4gf-8mx6-v5v3). BizzAssist kører pt. en sårbar version.'
      ),
      heading('Også fundet'),
      p(
        'follow-redirects: Moderate — lækker Custom Auth Headers til Cross-Domain Redirects (GHSA-r4q5-vmmm-2653).'
      ),
      heading('Fix'),
      codeBlock('npm audit fix --force\n# Verificer: npm audit', 'bash'),
      heading('Verifikation'),
      bulletList([
        'npm audit viser 0 high/critical',
        'npm run build succeeds',
        'npm run test passes',
        'E2E tests passes',
      ]),
      labelValue('Effort', 'XS (< 1 dag)'),
      labelValue('Risk', 'Lav — minor version bump; test suite fanger regressioner'),
    ],
  },

  {
    summary: '[P0][SECURITY] Tilføj authentication middleware til 7 uautoriserede data-routes',
    issueType: 'Task',
    priority: 'Highest',
    labels: ['go-live', 'security', 'auth', 'p0', 'blocker'],
    description: [
      heading('Finding'),
      p(
        '7 kerne-data API routes er tilgængelige UDEN authentication. Ejendomsdata, vurderinger, ejerskab og tinglysning kan hentes af enhver der kender URL-formatet.'
      ),
      heading('Uautoriserede routes'),
      bulletList([
        '/api/tinglysning — mTLS til ekstern service, men ingen bruger-auth check',
        '/api/vurdering — OAuth token til Datafordeler, men ingen bruger-auth',
        '/api/ejerskab — OAuth token til EJF, men ingen bruger-auth',
        '/api/matrikel — ingen auth overhovedet',
        '/api/bbr/bbox — ingen auth',
        '/api/plandata — ingen auth',
        '/api/jord — ingen auth',
      ]),
      heading('Fix'),
      bulletList([
        'Tilføj resolveTenantId() kald øverst i hver route (per CLAUDE.md krav)',
        'Return 401 hvis uautoriseret',
        'Alternativt: Opret global middleware.ts med auth check for /api/* (undtagen /api/auth/*, /api/public/*, /api/health, /api/ping)',
      ]),
      heading('Bemærk'),
      p(
        'Disse routes bruger allerede rate limiting — men rate limiting erstatter IKKE authentication. En uautoriseret bruger kan stadig hente 60 requests/minut af ejendomsdata.'
      ),
      labelValue('Effort', 'S (1-2 dage)'),
      labelValue('Risk', 'KRITISK — produktionsdata tilgængelig uden login'),
    ],
  },

  {
    summary: '[P0][GDPR] Slet ai_conversations ved kontosletning — Article 17 violation',
    issueType: 'Task',
    priority: 'Highest',
    labels: ['go-live', 'gdpr', 'compliance', 'p0', 'blocker'],
    description: [
      heading('Finding'),
      p(
        'Når en bruger sletter sin konto via /api/user/delete-account, slettes recent_entities, saved_entities, notifications, recent_searches, activity_log korrekt. MEN ai_conversations og ai_messages slettes IKKE — de forbliver i databasen i op til 12 måneder (purge-old-data cron).'
      ),
      heading('GDPR violation'),
      p(
        'Article 17(1) kræver at persondata slettes "without undue delay" ved anmodning. 12 måneders forsinkelse er en klar overtrædelse.'
      ),
      heading('Berørte tabeller'),
      bulletList([
        'ai_conversations — brugerens chat-historik med AI',
        'ai_messages — individuelle beskeder (kan indeholde PII brugeren har skrevet)',
        'document_embeddings — pgvector embeddings uploadet af brugeren (knowledge base)',
      ]),
      heading('Fix'),
      codeBlock(
        `// I /api/user/delete-account/route.ts, tilføj FØR tenant schema drop:
await supabase.from('ai_messages').delete().eq('conversation_id',
  supabase.from('ai_conversations').select('id').eq('user_id', userId)
);
await supabase.from('ai_conversations').delete().eq('user_id', userId);
await supabase.from('document_embeddings').delete().eq('uploaded_by', userId);`,
        'typescript'
      ),
      labelValue('Effort', 'XS (< 1 dag)'),
      labelValue('Risk', 'GDPR bøde-risiko — Datatilsynet kan pålægge bøde for manglende sletning'),
    ],
  },

  {
    summary: '[P0][ISO 27001] Tilføj audit_log til 40+ write operations der mangler det',
    issueType: 'Story',
    priority: 'Highest',
    labels: ['go-live', 'compliance', 'audit-log', 'iso27001', 'p0', 'blocker'],
    description: [
      heading('Finding'),
      p(
        'CLAUDE.md kræver: "All writes log to tenant.audit_log". ISO 27001 A.12.4 kræver logging af alle sikkerhedsrelevante hændelser. 40+ write operations logger IKKE til audit_log.'
      ),
      heading('Routes uden audit logging (udvalg)'),
      bulletList([
        '/api/tracked — POST/DELETE (follow/unfollow ejendomme, virksomheder, personer)',
        '/api/notifications — DELETE (slet notifikationer)',
        '/api/links — POST/DELETE (link verifikation)',
        '/api/recents — POST/DELETE (seneste besøg)',
        '/api/profile — PATCH (profil-opdateringer)',
        '/api/session-settings — alle writes',
        '/api/subscription/* — ændringer i abonnementsstatus',
        '/api/preferences — delvist (nogle operationer mangler)',
        '/api/ai/conversations — slet samtaler',
      ]),
      heading('Løsning'),
      bulletList([
        'Opret shared audit helper: app/lib/auditLog.ts med logAudit(tenantId, userId, action, resourceType, resourceId, metadata)',
        'Tilføj fire-and-forget audit log kald til alle write operations',
        'Brug konsistent action naming: "resource.action" (f.eks. "tracked.create", "notification.delete")',
        'Test: grep for alle POST/PUT/PATCH/DELETE handlers og verificer audit log kald',
      ]),
      labelValue('Effort', 'M (3-5 dage)'),
      labelValue('Risk', 'ISO 27001 non-conformity — kan blokere certificering'),
    ],
  },

  {
    summary: '[P0][SECURITY] Tilføj Zod input validation til alle API routes',
    issueType: 'Story',
    priority: 'Highest',
    labels: ['go-live', 'security', 'validation', 'zod', 'p0', 'blocker'],
    description: [
      heading('Finding'),
      p(
        'Kun 7 af 136 API routes bruger Zod schema validation. De resterende 129 routes parser JSON input med req.json() og manual destructuring — ingen type- eller range-validering.'
      ),
      heading('Routes med Zod (7)'),
      bulletList([
        '/api/tokens — ✓',
        '/api/ai/feedback — ✓',
        '/api/ai/conversations — ✓',
        '/api/ai/conversations/[id]/messages — ✓',
        '/api/stripe/create-checkout — ✓',
        '/api/search — ✓',
        '/api/onboarding/save — ✓',
      ]),
      heading('Risiko uden validation'),
      bulletList([
        'Type confusion attacks (string where number expected)',
        'Prototype pollution via crafted JSON',
        'DoS via oversized payloads (ingen body size check)',
        'Business logic bypass via unexpected field values',
      ]),
      heading('Prioriteret approach'),
      bulletList([
        'Fase 1 (P0): Alle routes der accepterer POST/PUT/PATCH body — tilføj Zod schema',
        'Fase 2 (P1): Alle routes med query params — tilføj Zod validation',
        'Fase 3 (P2): Shared validation middleware der automatisk validerer baseret på route schema',
      ]),
      heading('Pattern'),
      codeBlock(
        `import { z } from 'zod';

const BodySchema = z.object({
  bfeNummer: z.number().int().positive(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  const { bfeNummer, offset, limit } = parsed.data;
  // ...
}`,
        'typescript'
      ),
      labelValue('Effort', 'L (1-2 uger for alle routes)'),
      labelValue('Risk', 'Høj uden — OWASP A03:2021 Injection er top-3 sårbarhed'),
    ],
  },

  {
    summary: '[P0][SECURITY] Installér pre-commit secret scanning (gitleaks)',
    issueType: 'Task',
    priority: 'Highest',
    labels: ['go-live', 'security', 'secrets', 'p0', 'blocker'],
    description: [
      heading('Finding'),
      p(
        'Ingen pre-commit secret scanning tool er installeret. .husky/pre-commit kører lint-staged + npm test, men scanner IKKE for accidentally staged secrets, API keys, eller certifikater.'
      ),
      heading('Risiko'),
      p(
        'Alle secrets i .env.local (30+ keys inkl. Stripe live key, Supabase service role, Anthropic API key) kan ved en fejl committes til git. Når det sker, er secret rotation nødvendig for ALLE berørte services.'
      ),
      heading('Fix'),
      codeBlock(
        `# Installér gitleaks
brew install gitleaks  # eller: npm install --save-dev @gitleaks/cli

# Tilføj til .husky/pre-commit (før lint-staged):
gitleaks protect --staged --verbose

# Tilføj .gitleaks.toml for custom rules:
[allowlist]
paths = [".env.example", "docs/"]`,
        'bash'
      ),
      heading('Alternativ'),
      p(
        'trufflehog eller detect-secrets er også acceptable. GitHub Advanced Security (GHAS) scanner automatisk men fanger kun EFTER push — pre-commit er bedre.'
      ),
      labelValue('Effort', 'XS (< 1 dag)'),
      labelValue('Risk', 'Kritisk hvis et secret committes — kræver rotation af alle berørte keys'),
    ],
  },

  {
    summary: '[P0][GDPR] Tilføj Mapbox til privacy policy + verificer Anthropic DPA',
    issueType: 'Task',
    priority: 'Highest',
    labels: ['go-live', 'gdpr', 'privacy', 'dpa', 'p0', 'blocker'],
    description: [
      heading('Finding 1: Mapbox mangler i privacy policy'),
      p(
        'Mapbox bruges til ejendomskort (PropertyMap.tsx) og modtager ejendomskoordinater og brugerens viewport. Mapbox er IKKE opført som sub-processor i app/privacy/PrivacyPageClient.tsx trods at DATA_CLASSIFICATION.md dokumenterer det som dataleverandør.'
      ),
      heading('Finding 2: Anthropic DPA ikke verificeret'),
      p(
        'AI chat (/api/ai/chat) sender bruger-beskeder, virksomhedsnavne, person-navne, ejendomsadresser og tool-resultater til Claude API. ISMS.md nævner "DPA required before go-live" men ingen verificering er fundet i kode eller docs.'
      ),
      heading('Fix'),
      bulletList([
        'Tilføj Mapbox Inc. (USA) til processor-listen i app/privacy/PrivacyPageClient.tsx',
        'Dokumenter hvilke data Mapbox modtager: viewport coordinates, map tile requests, IP adresse',
        'Verificer at Anthropic DPA er underskrevet (kontakt legal/DPO)',
        'Tilføj DPA reference i docs/security/ISMS.md under A.15 (Supplier Relationships)',
        'Opdater privacy policy "Sidst opdateret" dato',
      ]),
      heading('GDPR reference'),
      p(
        'Article 28(3): "Processing by a processor shall be governed by a contract... that sets out the subject-matter and duration of the processing." Manglende DPA = GDPR violation.'
      ),
      labelValue('Effort', 'XS (< 1 dag for kode-ændringer; DPA er legal proces)'),
      labelValue('Risk', 'GDPR bøde-risiko — manglende processor i privacy policy + manglende DPA'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // P1 — CRITICAL (first sprint after launch)
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P1][SECURITY] Server-side admin auth check på /dashboard/admin/* sider',
    issueType: 'Task',
    priority: 'High',
    labels: ['go-live', 'security', 'admin', 'auth', 'p1'],
    description: [
      heading('Finding'),
      p(
        'Admin-sider (/dashboard/admin/*) bruger force-dynamic rendering men validerer IKKE admin-rolle server-side. Admin-check sker kun client-side via API kald efter render. En bruger kan se page source/layout før auth-check.'
      ),
      heading('Berørte sider'),
      bulletList([
        '/dashboard/admin/users',
        '/dashboard/admin/analytics',
        '/dashboard/admin/billing',
        '/dashboard/admin/security',
        '/dashboard/admin/service-manager',
        '/dashboard/admin/plans',
        '/dashboard/admin/ai-media-agents',
        '/dashboard/admin/ai-feedback',
        '/dashboard/admin/release-manager',
      ]),
      heading('Fix'),
      bulletList([
        'Tilføj server-side auth check i app/dashboard/admin/layout.tsx',
        'Brug getUser() + role check → redirect til /dashboard hvis ikke admin',
        'Alternativt: middleware.ts catch-all for /dashboard/admin/* paths',
      ]),
      labelValue('Effort', 'XS (< 1 dag)'),
      labelValue('Risk', 'Medium — data lækker ikke (API er beskyttet) men UI layout kan eksposes'),
    ],
  },

  {
    summary: '[P1][COMPLIANCE] Fjern PII fra service-scan cron log output',
    issueType: 'Task',
    priority: 'High',
    labels: ['go-live', 'compliance', 'pii', 'logging', 'p1'],
    description: [
      heading('Finding'),
      p(
        'app/api/cron/service-scan/route.ts linje 606 logger admin email-adresse: console.log("[service-scan] Alert-email sendt til", TO_ADDRESS). Dette overtræder ISO 27001 A.12.4 og CLAUDE.md reglen "No PII in logs".'
      ),
      heading('Fix'),
      codeBlock(
        `// Erstat:
console.log('[service-scan] Alert-email sendt til', TO_ADDRESS);
// Med:
console.log('[service-scan] Alert-email sendt');`,
        'typescript'
      ),
      labelValue('Effort', 'XS (5 minutter)'),
      labelValue('Risk', 'Lav teknisk — men compliance-violation'),
    ],
  },

  {
    summary: '[P1][OPS] Opret .env.local.example template + secret rotation dokumentation',
    issueType: 'Task',
    priority: 'High',
    labels: ['go-live', 'ops', 'secrets', 'documentation', 'p1'],
    description: [
      heading('Finding 1'),
      p(
        'Ingen .env.local.example template eksisterer. Nye udviklere har ingen reference for hvilke env vars der kræves. 30+ secrets skal konfigureres korrekt.'
      ),
      heading('Finding 2'),
      p(
        'Ingen dokumenteret secret rotation procedure. ISMS.md nævner rotation men ingen specifik tidsplan eller procedure.'
      ),
      heading('Fix'),
      bulletList([
        'Opret .env.local.example med alle variable og dummy/placeholder værdier',
        'Dokumenter hvilke secrets der er REQUIRED vs OPTIONAL',
        'Grupér efter service (Supabase, Datafordeler, Stripe, etc.)',
        'Tilføj docs/security/SECRET_ROTATION.md med:',
        '  - Rotation schedule per secret-type (90 dage for API keys, 30 dage for cert passwords)',
        '  - Step-by-step rotation procedure per service',
        '  - Emergency rotation procedure (hvis secret lækker)',
      ]),
      labelValue('Effort', 'S (1-2 dage)'),
      labelValue('Risk', 'Medium — onboarding friction + compliance gap'),
    ],
  },

  {
    summary: '[P1][OPS] Opret database restore runbook + kør DR drill',
    issueType: 'Story',
    priority: 'High',
    labels: ['go-live', 'ops', 'disaster-recovery', 'runbook', 'p1'],
    description: [
      heading('Finding'),
      p(
        'ISMS.md dokumenterer RTO=4 timer og RPO=24 timer. Supabase daglige backups + 7-dages PITR er konfigureret. Men der er ingen dokumenteret restore-procedure og ingen testet DR drill.'
      ),
      heading('Hvad mangler'),
      bulletList([
        'Runbook: Step-by-step database restore fra Supabase backup',
        'Runbook: Point-in-time recovery til specifik timestamp',
        'Runbook: Tenant-specifik data recovery (uden fuld restore)',
        'DR drill: Kør restore på non-prod environment og mål faktisk RTO',
        'Dokumentation: Hvem har adgang til at starte restore (navngivne personer)',
        'Alarm: Monitor backup-jobs status (Supabase webhook eller health check)',
      ]),
      heading('Verifikation'),
      p(
        'Kør en fuld restore-drill inden go-live. Mål faktisk RTO og sammenlign med 4-timers target.'
      ),
      labelValue('Effort', 'M (3-5 dage inkl. drill)'),
      labelValue('Risk', 'Høj hvis data-tab opstår uden testet restore-procedure'),
    ],
  },

  {
    summary: '[P1][SECURITY] Tilføj npm audit check i CI og DAST resultater som gate',
    issueType: 'Task',
    priority: 'High',
    labels: ['go-live', 'security', 'ci', 'p1'],
    description: [
      heading('Finding'),
      p(
        'npm audit kører som separat ugentlig workflow (security.yml) men er IKKE en gate i hoved-CI pipeline (ci.yml). En PR med en ny kritisk sårbarhed kan merges uden at npm audit blokerer.'
      ),
      heading('Også fundet'),
      p(
        'OWASP ZAP DAST scanner kører ugentligt (dast.yml) men resultater er ikke integreret som quality gate. Findings rapporteres men blokerer ikke deploy.'
      ),
      heading('Fix'),
      bulletList([
        'Tilføj "npm audit --audit-level=high" som step i ci.yml (efter install, før build)',
        'Konfigurer som required check i GitHub branch protection rules',
        'Evaluer om DAST findings skal blokere merge (mindst high severity)',
        'Tilføj Dependabot alerts integration for automatisk PR creation på vulnerabilities',
      ]),
      labelValue('Effort', 'XS (< 1 dag)'),
      labelValue('Risk', 'Medium — sårbare dependencies kan shippe til produktion'),
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // P2 — IMPORTANT (within first quarter)
  // ═══════════════════════════════════════════════════════════════════════

  {
    summary: '[P2][SECURITY] Udvid Sentry PII-stripping med flere query params',
    issueType: 'Task',
    priority: 'Medium',
    labels: ['go-live', 'security', 'sentry', 'pii', 'p2'],
    description: [
      heading('Finding'),
      p(
        'Sentry beforeSend hook (sentry.client.config.ts) stripper: search, query, q, cvr, bfe, adresse, id. Men andre PII-felter der bruges i URL query params mangler.'
      ),
      heading('Manglende params'),
      bulletList([
        'email — bruges i /api/admin/users?email=...',
        'phone — potentielt i søgninger',
        'enhedsNummer — person-identifikator i /api/cvr-public?enhedsNummer=...',
        'vejnavn, husnr, postnr — adresse-komponenter i /api/cvr?vejnavn=...',
        'navn — person/virksomhedsnavn i søgninger',
      ]),
      heading('Fix'),
      p('Tilføj disse params til SENSITIVE_PARAMS array i sentry.client.config.ts.'),
      labelValue('Effort', 'XS (< 1 dag)'),
      labelValue('Risk', 'Lav — PII kan lække til Sentry men Sentry er access-controlled'),
    ],
  },

  {
    summary: '[P2][COMPLIANCE] Tilføj vector embedding sletning i purge-old-data cron',
    issueType: 'Task',
    priority: 'Medium',
    labels: ['go-live', 'gdpr', 'embeddings', 'purge', 'p2'],
    description: [
      heading('Finding'),
      p(
        'Purge-old-data cron (/api/cron/purge-old-data) sletter 7 datatyper men document_embeddings (pgvector) er IKKE inkluderet. Ved tenant closure droppes hele schema (inkl. embeddings), men for aktive tenants slettes uploadede knowledge-embeddings aldrig automatisk.'
      ),
      heading('Fix'),
      bulletList([
        'Tilføj document_embeddings cleanup til purge-old-data cron',
        'Retention: Slet embeddings for knowledge-docs der er blevet fjernet (deleted_at IS NOT NULL)',
        'Verificer at DELETE /api/knowledge også sletter tilhørende embedding',
      ]),
      labelValue('Effort', 'XS (< 1 dag)'),
      labelValue(
        'Risk',
        'Lav — embeddings er derivative data, men GDPR kræver konsistent sletning'
      ),
    ],
  },

  {
    summary: '[P2][OPS] Evaluer APM-løsning (Datadog/New Relic) for production monitoring',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['go-live', 'ops', 'monitoring', 'apm', 'p2'],
    description: [
      heading('Finding'),
      p(
        'Sentry giver error tracking og basic performance monitoring (Core Web Vitals, transaction sampling). Men der er ingen dedikeret APM med: distributed tracing på tværs af API routes, database query performance monitoring, external API latency dashboards, eller resource utilization alerts.'
      ),
      heading('Nuværende monitoring'),
      bulletList([
        '✅ Sentry: Errors, replays, performance transactions (10% sampling)',
        '✅ /api/health: Basic health check (API + DB connectivity)',
        '✅ Request logging med x-request-id correlation',
        '✅ Upstash Redis analytics for rate limiting',
        '❌ Ingen distributed tracing',
        '❌ Ingen database slow query alerts',
        '❌ Ingen external API latency monitoring (Datafordeler, CVR ES, Tinglysning)',
        '❌ Ingen resource utilization monitoring (Vercel serverless function duration/memory)',
      ]),
      heading('Anbefaling'),
      bulletList([
        'Evaluer: Datadog, New Relic, eller Vercel Analytics Pro',
        'Minimum: External API latency dashboard (Datafordeler response times)',
        'Nice-to-have: Database query performance, serverless function metrics',
      ]),
      labelValue('Effort', 'M (3-5 dage evaluation + setup)'),
      labelValue(
        'Risk',
        'Lav umiddelbart — men vigtig for at opdage performance-problemer proaktivt'
      ),
    ],
  },

  {
    summary: '[P2][SECURITY] Implementer automatisk secret rotation alerts',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['go-live', 'security', 'secrets', 'rotation', 'p2'],
    description: [
      heading('Finding'),
      p(
        '30+ secrets i .env.local har ingen rotation schedule eller reminder system. ISMS.md nævner rotation som princip men der er ingen teknisk enforcement.'
      ),
      heading('Secrets der kræver rotation'),
      bulletList([
        'API keys: Anthropic, Brave Search, Mapbox, Mediastack, Resend (anbefalet: 90 dage)',
        'OAuth secrets: Datafordeler, Google, LinkedIn (anbefalet: 180 dage)',
        'Database: Supabase service role key (anbefalet: 90 dage)',
        'Certifikater: Datafordeler cert, Tinglysning cert (udløbsdato-baseret)',
        'Webhook secrets: Stripe, Cron (anbefalet: 90 dage)',
        'Infrastructure: Upstash Redis, Vercel, GitHub tokens (anbefalet: 90 dage)',
      ]),
      heading('Løsning'),
      bulletList([
        'Opret rotation-calendar (JIRA recurring tasks eller cron-baseret reminder)',
        'Tilføj certifikat-udløbs monitoring (check expiry dato i daily-status cron)',
        'Dokumenter rotation-procedure per service i docs/security/SECRET_ROTATION.md',
        'Overvej: HashiCorp Vault eller AWS Secrets Manager for automatisk rotation',
      ]),
      labelValue('Effort', 'M (3-5 dage)'),
      labelValue('Risk', 'Medium — expired secrets kan forårsage service outage'),
    ],
  },
];

async function main() {
  console.log('Creating go-live readiness JIRA tickets...\n');

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
          } catch {
            // silently skip
          }
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
