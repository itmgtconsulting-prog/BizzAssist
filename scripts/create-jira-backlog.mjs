/**
 * BizzAssist — JIRA Backlog Creation Script
 *
 * Creates all product backlog items in JIRA as Epics, Stories, and Tasks.
 * Epics = Phases, Stories = Feature areas, Tasks = Individual items.
 *
 * Run: node scripts/create-jira-backlog.mjs
 */

const JIRA_HOST = 'bizzassist.atlassian.net';
const JIRA_EMAIL = 'itmgtconsulting@gmail.com';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'BIZZ';

const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE_URL = `https://${JIRA_HOST}/rest/api/3`;

/** Maps our priority labels to JIRA priority names */
const _PRIORITY_MAP = {
  P0: 'Highest',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
  P4: 'Lowest',
};

/** Maps our effort to JIRA story points estimate */
const _EFFORT_MAP = {
  XS: 1,
  S: 2,
  M: 5,
  L: 8,
  XL: 13,
};

// ---------------------------------------------------------------------------
// JIRA API helpers
// ---------------------------------------------------------------------------

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

/** Get available issue types for the project */
async function _getIssueTypes() {
  const data = await jiraRequest('GET', `/project/${PROJECT_KEY}`);
  return data;
}

/** Create a single JIRA issue. Returns { key, id } */
async function createIssue({
  summary,
  description,
  issueType,
  priority,
  labels,
  storyPoints: _storyPoints,
}) {
  const body = {
    fields: {
      project: { key: PROJECT_KEY },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description || summary }],
          },
        ],
      },
      issuetype: { name: issueType },
      priority: { name: priority },
      labels: labels || [],
    },
  };

  const result = await jiraRequest('POST', '/issue', body);
  return result;
}

/** Add a child link (make task belong to epic) */
async function _linkToEpic(issueKey, epicKey) {
  try {
    await jiraRequest('POST', '/issueLink', {
      type: { name: 'Epic-Story Link' },
      inwardIssue: { key: issueKey },
      outwardIssue: { key: epicKey },
    });
  } catch {
    // Epic link type may vary — try parent field approach silently
  }
}

// ---------------------------------------------------------------------------
// BACKLOG DEFINITION
// ---------------------------------------------------------------------------

