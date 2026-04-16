/**
 * BizzAssist — Data Source Optimization JIRA Tickets
 *
 * Creates JIRA tickets based on comprehensive analysis of all data sources,
 * API call patterns, redundancies, and optimization opportunities.
 *
 * Run: JIRA_API_TOKEN=<token> node scripts/create-data-optimization-tickets.mjs
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

/** Create a JIRA issue with ADF description */
async function createIssue({ summary, description, issueType, priority, labels }) {
  const body = {
    fields: {
      project: { key: PROJECT_KEY },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: description,
      },
      issuetype: { name: issueType },
      priority: { name: priority },
      labels: labels || [],
    },
  };

  const result = await jiraRequest('POST', '/issue', body);
  return result;
}

/** Build ADF paragraph */
function p(text) {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

/** Build ADF paragraph with bold label + value */
function labelValue(label, value) {
  return {
    type: 'paragraph',
    content: [
      { type: 'text', text: `${label}: `, marks: [{ type: 'strong' }] },
      { type: 'text', text: value },
    ],
  };
}

/** Build ADF heading */
function heading(text, level = 3) {
  return {
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text }],
  };
}

/** Build ADF bullet list */
function bulletList(items) {
  return {
    type: 'bulletList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [p(item)],
    })),
  };
}

/** Build ADF code block */
function codeBlock(text, language = '') {
  return {
    type: 'codeBlock',
    attrs: { language },
    content: [{ type: 'text', text }],
  };
}

// ---------------------------------------------------------------------------
// TICKET DEFINITIONS
// ---------------------------------------------------------------------------