const backlog = [
  // ── PHASE 1: FOUNDATION ──────────────────────────────────────────────────
  {
    epic: {
      summary: 'PHASE 1 — Foundation: Auth & Database',
      priority: 'Highest',
      labels: ['phase-1', 'foundation'],
    },
    items: [
      {
        summary: '[P0] Supabase project setup (EU West region, extensions, credentials)',
        description:
          'Create Supabase project in EU West region (GDPR), enable pgvector + uuid-ossp + pg_trgm, wire credentials to .env.local, create lib/supabase/client.ts, server.ts and admin.ts.',
        priority: 'Highest',
        effort: 'S',
        labels: ['p0', 'database', 'infrastructure'],
      },
      {
        summary:
          '[P0] Database schema — public shared schema (users, tenants, memberships, subscriptions)',
        description:
          'Create migration 001_public_schema.sql with tables: public.users, public.tenants, public.tenant_memberships, public.subscriptions, public.plans. Enable RLS on all tables with correct policies.',
        priority: 'Highest',
        effort: 'M',
        labels: ['p0', 'database', 'rls'],
      },
      {
        summary: '[P0] Database schema — tenant template schema (per-company isolated data)',
        description:
          'Create migration 002_tenant_schema_template.sql with tables: saved_searches, saved_entities, reports, ai_conversations, ai_messages, ai_context, document_embeddings (pgvector), audit_log. Enable RLS. Create lib/db/tenant.ts scoped client factory.',
        priority: 'Highest',
        effort: 'M',
        labels: ['p0', 'database', 'multi-tenant', 'rls'],
      },
      {
        summary: '[P0] Authentication — Email + password + TOTP 2FA via Supabase Auth',
        description:
          'Wire login/signup forms to Supabase Auth. Add email verification, TOTP 2FA enrollment page at /dashboard/settings/security, 2FA challenge page, password reset flow, session refresh. Activate protected route guard in middleware.ts.',
        priority: 'Highest',
        effort: 'M',
        labels: ['p0', 'auth', 'security', 'iso27001'],
      },
      {
        summary: '[P0] Authentication — Google OAuth ("Sign in with Google")',
        description:
          'Create Google OAuth app, configure in Supabase Auth, wire button to supabase.auth.signInWithOAuth({ provider: "google" }), handle callback at /auth/callback/route.ts, auto-provision tenant on first login.',
        priority: 'Highest',
        effort: 'S',
        labels: ['p0', 'auth', 'oauth'],
      },
      {
        summary: '[P0] Authentication — LinkedIn OAuth ("Sign in with LinkedIn")',
        description:
          'Create LinkedIn OAuth app at developer.linkedin.com, configure linkedin_oidc provider in Supabase Auth, wire button, handle callback, auto-provision tenant on first login.',
        priority: 'Highest',
        effort: 'S',
        labels: ['p0', 'auth', 'oauth'],
      },
      {
        summary: '[P0] Tenant middleware & session management',
        description:
          'Update middleware.ts to read Supabase session, extract tenant_id, redirect unauthenticated users to /login, redirect users with no tenant to /onboarding. Create lib/auth/session.ts and useSession() hook.',
        priority: 'Highest',
        effort: 'M',
        labels: ['p0', 'auth', 'multi-tenant'],
      },
      {
        summary: '[P0] User onboarding flow (/onboarding) — company setup + plan selection',
        description:
          'Create /onboarding page with: Step 1 company name + CVR, Step 2 plan selection (free tier), Step 3 invite team members (optional). Provision tenant schema on completion. Redirect to /dashboard.',
        priority: 'Highest',
        effort: 'M',
        labels: ['p0', 'onboarding', 'ux'],
      },
    ],
  },

  // ── PHASE 2: DATA INTEGRATION ────────────────────────────────────────────
  {
    epic: {
      summary: 'PHASE 2 — Data Integration: CVR, BBR, Tinglysning, DAWA',
      priority: 'High',
      labels: ['phase-2', 'data-integration'],
    },
    items: [
      {
        summary: '[P1] CVR API integration — company data (search, details, financials)',
        description:
          'Register for CVR API access at datacvr.virk.dk. Create lib/data-sources/cvr/client.ts using CVR Elasticsearch API. Build company search, fetch by CVR number, financial figures from annual reports. API route POST /api/data/company/search. Cache in tenant DB. Write unit tests.',
        priority: 'High',
        effort: 'L',
        labels: ['p1', 'data-source', 'cvr', 'companies'],
      },
      {
        summary: '[P1] CVR API integration — person data (directors, board members, roles)',
        description:
          'Build lib/data-sources/cvr/person.ts. Search persons by name. Fetch all current + historical company roles. Person profile data model. API route POST /api/data/person/search. Note: CPR numbers not available — names and roles only.',
        priority: 'High',
        effort: 'M',
        labels: ['p1', 'data-source', 'cvr', 'people'],
      },
      {
        summary: '[P1] DAWA — Danish address register, autocomplete and geocoding',
        description:
          'Integrate DAWA (free public API) at api.dataforsyningen.dk. Build address autocomplete typeahead, address-to-coordinate lookup, reverse geocoding. Integrate autocomplete into all address inputs. Use DAWA address IDs as canonical cross-source identifier.',
        priority: 'High',
        effort: 'S',
        labels: ['p1', 'data-source', 'dawa', 'geocoding'],
      },
      {
        summary: '[P1] BBR / OIS integration — property data (size, type, energy, built year)',
        description:
          'Register for OIS data access at ois.dk or use DAWA + Dataforsyningen free tier. Create lib/data-sources/ois/client.ts. Build property search by address and matrikel/BFE number. Property types, size, energy label, built year. API route POST /api/data/property/search.',
        priority: 'High',
        effort: 'L',
        labels: ['p1', 'data-source', 'bbr', 'properties'],
      },
      {
        summary: '[P1] Tinglysning integration — property ownership, sales history, mortgages',
        description:
          'Register at dataforsyningen.dk. Create lib/data-sources/tinglysning/client.ts. Fetch ownership records for BFE number, purchase prices and dates, mortgage/liens. API route POST /api/data/property/ownership. Cross-reference owner CVR with company data.',
        priority: 'High',
        effort: 'L',
        labels: ['p1', 'data-source', 'tinglysning', 'properties'],
      },
      {
        summary: '[P1] Entity linking & data normalisation — link companies, people, properties',
        description:
          'Create lib/data-sources/entity-linker.ts. Build resolveCompany(), resolveProperty(), resolvePerson() functions that return unified entities with cross-source links. Store in tenant.saved_entities as JSONB. Write tests covering entity linking logic.',
        priority: 'High',
        effort: 'L',
        labels: ['p1', 'data-pipeline', 'entity-linking'],
      },
    ],
  },

  // ── PHASE 3: CORE PAGES ──────────────────────────────────────────────────
  {
    epic: {
      summary: 'PHASE 3 — Core Pages: Search, Profiles, Browse',
      priority: 'High',
      labels: ['phase-3', 'frontend', 'core-ux'],
    },
    items: [
      {
        summary: '[P1] Universal search page (/dashboard/search) — companies, people, properties',
        description:
          'Build /dashboard/search/page.tsx. Single search bar with live suggestions (debounced 300ms). Tab filters: All / Companies / People / Properties. SearchResultCard component. Aggregated search API route hitting CVR + DAWA in parallel. Recent searches from tenant DB. Keyboard navigation. Bilingual.',
        priority: 'High',
        effort: 'M',
        labels: ['p1', 'search', 'frontend'],
      },
      {
        summary: '[P1] Company profile page (/dashboard/companies/[cvr])',
        description:
          'Build full company intelligence view. Sections: Header (name, CVR, status), Key facts, Financial summary with trend chart (last 3 years), Board & Management (links to person profiles), Ownership structure, Linked properties, Company network, Recent CVR changes. Save/watchlist/AI-analyse buttons.',
        priority: 'High',
        effort: 'L',
        labels: ['p1', 'companies', 'frontend'],
      },
      {
        summary: '[P1] Property profile page (/dashboard/properties/[bfe])',
        description:
          'Build property intelligence view. Sections: Header (address, type), Key facts (size, floors, year, energy label), Ownership with history, Transaction history (dates + prices), Mortgage summary, Map view, Nearby properties. Link owner CVR to company profile.',
        priority: 'High',
        effort: 'L',
        labels: ['p1', 'properties', 'frontend'],
      },
      {
        summary: '[P1] Person profile page (/dashboard/people/[id])',
        description:
          'Build business person profile. Sections: Header (name, primary role), Company roles (current + historical), Co-director network, Personally owned properties (from Tinglysning), Risk indicators (dissolved companies). AI-analyse button.',
        priority: 'High',
        effort: 'M',
        labels: ['p1', 'people', 'frontend'],
      },
      {
        summary: '[P1] Companies browse + filter page (/dashboard/companies)',
        description:
          'Browse and filter Danish companies. FilterSidebar with: industry (DB07), size (employees, revenue), location, legal form, status, founded date range. Server-side paginated results. Sort options. Save search button.',
        priority: 'High',
        effort: 'M',
        labels: ['p1', 'companies', 'frontend', 'search'],
      },
      {
        summary: '[P1] Properties browse + filter page (/dashboard/properties)',
        description:
          'Browse and filter properties. Filters: type, location, size range, energy label, built year, owner type. Paginated results list + map view toggle. Reuse FilterSidebar component from companies page.',
        priority: 'High',
        effort: 'M',
        labels: ['p1', 'properties', 'frontend', 'search'],
      },
      {
        summary: '[P1] People browse + filter page (/dashboard/people)',
        description:
          'Search and browse business persons. Search by name, filter by current company / role type / municipality. Paginated results list.',
        priority: 'High',
        effort: 'S',
        labels: ['p1', 'people', 'frontend', 'search'],
      },
    ],
  },

  // ── PHASE 4: MAP ─────────────────────────────────────────────────────────
  {
    epic: {
      summary: 'PHASE 4 — Map Functionality (Mapbox)',
      priority: 'Medium',
      labels: ['phase-4', 'maps'],
    },
    items: [
      {
        summary: '[P2] Map provider setup — Mapbox GL JS integration (dark theme)',
        description:
          'Create Mapbox account, install mapbox-gl + react-map-gl. Create components/Map/MapBase.tsx (dark theme matching app), PropertyMarker.tsx, CompanyMarker.tsx. Store Mapbox token in .env.local.',
        priority: 'Medium',
        effort: 'S',
        labels: ['p2', 'maps', 'infrastructure'],
      },
      {
        summary: '[P2] Property map view — plot filtered properties with clickable pins',
        description:
          'Add Map View tab to /dashboard/properties. Plot filtered properties as pins. Clicking pin opens mini property card popup with link to full profile. Colour-code by type. Cluster at low zoom. Split pane: map + list side by side. Draw-area selection tool.',
        priority: 'Medium',
        effort: 'M',
        labels: ['p2', 'maps', 'properties'],
      },
      {
        summary: '[P2] Company map view — plot companies by location with clustering',
        description:
          'Add Map View tab to /dashboard/companies. Plot company addresses. Cluster by municipality. Optional heatmap mode for density analysis.',
        priority: 'Medium',
        effort: 'S',
        labels: ['p2', 'maps', 'companies'],
      },
      {
        summary: '[P2] Embedded map on property profile page',
        description:
          'Integrate MapBase into /dashboard/properties/[bfe] page. Show property pin + address label. "Nearby properties" toggle showing neighbouring properties within 500m radius.',
        priority: 'Medium',
        effort: 'S',
        labels: ['p2', 'maps', 'properties'],
      },
    ],
  },

  // ── PHASE 5: AI ──────────────────────────────────────────────────────────
  {
    epic: {
      summary: 'PHASE 5 — AI Integration (Claude API + RAG)',
      priority: 'Medium',
      labels: ['phase-5', 'ai'],
    },
    items: [
      {
        summary: '[P2] Claude API integration — replace mock AI chat with real streaming responses',
        description:
          'Add ANTHROPIC_API_KEY. Install @anthropic-ai/sdk. Create lib/ai/claude.ts wrapper. Create streaming API route POST /api/ai/chat using claude-3-5-sonnet. Replace mock 1500ms delay with real streaming tokens. Handle rate limit and context limit errors gracefully.',
        priority: 'Medium',
        effort: 'M',
        labels: ['p2', 'ai', 'claude-api'],
      },
      {
        summary: '[P2] Tenant-scoped AI context (RAG) — company-specific knowledge per tenant',
        description:
          'Create lib/ai/context-builder.ts assembling tenant-specific system prompt. Inject tenant saved entities, recent searches, and procedures into every chat. Store conversation history in tenant.ai_conversations + ai_messages. Build context window management (trim old messages). Enable "what do you know about [company]?" queries.',
        priority: 'Medium',
        effort: 'L',
        labels: ['p2', 'ai', 'rag', 'multi-tenant'],
      },
      {
        summary:
          '[P2] AI Analysis page (/dashboard/analysis) — competitor, due diligence, investment',
        description:
          'Create /dashboard/analysis page. Analysis types: Competitor analysis, Due diligence report, Investment screening, Property market analysis. Structured prompts in lib/ai/prompts/. Formatted markdown output. Save to tenant.reports.',
        priority: 'Medium',
        effort: 'M',
        labels: ['p2', 'ai', 'analysis'],
      },
      {
        summary:
          '[P2] Full AI chat page (/dashboard/chat) — conversation history + entity mentions',
        description:
          'Create /dashboard/chat full-screen page. Conversation history sidebar from tenant.ai_conversations. New conversation button. File upload for document analysis. @[company] entity mentions inject CVR data into context. Suggested prompts for recently viewed entities.',
        priority: 'Medium',
        effort: 'M',
        labels: ['p2', 'ai', 'chat'],
      },
      {
        summary: '[P3] AI tenant learning — upload company procedures and templates',
        description:
          'Build document upload UI in /dashboard/settings/ai. Parse + chunk PDF/DOCX files. Generate embeddings via text-embedding-3-small, store in tenant.document_embeddings (pgvector). Retrieve relevant chunks on each AI query. Allow tenants to write custom AI instructions.',
        priority: 'Low',
        effort: 'L',
        labels: ['p3', 'ai', 'rag', 'embeddings'],
      },
    ],
  },

  // ── PHASE 6: ACCOUNT & BILLING ───────────────────────────────────────────
  {
    epic: {
      summary: 'PHASE 6 — Account Management & Stripe Billing',
      priority: 'Medium',
      labels: ['phase-6', 'account', 'billing'],
    },
    items: [
      {
        summary: '[P2] User settings page (/dashboard/settings) — profile, security, 2FA, language',
        description:
          'Create settings page. Sections: Profile (name, email, avatar), Security (change password, 2FA setup with TOTP QR code + backup codes), Notifications, Language preference saved to DB.',
        priority: 'Medium',
        effort: 'M',
        labels: ['p2', 'settings', 'auth'],
      },
      {
        summary: '[P2] Organisation settings page — team management, company info, subscription',
        description:
          'Create /dashboard/settings/organisation. Edit company name, CVR, logo. User management: invite by email, change roles, remove members. View current plan. Data retention settings.',
        priority: 'Medium',
        effort: 'M',
        labels: ['p2', 'settings', 'multi-tenant'],
      },
      {
        summary: '[P3] Transactional email setup (Resend) — verification, invitations, alerts',
        description:
          'Register at Resend.com. Install resend package. Create lib/email/client.ts. Build dark-themed email templates: welcome/verification, password reset, team invitation, entity change alert, weekly digest. Wire Supabase Auth to use custom Resend SMTP.',
        priority: 'Low',
        effort: 'S',
        labels: ['p3', 'email', 'notifications'],
      },
      {
        summary: '[P3] Stripe billing integration — subscription plans and payment',
        description:
          'Create Stripe account with 4 plans: Free (0 DKK), Starter (299 DKK/mo), Pro (799 DKK/mo), Enterprise (custom). Install stripe npm package. Create checkout and webhook API routes. Build /dashboard/billing page. Enforce plan limits in middleware. Usage tracking per tenant per day.',
        priority: 'Low',
        effort: 'L',
        labels: ['p3', 'billing', 'stripe', 'monetisation'],
      },
    ],
  },

  // ── PHASE 7: INTEGRATIONS ────────────────────────────────────────────────
  {
    epic: {
      summary: 'PHASE 7 — Email & Social Integrations (Gmail, LinkedIn)',
      priority: 'Low',
      labels: ['phase-7', 'integrations'],
    },
    items: [
      {
        summary: '[P3] Gmail integration — send outreach emails from BizzAssist',
        description:
          'Extend Google OAuth to include gmail.send scope (requires Google app verification — allow 2-4 weeks). Create lib/integrations/gmail/client.ts + API route. Build email compose UI pre-populated from person profile. Email templates for B2B outreach. Track in tenant.audit_log.',
        priority: 'Low',
        effort: 'L',
        labels: ['p3', 'gmail', 'integration'],
      },
      {
        summary: '[P3] LinkedIn profile enrichment — link and enrich person profiles',
        description:
          'Extend LinkedIn OAuth scope to include profile + email. Auto-populate logged-in user own profile from LinkedIn. Build "Link LinkedIn profile" button on person pages. Store LinkedIn URL + public data in tenant.saved_entities. Note: No programmatic scraping — ToS violation.',
        priority: 'Low',
        effort: 'L',
        labels: ['p3', 'linkedin', 'integration'],
      },
      {
        summary:
          '[P3] Saved entity change alerts — monitor CVR/property changes, email notification',
        description:
          'Add is_monitored flag to tenant.saved_entities. Create Supabase Edge Function or Vercel Cron to poll CVR for changes. Detect: new board member, dissolution, new annual report, address change. Send email via Resend. In-app notification bell. Notification preferences.',
        priority: 'Low',
        effort: 'M',
        labels: ['p3', 'alerts', 'monitoring', 'notifications'],
      },
    ],
  },

  // ── PHASE 8: ADVANCED ────────────────────────────────────────────────────
  {
    epic: {
      summary: 'PHASE 8 — Advanced Features (Reports, Graphs, API, Mobile)',
      priority: 'Low',
      labels: ['phase-8', 'advanced'],
    },
    items: [
      {
        summary: '[P3] PDF report export — branded PDF for company, property, and analysis reports',
        description:
          'Install @react-pdf/renderer or use Puppeteer. Create PDF templates for Company Profile, Property Report, AI Analysis. Export PDF button on all profile + analysis pages. Store in tenant.reports with download link. BizzAssist branding + date.',
        priority: 'Low',
        effort: 'M',
        labels: ['p3', 'export', 'pdf'],
      },
      {
        summary:
          '[P3] Relationship graph visualisation — interactive network of companies, people, properties',
        description:
          'Evaluate and implement react-force-graph or cytoscape.js. Build NetworkGraph component. Show company → directors, company → subsidiaries, person → multiple board roles. Clickable nodes navigate to profiles. Highlight suspicious patterns. Filter by relationship type and depth.',
        priority: 'Low',
        effort: 'L',
        labels: ['p3', 'visualisation', 'network-graph'],
      },
      {
        summary: '[P3] Competitor analysis tool — structured AI competitive intelligence workflow',
        description:
          'User inputs CVR number. System identifies competitors by industry + geography + revenue. AI generates structured comparison: revenue, employees, board overlap, properties. Side-by-side comparison table. Export to PDF or Excel.',
        priority: 'Low',
        effort: 'M',
        labels: ['p3', 'ai', 'analysis', 'competitive-intelligence'],
      },
      {
        summary: '[P4] Enterprise API access — REST API with key management and docs',
        description:
          'Create API key management in /dashboard/settings/api. Build /api/v1/ public routes with API key auth. Rate limiting per key. OpenAPI/Swagger documentation. Usage dashboard with call counts.',
        priority: 'Lowest',
        effort: 'L',
        labels: ['p4', 'api', 'enterprise'],
      },
      {
        summary: '[P4] Mobile app — React Native / Expo port for iOS and Android',
        description:
          'Create apps/mobile/ Expo project using Turborepo monorepo. Share lib/ code. Port: Dashboard, Search, Company Profile, Property Profile, Chat. Native push notifications. Offline mode with cached profiles. App Store + Google Play submission.',
        priority: 'Lowest',
        effort: 'XL',
        labels: ['p4', 'mobile', 'react-native'],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Main: create all issues
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀 BizzAssist JIRA Backlog Creator\n');

  // First: find the Epic issue type ID
  const projectMeta = await jiraRequest(
    'GET',
    `/issue/createmeta?projectKeys=${PROJECT_KEY}&expand=projects.issuetypes`
  );
  const project = projectMeta.projects?.[0];
  if (!project) throw new Error('Project BIZZ not found');

  const issueTypes = project.issuetypes;
  const epicType = issueTypes.find((t) => t.name === 'Epic');
  const storyType = issueTypes.find((t) => t.name === 'Story');
  const taskType = issueTypes.find((t) => t.name === 'Task');

  console.log('Available issue types:', issueTypes.map((t) => t.name).join(', '));
  console.log(
    `Epic: ${epicType?.name || 'not found'}, Story: ${storyType?.name || 'not found'}, Task: ${taskType?.name || 'not found'}\n`
  );

  const childType = storyType || taskType;
  if (!childType) throw new Error('No Story or Task issue type found');

  let totalCreated = 0;
  const createdEpics = [];

  for (const phase of backlog) {
    // Create the Epic
    console.log(`\n📦 Creating Epic: ${phase.epic.summary}`);
    let epicIssue;
    try {
      epicIssue = await createIssue({
        summary: phase.epic.summary,
        description: `Epic for ${phase.epic.summary}. Contains all tasks for this phase.`,
        issueType: epicType ? 'Epic' : childType.name,
        priority: phase.epic.priority,
        labels: phase.epic.labels,
      });
      console.log(`   ✅ Epic created: ${epicIssue.key}`);
      totalCreated++;
      createdEpics.push({ key: epicIssue.key, summary: phase.epic.summary });
    } catch (err) {
      console.error(`   ❌ Epic failed: ${err.message}`);
      epicIssue = null;
    }

    // Create child tasks/stories
    for (const item of phase.items) {
      try {
        const issue = await createIssue({
          summary: item.summary,
          description: item.description,
          issueType: childType.name,
          priority: item.priority,
          labels: item.labels,
        });

        // Try to link to epic
        if (epicIssue) {
          try {
            await jiraRequest('PUT', `/issue/${issue.key}`, {
              fields: {
                ...(epicType ? { 'Epic Link': epicIssue.key } : {}),
              },
            });
          } catch {
            // Epic link field name may differ — ignore silently
          }
        }

        console.log(`   ✅ ${issue.key}: ${item.summary.substring(0, 70)}...`);
        totalCreated++;
        await new Promise((r) => setTimeout(r, 200)); // Rate limiting
      } catch (err) {
        console.error(`   ❌ Failed: ${item.summary.substring(0, 60)} → ${err.message}`);
      }
    }
  }

  console.log(`\n🎉 Done! Created ${totalCreated} JIRA issues.`);
  console.log('\nEpics created:');
  createdEpics.forEach((e) => console.log(`  ${e.key}: ${e.summary}`));
  console.log(
    `\n🔗 View in JIRA: https://${JIRA_HOST}/jira/software/projects/${PROJECT_KEY}/boards`
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