const tickets = [
  // ── EPIC ─────────────────────────────────────────────────────────────────
  {
    summary: 'EPIC: Data source optimization & API call consolidation',
    issueType: 'Epic',
    priority: 'High',
    labels: ['optimization', 'performance', 'data-sources'],
    description: [
      p('Comprehensive optimization of BizzAssist data fetching layer based on full audit of all 80+ API routes and 18+ external services.'),
      heading('Goals'),
      bulletList([
        'Eliminate redundant API calls to external services (Datafordeler, CVR ES, Tinglysning)',
        'Centralize OAuth token caching across all routes',
        'Add HTTP cache headers to uncached endpoints',
        'Consolidate overlapping GraphQL queries where possible',
        'Prepare for DAWA deprecation (July 1, 2026)',
        'Reduce property page load time by parallelizing sequential calls',
      ]),
      heading('Scope'),
      p('This epic covers analysis and implementation across: Datafordeler (BBR, MAT, DAR, VUR, EJF), CVR ElasticSearch, Tinglysning mTLS, EMO energy labels, and all cron/background jobs. No changes to UI components — backend API layer only.'),
      heading('Risk Mitigation'),
      p('All changes must maintain existing functionality. Each ticket should be implemented with feature flags or gradual rollout where applicable. Existing cache TTLs must be preserved unless explicitly changed.'),
    ],
  },

  // ── TICKET 1: Centralize OAuth token cache ─────────────────────────────
  {
    summary: '[P1] Centralize Datafordeler OAuth token cache across all routes',
    issueType: 'Story',
    priority: 'High',
    labels: ['optimization', 'datafordeler', 'auth', 'p1'],
    description: [
      heading('Problem'),
      p('Four separate API routes each maintain their own module-level OAuth token cache (_cachedToken). When multiple routes are called concurrently (e.g., property detail page loads vurdering + ejerskab + salgshistorik simultaneously), each route independently requests a token from auth.datafordeler.dk, causing duplicate OAuth token requests.'),
      heading('Affected Files'),
      bulletList([
        'app/api/ejendomme-by-owner/route.ts — own _cachedToken (line ~88)',
        'app/api/ejerskab/route.ts — own _cachedToken (line ~65)',
        'app/api/salgshistorik/route.ts — own _cachedToken (line ~61)',
        'app/api/salgshistorik/cvr/route.ts — own _cachedToken (line ~65)',
      ]),
      heading('Solution'),
      bulletList([
        'Create shared token cache in app/lib/dfTokenCache.ts',
        'Single module-level cache with mutex/lock to prevent concurrent token fetches',
        'Support multiple grant types (client_credentials for API key, certificate for mTLS)',
        'Existing app/lib/dfCertAuth.ts already has good patterns — extend or wrap it',
        'Token refresh 60s before expiry (already implemented in dfCertAuth.ts)',
      ]),
      heading('Impact'),
      p('Reduces auth.datafordeler.dk calls from 4x to 1x on concurrent page loads. Lower latency on first request of each cold-start cycle.'),
      labelValue('Effort', 'S (1-2 days)'),
      labelValue('Risk', 'Low — token caching is well-understood; existing tests cover auth flow'),
    ],
  },

  // ── TICKET 2: Add cache headers to CVR endpoints ──────────────────────
  {
    summary: '[P1] Add HTTP cache headers to uncached CVR endpoints',
    issueType: 'Story',
    priority: 'High',
    labels: ['optimization', 'cvr', 'caching', 'p1'],
    description: [
      heading('Problem'),
      p('Several high-traffic CVR endpoints have NO HTTP cache headers, causing every client-side call to hit the server and ElasticSearch on every tab switch or page navigation. Company data changes infrequently (daily at most).'),
      heading('Uncached Endpoints'),
      bulletList([
        '/api/cvr-public — primary company data (called on every company page load)',
        '/api/cvr-public/related — related companies (called on tab switch)',
        '/api/cvr-public/person — person lookups (called on owner clicks)',
        '/api/ejendomme-by-owner — property portfolio (called on tab switch)',
        '/api/tinglysning/personbog — mortgage register (called on tab switch)',
      ]),
      heading('Already Cached (reference)'),
      bulletList([
        '/api/cvr/[cvr] — s-maxage=3600, stale-while-revalidate=600',
        '/api/regnskab — s-maxage=3600, stale-while-revalidate=600',
        '/api/cvr-search — s-maxage=300, stale-while-revalidate=120',
      ]),
      heading('Solution'),
      bulletList([
        '/api/cvr-public: Add s-maxage=3600, stale-while-revalidate=600 (company data is stable)',
        '/api/cvr-public/related: Add s-maxage=1800, stale-while-revalidate=300',
        '/api/cvr-public/person: Add s-maxage=3600, stale-while-revalidate=600',
        '/api/ejendomme-by-owner: Add s-maxage=1800, stale-while-revalidate=300 (ownership changes are rare)',
        '/api/tinglysning/personbog: Add s-maxage=3600, stale-while-revalidate=600',
      ]),
      heading('Impact'),
      p('Eliminates redundant ElasticSearch queries on tab navigation and back-button usage. Estimated 40-60% reduction in CVR ES calls for repeat visits within 1 hour.'),
      labelValue('Effort', 'XS (< 1 day)'),
      labelValue('Risk', 'Very low — adding cache headers is additive, no logic changes'),
    ],
  },

  // ── TICKET 3: Deduplicate owner chain resolution ──────────────────────
  {
    summary: '[P2] Deduplicate owner chain resolution on company page',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['optimization', 'cvr', 'company-page', 'p2'],
    description: [
      heading('Problem'),
      p('On the company detail page (VirksomhedDetaljeClient.tsx), the owner chain resolution creates an N²-like explosion of API calls. When a company has 3 corporate owners, Call 1 (/api/cvr-public?vat=X) already returns all owner data in the deltagere array. But Call 2 (resolveChainTop) then makes 3 separate calls to /api/cvr-public?enhedsNummer=X for each corporate owner — re-fetching data that was already available.'),
      heading('Current Flow'),
      codeBlock(
        `Page Load:
  [Call 1] GET /api/cvr-public?vat=12345678
    → Returns: CVRPublicData with deltagere[] (includes all owners)
  [Call 2] resolveChainTop(owners, depth=0, maxDepth=4)
    → For each corporate owner: GET /api/cvr-public?enhedsNummer=XXX
    → Recursively: GET /api/cvr-public?enhedsNummer=YYY (parents)

User clicks owner link:
  [Call 9] GET /api/cvr-public?enhedsNummer=XXX (same data fetched again)`,
        'text'
      ),
      heading('Additionally'),
      bulletList([
        'The local fetchedCache in resolveChainTop is scope-limited to the useEffect closure',
        'If user navigates between tabs, owner chain is re-resolved with fresh HTTP calls',
        'Related companies (Call 5) re-queries ES for companies already found via deltagere',
      ]),
      heading('Solution'),
      bulletList([
        'Extract owner data from the initial deltagere response instead of re-fetching',
        'Implement a shared CVR data cache (React context or module-level Map) keyed by enhedsNummer',
        'Persist cache across tab navigation within the same page session',
        'Only make network calls for owners NOT present in the initial deltagere response',
      ]),
      heading('Impact'),
      p('Eliminates 3-15 redundant API calls per company page load depending on ownership depth. Faster initial render for companies with complex ownership structures.'),
      labelValue('Effort', 'M (3-5 days)'),
      labelValue('Risk', 'Medium — must ensure owner chain depth is still correctly resolved for deep structures. Test with companies that have 4+ levels of corporate ownership.'),
    ],
  },

  // ── TICKET 4: Parallelize fetchBFENummer ──────────────────────────────
  {
    summary: '[P2] Parallelize sequential calls in fetchBFENummer (BBR prefetch)',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['optimization', 'bbr', 'performance', 'property-page', 'p2'],
    description: [
      heading('Problem'),
      p('The server-side BBR prefetch (fetchBbrForAddress → fetchBFENummer in app/lib/fetchBbrData.ts) performs 3 sequential API calls that could be partially parallelized. This function is the single biggest latency bottleneck on the property detail page (200-400ms typical).'),
      heading('Current Sequential Flow'),
      codeBlock(
        `fetchBFENummer(dawaId):
  Step 1: DAWA /adgangsadresser/{id} (or /adresser/{id}) → get jordstykke + adresseTekst
  Step 2: DAWA /jordstykker/{ejerlavKode}/{matrikelnr} → get BFE number        [WAITS for Step 1]
  Step 3: Vurderingsportalen ES /_search → get ejerlejlighed BFE               [WAITS for Step 1]`,
        'text'
      ),
      heading('Optimization'),
      bulletList([
        'Steps 2 and 3 both depend on Step 1, but are independent of each other',
        'After Step 1 completes, run Steps 2 and 3 in Promise.all()',
        'Currently they run sequentially — Step 3 waits for Step 2 to finish unnecessarily',
      ]),
      heading('Proposed Flow'),
      codeBlock(
        `fetchBFENummer(dawaId):
  Step 1: DAWA adgangsadresse → get jordstykke + adresseTekst
  Promise.all([
    Step 2: DAWA jordstykker → BFE number,
    Step 3: Vurderingsportalen ES → ejerlejlighed BFE
  ])`,
        'text'
      ),
      heading('Impact'),
      p('Reduces fetchBFENummer latency by ~100-200ms (the duration of the slower of steps 2/3). This directly improves property page server-side render time.'),
      labelValue('Effort', 'S (1-2 days)'),
      labelValue('Risk', 'Low — Steps 2 and 3 have no data dependency on each other. Fallback logic must be preserved.'),
      labelValue('File', 'app/lib/fetchBbrData.ts lines 374-530'),
    ],
  },

  // ── TICKET 5: XBRL progressive fetch optimization ─────────────────────
  {
    summary: '[P2] Optimize XBRL financial data progressive fetch strategy',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['optimization', 'cvr', 'regnskab', 'company-page', 'p2'],
    description: [
      heading('Problem'),
      p('The XBRL financial data fetching (VirksomhedDetaljeClient.tsx lines 661-754) uses a progressive batching strategy that results in redundant server-side XBRL parsing. After completing progressive fetch (4+8+8+... batches), it fires a background request for offset=0&limit=TOTAL to trigger a server-side cache write — re-parsing ALL XBRL documents that were already parsed during the progressive fetch.'),
      heading('Current Flow'),
      codeBlock(
        `1. GET /api/regnskab/xbrl?cvr=X&offset=0&limit=4     → parse 4 XBRL docs
2. GET /api/regnskab/xbrl?cvr=X&offset=4&limit=8     → parse 8 XBRL docs
3. GET /api/regnskab/xbrl?cvr=X&offset=12&limit=8    → parse 8 XBRL docs
4. Background: GET /api/regnskab/xbrl?cvr=X&offset=0&limit=20  → RE-PARSE ALL 20 docs for cache`,
        'text'
      ),
      heading('Solution Options'),
      bulletList([
        'Option A: Have the server cache each batch progressively (append to Supabase cache on each request)',
        'Option B: Fire the full-data fetch in parallel with first batch instead of after all batches complete',
        'Option C: Add a dedicated cache-write endpoint that accepts pre-parsed data from the client',
      ]),
      heading('Impact'),
      p('Eliminates redundant XBRL parsing on the server. For companies with 20+ years of financials, this saves significant server CPU time and reduces background network traffic.'),
      labelValue('Effort', 'S (1-2 days)'),
      labelValue('Risk', 'Low — cache logic is isolated; progressive display not affected'),
    ],
  },

  // ── TICKET 6: Consolidate EJF GraphQL queries ─────────────────────────
  {
    summary: '[P2] Consolidate overlapping EJF GraphQL queries for CVR property lookups',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['optimization', 'datafordeler', 'ejf', 'graphql', 'p2'],
    description: [
      heading('Problem'),
      p('Two separate routes query the exact same Datafordeler GraphQL endpoint (flexibleCurrent/v1) with the same EJFCustom_EjerskabBegraenset query and ejendeVirksomhedCVRNr filter, duplicating work.'),
      heading('Duplicate Calls'),
      bulletList([
        '/api/ejendomme-by-owner — queries EJFCustom_EjerskabBegraenset to find BFE-numbers owned by CVR(s)',
        '/api/salgshistorik/cvr — queries SAME EJFCustom_EjerskabBegraenset to find BFE-numbers, then fetches sale history per BFE',
      ]),
      heading('On Company Page'),
      p('When user clicks "Ejendomme" tab, both /api/ejendomme-by-owner and /api/salgshistorik/cvr are called. Both independently fetch the same list of BFE-numbers from Datafordeler before doing their respective work.'),
      heading('Solution'),
      bulletList([
        'Option A: Create shared BFE-by-CVR lookup utility in app/lib/ that caches results, used by both routes',
        'Option B: Have /api/salgshistorik/cvr accept BFE-numbers as input instead of CVR (client passes BFEs from ejendomme-by-owner response)',
        'Option C: Merge into single endpoint /api/ejendomme-by-owner that returns both portfolio and sale history',
      ]),
      heading('Impact'),
      p('Eliminates 1 redundant Datafordeler GraphQL call per company property tab load. Reduces Datafordeler API quota usage.'),
      labelValue('Effort', 'S (1-2 days)'),
      labelValue('Risk', 'Low — both routes already handle the same data shape'),
    ],
  },

  // ── TICKET 7: DAWA deprecation preparation ────────────────────────────
  {
    summary: '[P1] Prepare for DAWA API deprecation (July 1, 2026)',
    issueType: 'Story',
    priority: 'High',
    labels: ['migration', 'dawa', 'dar', 'datafordeler', 'deadline', 'p1'],
    description: [
      heading('Context'),
      p('DAWA (Danmarks Adresseregister) at api.dataforsyningen.dk is being deprecated on July 1, 2026. BizzAssist currently uses DAWA as both a primary source and a fallback throughout the codebase. DAR (via Datafordeler GraphQL) is already implemented as the primary for some routes, but DAWA is still heavily used.'),
      heading('Current DAWA Usage'),
      bulletList([
        'app/lib/dawa.ts — full DAWA client library (autocomplete, address lookup, jordstykke)',
        'app/lib/fetchBbrData.ts — DAWA used in fetchBFENummer for adgangsadresse + jordstykke lookups',
        'app/api/adresse/autocomplete — DAR primary, DAWA fallback',
        'app/api/adresse/lookup — DAR primary, DAWA fallback',
        'app/api/adresse/jordstykke — DAR primary, DAWA fallback',
        'app/api/matrikel — DAWA fallback for pre-2024 matrikel systems',
        'app/api/matrikelkort — uses DAWA + Datafordeler',
        'app/api/ejendomme-by-owner — uses DAWA /bfe/{bfe} for address resolution per BFE',
        'app/api/cron/pull-bbr-events — DAWA for event address enrichment',
      ]),
      heading('DAR Already Implemented'),
      bulletList([
        'app/lib/dar.ts — DAR GraphQL client (address resolution, parcel WFS)',
        'DAR is already primary for /api/adresse/* routes with DAWA fallback',
      ]),
      heading('Required Work'),
      bulletList([
        'Audit every DAWA call and ensure DAR equivalent exists',
        'Replace DAWA /bfe/{bfe} lookups with DAR/Datafordeler equivalent (critical for ejendomme-by-owner)',
        'Replace DAWA jordstykke lookups in fetchBbrData.ts with MAT GraphQL',
        'Ensure DAR-only mode works when DAWA is unreachable (test by blocking api.dataforsyningen.dk)',
        'Remove DAWA fallback code after DAR equivalents are verified',
        'Update app/lib/dawa.ts with deprecation notices',
      ]),
      heading('Deadline'),
      p('DAWA shutdown: July 1, 2026. All DAWA dependencies must be removed before this date. Recommend completing by June 1, 2026 to allow testing buffer.'),
      labelValue('Effort', 'L (1-2 weeks)'),
      labelValue('Risk', 'High if not completed before deadline — address resolution is critical path for property lookups. Medium risk during migration — must test all fallback scenarios.'),
    ],
  },

  // ── TICKET 8: Property page request deduplication ─────────────────────
  {
    summary: '[P3] Add client-side request deduplication for property detail page',
    issueType: 'Story',
    priority: 'Low',
    labels: ['optimization', 'performance', 'property-page', 'p3'],
    description: [
      heading('Problem'),
      p('The property detail page (EjendomDetaljeClient.tsx, ~6800 lines) makes 12-15 independent API calls on load. While most are correctly parallelized, there is no client-side request deduplication. If a user navigates away and back, or if React re-renders the component, all calls fire again.'),
      heading('Current Call Pattern on Property Page'),
      codeBlock(
        `Parallel on BFE resolved:
  /api/vurdering?bfeNummer=X          (Datafordeler VUR GraphQL)
  /api/ejerskab?bfeNummer=X           (Datafordeler EJF FlexibleCurrent)
  /api/salgshistorik?bfeNummer=X      (Datafordeler EJF FlexibleCurrent)
  /api/matrikel?bfeNummer=X           (Datafordeler MAT GraphQL)
  /api/energimaerke?bfeNummer=X       (EMO service)
  /api/vurdering-forelobig?bfeNummer=X (Vurderingsportalen ES)
  /api/tinglysning?bfe=X              (Tinglysning mTLS)
  /api/jord?x=lng&y=lat               (Miljøportalen)
  /api/plandata?adresseId=X           (Dataforsyningen)
  /api/cvr?vejnavn=...                (CVR ElasticSearch)`,
        'text'
      ),
      heading('Solution'),
      bulletList([
        'Implement a lightweight SWR-like cache layer (or use useSWR/react-query) for data fetching',
        'Key by endpoint + params, TTL matching server cache headers',
        'Deduplicate in-flight requests (multiple components requesting same data → single HTTP call)',
        'Alternatively: lift fetched data into page-level React context to share across tab switches',
      ]),
      heading('Impact'),
      p('Eliminates redundant calls on React re-renders and tab navigation. Particularly valuable for users who switch between property tabs frequently.'),
      labelValue('Effort', 'M (3-5 days)'),
      labelValue('Risk', 'Medium — touching the data layer of a large component requires careful regression testing'),
    ],
  },

  // ── TICKET 9: Alternative data sources analysis ───────────────────────
  {
    summary: '[P3] Evaluate Datafordeler REST vs GraphQL performance for high-volume queries',
    issueType: 'Story',
    priority: 'Low',
    labels: ['optimization', 'datafordeler', 'research', 'p3'],
    description: [
      heading('Context'),
      p('BizzAssist uses a mix of Datafordeler access methods: GraphQL (BBR v2, MAT v1, DAR v1, VUR v2, EJF FlexibleCurrent), WFS (BBR bbox, matrikel bbox), and REST/ElasticSearch (CVR, Vurderingsportalen). The choice between these was made per-service, but there may be performance gains from switching access methods for certain queries.'),
      heading('Research Tasks'),
      bulletList([
        'Benchmark BBR GraphQL v2 vs BBR REST API for single-building lookups (GraphQL may have overhead for simple queries)',
        'Evaluate whether Datafordeler batch/bulk endpoints exist for BFE lookups (currently sequential)',
        'Test MAT WFS vs MAT GraphQL for matrikel data by BFE — which is faster?',
        'Measure VUR GraphQL cold-start latency vs warm — is OAuth token overhead significant?',
        'Check if EJF FlexibleCurrent supports batch BFE queries (multiple BFEs in one call)',
        'Evaluate whether CVR ElasticSearch scroll API would be faster than pagination for bulk company lookups',
      ]),
      heading('Current Known Performance'),
      codeBlock(
        `BBR GraphQL: 300-800ms (complex, multiple fallbacks)
VUR GraphQL: 200-400ms (includes OAuth token fetch on cold start)
EJF FlexibleCurrent: 100-200ms per BFE
CVR ElasticSearch: 200-500ms
Tinglysning mTLS: 150-300ms
DAWA REST: 50-100ms per call
EMO SOAP: 100-200ms`,
        'text'
      ),
      heading('Deliverable'),
      p('Performance comparison document with recommendations for switching access methods where beneficial. Include latency measurements, quota implications, and migration effort estimates.'),
      labelValue('Effort', 'M (3-5 days research)'),
      labelValue('Risk', 'None — research only, no code changes'),
    ],
  },

  // ── TICKET 10: Tinglysning waterfall optimization ─────────────────────
  {
    summary: '[P3] Optimize tinglysning call waterfall on property page',
    issueType: 'Story',
    priority: 'Low',
    labels: ['optimization', 'tinglysning', 'property-page', 'p3'],
    description: [
      heading('Problem'),
      p('Tinglysning data is loaded in a 2-step waterfall on the property detail page. The main tinglysning call must complete before the summarisk (summary) calls can start, because the UUID comes from the main response.'),
      heading('Current Flow'),
      codeBlock(
        `Step 1: GET /api/tinglysning?bfe={bfe}
  → Response includes uuid for the property in tinglysning system
  → Latency: 150-300ms

Step 2 (after Step 1): Promise.all([
  GET /api/tinglysning/summarisk?uuid={uuid}&section=ejere,
  GET /api/tinglysning/summarisk?uuid={uuid}&section=haeftelser
])
  → Latency: 100-200ms`,
        'text'
      ),
      heading('Solution Options'),
      bulletList([
        'Option A: Combine into single server-side endpoint /api/tinglysning/full?bfe={bfe} that internally fetches main + summarisk and returns combined response (eliminates client-server round-trip)',
        'Option B: Include summarisk data in the main /api/tinglysning response (pre-fetch on server)',
        'Option C: Cache the BFE→UUID mapping so subsequent tinglysning calls skip Step 1',
      ]),
      heading('Impact'),
      p('Saves 100-300ms on tinglysning data display by eliminating the client→server→tinglysning round-trip for Step 2.'),
      labelValue('Effort', 'S (1-2 days)'),
      labelValue('Risk', 'Low — tinglysning data is read-only; combining calls is straightforward'),
    ],
  },

  // ── TICKET 11: CVR endpoint consolidation ─────────────────────────────
  {
    summary: '[P3] Consolidate overlapping CVR ElasticSearch endpoints',
    issueType: 'Story',
    priority: 'Low',
    labels: ['optimization', 'cvr', 'cleanup', 'p3'],
    description: [
      heading('Problem'),
      p('BizzAssist has multiple CVR endpoints that query the same ElasticSearch cluster (distribution.virk.dk) with overlapping functionality:'),
      bulletList([
        '/api/cvr/[cvr] — fetches company by CVR number (old endpoint)',
        '/api/cvr/route — bulk company lookups',
        '/api/cvr-public — fetches company by CVR or enhedsNummer (newer, richer endpoint)',
        '/api/cvr-public/related — related companies for a CVR',
        '/api/cvr-public/person — person lookups by enhedsNummer',
        '/api/cvr-search — text search across companies',
        '/api/cvr-public (with vat param) — same as /api/cvr/[cvr] but different response shape',
        '/api/person-search — person search (separate endpoint but same ES cluster)',
      ]),
      heading('Overlap Analysis'),
      bulletList([
        '/api/cvr/[cvr] and /api/cvr-public?vat=X both fetch company data from CVR ES — cvr-public is more comprehensive',
        '/api/cvr-public/person and /api/person-search both search for persons in CVR ES with different query shapes',
        'The "old" /api/cvr/[cvr] endpoint may still be referenced by components — needs audit',
      ]),
      heading('Solution'),
      bulletList([
        'Audit all references to /api/cvr/[cvr] and migrate callers to /api/cvr-public',
        'Consider merging /api/cvr-public/person into /api/cvr-public with a type parameter',
        'Document which endpoint to use for which use case',
        'Deprecate and eventually remove redundant endpoints',
      ]),
      heading('Impact'),
      p('Reduced maintenance surface, consistent response shapes, easier caching strategy. No performance impact until endpoints are actually consolidated.'),
      labelValue('Effort', 'M (3-5 days)'),
      labelValue('Risk', 'Medium — must audit all client references before removing endpoints'),
    ],
  },

  // ── TICKET 12: BBR event-driven cache invalidation ────────────────────
  {
    summary: '[P3] Implement BBR event-driven cache invalidation using Hændelsesbesked API',
    issueType: 'Story',
    priority: 'Low',
    labels: ['optimization', 'bbr', 'caching', 'events', 'p3'],
    description: [
      heading('Context'),
      p('BizzAssist already has a cron job (/api/cron/pull-bbr-events) that polls the Datafordeler Hændelsesbesked API every 6 hours for building/unit change events. Currently this data is stored but not used for cache invalidation.'),
      heading('Opportunity'),
      bulletList([
        'BBR data is cached for 1 hour (s-maxage=3600) but actually changes very rarely',
        'The Hændelsesbesked API tells us exactly which buildings/units changed',
        'We could extend cache TTL to 24 hours and only invalidate when an event is received',
        'This would dramatically reduce Datafordeler API calls for BBR data',
      ]),
      heading('Solution'),
      bulletList([
        'Store BBR event BFE-numbers/building IDs in a "changed" set (Redis/Supabase)',
        'Extend BBR cache TTL from 1 hour to 24 hours',
        'On BBR data request: check if BFE is in "changed" set → if yes, bypass cache',
        'Clear "changed" entries after successful re-fetch',
      ]),
      heading('Impact'),
      p('Could reduce BBR Datafordeler API calls by 80-90% while maintaining data freshness. Cache hit rate increases from ~50% (1h TTL) to ~95% (24h TTL with event invalidation).'),
      labelValue('Effort', 'M (3-5 days)'),
      labelValue('Risk', 'Medium — must ensure Hændelsesbesked coverage is complete; fallback to TTL-based invalidation needed'),
    ],
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Creating data optimization JIRA tickets...\n');

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

        // Link to epic if we have one
        if (epicKey) {
          try {
            await jiraRequest('POST', '/issueLink', {
              type: { name: 'Epic-Story Link' },
              inwardIssue: { key },
              outwardIssue: { key: epicKey },
            });
          } catch {
            // Epic link type may vary — silently skip
          }
        }
      }

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`✗ FAILED: ${ticket.summary}`);
      console.error(`  ${err.message}\n`);
    }
  }

  console.log('\nDone! Check https://bizzassist.atlassian.net/jira/software/projects/BIZZ/boards');
}

main().catch(console.error);
