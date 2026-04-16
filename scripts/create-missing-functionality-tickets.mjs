/**
 * BizzAssist — Missing Functionality JIRA Tickets
 *
 * Creates JIRA tickets for ALL remaining missing functionality found during
 * comprehensive codebase audit (April 2026).
 *
 * Run: JIRA_API_TOKEN=<token> node scripts/create-missing-functionality-tickets.mjs
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

// ADF helpers
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

// ---------------------------------------------------------------------------
// TICKET DEFINITIONS
// ---------------------------------------------------------------------------

const tickets = [
  // ── EPIC ─────────────────────────────────────────────────────────────────
  {
    summary: 'EPIC: Missing functionality — full platform audit (April 2026)',
    issueType: 'Epic',
    priority: 'High',
    labels: ['audit', 'missing-features', 'platform'],
    description: [
      p(
        'Comprehensive audit of all missing functionality in BizzAssist identified during April 2026 codebase review. Covers email, team management, notifications, exports, GDPR, security, UI skeletons, and disabled features.'
      ),
      heading('Categories'),
      bulletList([
        'Email notifications — welcome, password reset, digests missing',
        'Team management — no self-serve invite/remove members',
        'Notification system — no generation, preferences, or real-time delivery',
        'PDF export — not implemented',
        'GDPR consent tracking — CookieBanner exists but no backend tracking',
        'Disabled features — tingbogsattest PDF, gruppeøkonomi, lignende handler',
        'Missing loading skeletons — 5 dashboard routes',
        'Outlook integration — schema exists but not implemented',
        'Tinglysning document endpoints — returning 404 from service',
        'AI tools tech debt — duplicated between analysis/run and ai/chat',
      ]),
    ],
  },

  // ── 1: Self-serve team management ─────────────────────────────────────
  {
    summary: '[P1] Self-serve team management — invite, role management, remove members',
    issueType: 'Story',
    priority: 'High',
    labels: ['feature', 'team-management', 'tenant', 'p1'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Brugeradministration eksisterer KUN via admin-endpoints (/api/admin/users). Der er ingen mulighed for tenant-ejere/admins at invitere, administrere roller, eller fjerne teammedlemmer selv.'
      ),
      heading('Database — allerede klar'),
      bulletList([
        'tenant_memberships tabel eksisterer med user_id, tenant_id, role',
        'Roller defineret: tenant_member, tenant_admin, invitee',
        'RLS functions: is_tenant_member(), is_tenant_admin(), can_tenant_write()',
        'Organisation-settings side eksisterer: /dashboard/settings/organisation',
      ]),
      heading('Hvad mangler'),
      bulletList([
        'API: POST /api/team/invite — send invitation email med token',
        'API: POST /api/team/accept — accepter invitation (via token link)',
        'API: PATCH /api/team/[userId]/role — ændre rolle (admin kun)',
        'API: DELETE /api/team/[userId] — fjern medlem (admin kun)',
        'API: POST /api/team/leave — forlad tenant',
        'UI: Medlemsliste med roller og handlinger på /dashboard/settings/organisation',
        'UI: Invite-dialog med email-input og rolle-vælger',
        'UI: Pending invitations liste',
        'Email: Invitation email via Resend med accept-link',
      ]),
      heading('Design'),
      p(
        'Brug eksisterende dark theme cards med tabel-layout. Roller vises som badges (owner=amber, admin=blue, member=slate). Handlinger i dropdown-menu per medlem.'
      ),
      labelValue('Effort', 'L (1-2 uger)'),
      labelValue('Risk', 'Medium — kræver invitation token system + email flow'),
    ],
  },

  // ── 2: Email notifications suite ──────────────────────────────────────
  {
    summary: '[P1] Komplet email-suite — welcome, password reset, notification digest',
    issueType: 'Story',
    priority: 'High',
    labels: ['feature', 'email', 'resend', 'p1'],
    description: [
      heading('Nuværende tilstand'),
      p('Kun 3 email-typer er implementeret via Resend (app/lib/email.ts):'),
      bulletList([
        '✓ sendPaymentConfirmationEmail() — ved checkout',
        '✓ sendApprovalEmail() — admin godkendelse',
        '✓ sendRecurringPaymentEmail() — abonnement fornyelse',
      ]),
      heading('Manglende emails'),
      bulletList([
        'Welcome email ved signup — introduktion til platformen, næste skridt',
        'Password reset email — refereret i loginThrottle.ts men ikke implementeret via Resend',
        'Notification digest — daglig/ugentlig opsummering af fulgte ejendomme/virksomheder ændringer',
        'Account deletion bekræftelse — GDPR krav (brugeren bør få bekræftelse)',
        'Team invitation email — kræves af team management feature',
        'Subscription expiring warning — advarsel X dage før abonnement udløber',
        'Failed payment reminder — customer-facing email ved betalingsfejl (Stripe dunning)',
      ]),
      heading('Implementering'),
      bulletList([
        'Udvid app/lib/email.ts med nye email-funktioner',
        'Opret email templates (HTML) med BizzAssist branding + dark theme',
        'Tilføj email preference settings per bruger (opt-in/opt-out for digest)',
        'Digest cron job: /api/cron/notification-digest (daglig kl. 08:00)',
      ]),
      labelValue('Effort', 'M (3-5 dage)'),
      labelValue('Risk', 'Lav — Resend er allerede konfigureret; kun nye templates'),
    ],
  },

  // ── 3: Notification system completion ─────────────────────────────────
  {
    summary: '[P2] Komplet notification system — generation, preferences, real-time',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'notifications', 'real-time', 'p2'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Notifications API (/api/notifications) kan KUN læse og slette notifikationer. Selve notifikations-tabellen eksisterer i tenant schema (migration 004). NotifikationsDropdown.tsx viser notifikationer i UI med Supabase + localStorage fallback.'
      ),
      heading('Hvad virker'),
      bulletList([
        '✓ GET /api/notifications — hent notifikationer (pagineret, unread filter)',
        '✓ GET /api/notifications?count=true — antal ulæste',
        '✓ POST mark_read / mark_all_read / delete_read — administrer læst-status',
        '✓ NotifikationsDropdown.tsx — UI med tabs og bell-icon',
      ]),
      heading('Hvad mangler'),
      bulletList([
        'Notification GENERATION — ingen endpoints eller services opretter notifikationer',
        'Triggers der bør generere notifikationer:',
        '  - Ejendomsvurdering ændret (via BBR hændelsesbesked cron)',
        '  - Fulgt virksomhed ændrer status/ejerskab/regnskab',
        '  - Fulgt ejendom skifter ejer eller får ny vurdering',
        '  - Team member joined/left tenant',
        '  - Subscription approaching expiry',
        '  - AI analysis completed (for async jobs)',
        'Notification PREFERENCES — brugeren kan ikke vælge hvilke notifikationer de vil have',
        'Real-time delivery — ingen WebSocket eller Supabase Realtime subscription',
        'Email digest integration — notifikationer bør kunne sendes som email',
      ]),
      heading('Løsning'),
      bulletList([
        'Opret app/lib/notifications.ts med createNotification() helper',
        'Hook ind i eksisterende cron jobs (poll-properties, pull-bbr-events) for at generere notifikationer',
        'Tilføj Supabase Realtime subscription i NotifikationsDropdown for live updates',
        'Notification preferences tabel: notification_preferences (user_id, type, channel, enabled)',
        'UI: Settings → Notifikationer side med toggles per type og kanal',
      ]),
      labelValue('Effort', 'L (1-2 uger)'),
      labelValue(
        'Risk',
        'Medium — Supabase Realtime kræver korrekt RLS setup for tenant isolation'
      ),
    ],
  },

  // ── 4: PDF report generation ──────────────────────────────────────────
  {
    summary: '[P2] PDF export — ejendomsrapport, virksomhedsrapport, analyse',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'export', 'pdf', 'p2'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Excel export er fuldt implementeret (/api/export) med ejendoms- og virksomhedsdata. PDF export eksisterer IKKE.'
      ),
      heading('Hvad der allerede eksisterer'),
      bulletList([
        '✓ Excel export med overview, buildings, units, valuations sheets',
        '✓ /api/rapport/route.ts — genererer AI-baseret analyse-rapport (JSON/tekst, ikke PDF)',
        '✗ Ingen PDF generation library installeret',
        '✗ Ingen PDF templates',
      ]),
      heading('Ønskede PDF-rapporter'),
      bulletList([
        'Ejendomsrapport — komplet oversigt: BBR, vurdering, ejerskab, tinglysning, energimærke, matrikel',
        'Virksomhedsrapport — CVR data, ejerskab, regnskab, ejendomsportefølje',
        'Analyse-rapport — AI-genereret analyse formateret som professionelt dokument',
        'Sammenligningsrapport — side-by-side property comparison (fra /dashboard/compare)',
      ]),
      heading('Tekniske muligheder'),
      bulletList([
        'Option A: @react-pdf/renderer — React components → PDF (server-side)',
        'Option B: Puppeteer/Playwright — render HTML → PDF (tungt, kræver headless browser)',
        'Option C: jsPDF + autoTable — lightweight, ingen server dependency',
        'Anbefaling: @react-pdf/renderer — passer godt med eksisterende React stack',
      ]),
      heading('Design'),
      p(
        'PDF skal have BizzAssist branding (logo, dark blue header), dato, bruger/tenant info, og struktureret data matching det eksisterende UI layout.'
      ),
      labelValue('Effort', 'M (3-5 dage)'),
      labelValue('Risk', 'Lav — ingen eksisterende funktionalitet påvirkes'),
    ],
  },

  // ── 5: GDPR consent tracking ──────────────────────────────────────────
  {
    summary: '[P1] GDPR consent tracking — cookie consent backend + samtykke-log',
    issueType: 'Story',
    priority: 'High',
    labels: ['feature', 'gdpr', 'compliance', 'cookies', 'p1'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'CookieBanner.tsx eksisterer som UI-komponent, men der er INGEN backend-tracking af samtykke. Samtykke gemmes sandsynligvis kun i en cookie/localStorage — ikke i databasen.'
      ),
      heading('GDPR krav (ikke-forhandlingsbart)'),
      bulletList([
        'Samtykke skal logges med tidsstempel, IP (hashed), og valgte kategorier',
        'Brugeren skal kunne trække samtykke tilbage til enhver tid',
        'Samtykke-log skal opbevares som dokumentation (accountability principle)',
        'Nye sub-processors skal opdateres i privacy policy (app/privacy/page.tsx)',
      ]),
      heading('Hvad mangler'),
      bulletList([
        'Database: consent_log tabel (user_id nullable for anonymous, session_id, categories, granted_at, revoked_at)',
        'API: POST /api/consent — log samtykke-valg',
        'API: GET /api/consent — hent nuværende samtykke-status',
        'API: DELETE /api/consent — træk samtykke tilbage',
        'CookieBanner.tsx: Kald POST /api/consent ved accept/afvis (ud over localStorage)',
        'Settings: Samtykke-administration under /dashboard/settings med overblik over aktive samtykker',
      ]),
      heading('Samtykke-kategorier'),
      bulletList([
        'Nødvendige (altid aktive — session, auth)',
        'Funktionelle (præferencer, sprog, kort-style)',
        'Analytiske (Sentry session replays, usage tracking)',
        'Marketing (fremtidig — ikke aktive endnu)',
      ]),
      labelValue('Effort', 'S (1-2 dage)'),
      labelValue('Risk', 'Lav teknisk — men compliance-kritisk; skal reviewes af DPO'),
    ],
  },

  // ── 6: Tingbogsattest PDF download ────────────────────────────────────
  {
    summary:
      '[P2] Tingbogsattest PDF download — aktiver når REST API er tilgængeligt (1. maj 2026)',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'tinglysning', 'pdf', 'deadline', 'p2'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Download-knappen for tingbogsattest er disabled i UI med tooltip: "PDF-download kræver REST API (tilgængeligt 1. maj 2026)". Se EjendomDetaljeClient.tsx linje 5687-5726.'
      ),
      heading('TODOs i koden'),
      bulletList([
        'BIZZ-195: onDownload skjult indtil korrekte eTL PDF-URLer er implementeret (linje 5687)',
        'BIZZ-196: Knyt til REST API tingbogsattest-endpoint når tilgængeligt 1. maj 2026 (linje 5714)',
      ]),
      heading('Hvad skal gøres'),
      bulletList([
        'Vent på at Tinglysning REST API frigives (forventet 1. maj 2026)',
        'Implementer /api/tinglysning/attest endpoint der henter tingbogsattest PDF',
        'Fjern disabled state og opacity-50 fra download-knappen',
        'Tilføj fejlhåndtering for timeout og utilgængelig service',
        'Test med mTLS certifikat mod produktions-endpoint',
      ]),
      heading('Relateret'),
      p(
        'Tinglysning dokument-endpoints (/hentakt, /dokument, /akt, /bilag) returnerer pt. 404 fra servicen. Disse skal også testes når REST API frigives.'
      ),
      labelValue('Effort', 'S (1-2 dage) — når API er tilgængeligt'),
      labelValue('Deadline', '1. maj 2026 — REST API forventet release'),
      labelValue('Risk', 'Lav — koden er forberedt; kun endpoint-integration mangler'),
    ],
  },

  // ── 7: Gruppeøkonomi section ──────────────────────────────────────────
  {
    summary: '[P2] Aktiver gruppeøkonomi sektion på virksomhedssiden',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'company-page', 'financials', 'p2'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Gruppeøkonomi-sektionen er kommenteret ud i VirksomhedDetaljeClient.tsx (linje 1803-1804) med kommentaren: "Gruppeøkonomi — hidden, aktiveres senere". Financials data (gruppeFinans Map) hentes allerede for relaterede virksomheder.'
      ),
      heading('Hvad eksisterer'),
      bulletList([
        'gruppeFinans Map<CVR, {brutto, balance, egenkapital}> — hentes allerede via /api/regnskab/xbrl',
        'XBRL data for alle aktive relaterede virksomheder — parallel batching implementeret',
        'Virksomheds-cards viser allerede individuel regnskabsdata (Bruttofortjeneste, Aktiver, Egenkapital)',
      ]),
      heading('Hvad mangler'),
      bulletList([
        'Aggregeret koncern-økonomi visning: Samlet omsætning, resultat, egenkapital for hele gruppen',
        'Konsolideret balance (sum af alle datterselskaber)',
        'Trend-graf: Koncernens økonomiske udvikling over tid (kræver historiske XBRL data)',
        'Top/bund performers: Hvilke datterselskaber performer bedst/dårligst',
        'Intra-group elimineringer note (kan ikke beregnes uden konsolideret regnskab)',
      ]),
      heading('Implementering'),
      bulletList([
        'Fjern kommentering af gruppeøkonomi-sektionen',
        'Beregn aggregerede nøgletal fra gruppeFinans Map',
        'Tilføj summary cards: Total omsætning, Total resultat, Total egenkapital, Antal selskaber',
        'Tilføj bar chart med top datterselskaber (lazy-load Recharts)',
        'Overvej disclaimer: "Ikke konsolideret — sum af individuelle regnskaber"',
      ]),
      labelValue('Effort', 'S (1-2 dage)'),
      labelValue('Risk', 'Lav — data eksisterer allerede; kun UI-aktivering + aggregering'),
    ],
  },

  // ── 8: Lignende handler (comparable sales) ────────────────────────────
  {
    summary: '[P3] Lignende handler — sammenlignelige ejendomssalg i nærområdet',
    issueType: 'Story',
    priority: 'Low',
    labels: ['feature', 'ejendomme', 'markedsdata', 'p3'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Placeholder i Økonomi-tab på ejendomssiden med tekst: "Kvadratmeterpriser og handler for lignende ejendomme kræver markedsdata-integration (backlog)." (EjendomDetaljeClient.tsx)'
      ),
      heading('Hvad der kræves'),
      bulletList([
        'Find sammenlignelige ejendomme baseret på: ejendomstype, areal, beliggenhed, byggeår',
        'Vis seneste handler i nærområdet med m²-pris',
        'Beregn gennemsnitlig m²-pris for området',
        'Sammenlign ejendommens vurdering med markedspris',
      ]),
      heading('Mulige datakilder'),
      bulletList([
        'EJF_Handelsoplysninger (Datafordeler) — vi har allerede adgang; kan søge handler i samme kommune/postnummer',
        'Vurderingsportalen — foreløbige vurderinger for naboejendomme',
        'BBR bbox query — find ejendomme af samme type i nærhed',
        'Kombination: BBR (find lignende bygninger) → EJF (hent deres seneste handler)',
      ]),
      heading('Implementering'),
      bulletList([
        'Nyt endpoint: /api/sammenlignelige-handler?bfe=X&type=Y&areal=Z&radius=R',
        '1. BBR bbox query for bygninger med samme anvendelseskode inden for radius',
        '2. For top 20 matches: hent BFE → EJF salgshistorik',
        '3. Beregn m²-priser og statistik',
        '4. UI: Tabel med adresse, areal, salgspris, m²-pris, dato + gennemsnits-kort',
      ]),
      labelValue('Effort', 'L (1-2 uger)'),
      labelValue(
        'Risk',
        'Medium — mange API-kald for at finde sammenlignelige; kræver smart caching'
      ),
    ],
  },

  // ── 9: Missing loading skeletons ──────────────────────────────────────
  {
    summary: '[P3] Tilføj manglende loading.tsx skeleton screens (5 routes)',
    issueType: 'Task',
    priority: 'Low',
    labels: ['ui', 'loading', 'skeleton', 'performance', 'p3'],
    description: [
      heading('Manglende loading.tsx filer'),
      p(
        'Per CLAUDE.md krav: "Every dashboard route MUST have a loading.tsx skeleton screen." Følgende routes mangler:'
      ),
      bulletList([
        'app/dashboard/settings/integrations/loading.tsx',
        'app/dashboard/settings/knowledge/loading.tsx',
        'app/dashboard/settings/organisation/loading.tsx',
        'app/dashboard/admin/ai-feedback/loading.tsx',
        'app/dashboard/admin/release-manager/loading.tsx',
      ]),
      heading('Implementering'),
      p(
        'Opret loading.tsx med skeleton-pulse layout matchende sidens content structure. Brug eksisterende patterns fra f.eks. app/dashboard/settings/security/loading.tsx som template.'
      ),
      labelValue('Effort', 'XS (< 1 dag)'),
      labelValue('Risk', 'Ingen'),
    ],
  },

  // ── 10: Outlook integration ───────────────────────────────────────────
  {
    summary: '[P3] Outlook/Office 365 email integration',
    issueType: 'Story',
    priority: 'Low',
    labels: ['feature', 'integration', 'outlook', 'p3'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Database schema tillader allerede Outlook som provider (CHECK constraint: provider IN ("gmail", "outlook") i email_integrations tabel). Gmail integration er fuldt implementeret med OAuth, token refresh, og send. Outlook har 0% implementering.'
      ),
      heading('Hvad eksisterer'),
      bulletList([
        '✓ DB: email_integrations tabel med provider="outlook" support',
        '✓ UI: Settings → Integrations side viser sandsynligvis Outlook som option',
        '✗ Ingen OAuth routes for Microsoft',
        '✗ Ingen token exchange',
        '✗ Ingen send endpoint',
      ]),
      heading('Implementering'),
      bulletList([
        'Registrer Azure AD app i Microsoft Entra admin center',
        'API: /api/integrations/outlook/auth — redirect til Microsoft OAuth',
        'API: /api/integrations/outlook/callback — token exchange',
        'API: /api/integrations/outlook/send — send via Microsoft Graph API',
        'API: /api/integrations/outlook/route — GET status, DELETE revoke',
        'Token refresh: Microsoft tokens udløber efter 1 time; refresh tokens varer 90 dage',
      ]),
      heading('Microsoft Graph API'),
      codeBlock(
        `POST https://graph.microsoft.com/v1.0/me/sendMail
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "message": {
    "subject": "...",
    "body": { "contentType": "HTML", "content": "..." },
    "toRecipients": [{ "emailAddress": { "address": "..." } }]
  }
}`,
        'text'
      ),
      labelValue('Effort', 'M (3-5 dage)'),
      labelValue('Risk', 'Lav — følger Gmail-pattern; Microsoft Graph er veldokumenteret'),
    ],
  },

  // ── 11: AI tools tech debt ────────────────────────────────────────────
  {
    summary: '[P3] Refactor: Udtræk duplerede AI tools til delt modul',
    issueType: 'Task',
    priority: 'Low',
    labels: ['tech-debt', 'refactor', 'ai', 'p3'],
    description: [
      heading('Problem'),
      p(
        'AI tool definitions og executeTool-logik er duplikeret mellem to API routes (TODO i app/api/analysis/run/route.ts linje 28):'
      ),
      codeBlock(
        'TODO(tech-debt): Udtræk TOOLS + executeTool til app/lib/aiTools.ts og del med /api/ai/chat',
        'text'
      ),
      heading('Berørte filer'),
      bulletList([
        'app/api/ai/chat/route.ts — 15 tool definitions + execution logic',
        'app/api/analysis/run/route.ts — overlappende tool definitions + execution',
      ]),
      heading('Løsning'),
      bulletList([
        'Opret app/lib/aiTools.ts med:',
        '  - TOOL_DEFINITIONS array (Claude tool_use schema)',
        '  - executeTool(toolName, input) async function',
        '  - Delt type definitions',
        'Opdater begge routes til at importere fra delt modul',
        'Sikr at nye tools kun skal tilføjes ét sted',
      ]),
      labelValue('Effort', 'S (1-2 dage)'),
      labelValue('Risk', 'Lav — ren refactoring, ingen funktionalitetsændring'),
    ],
  },

  // ── 12: Person search completion ──────────────────────────────────────
  {
    summary: '[P2] Fuldfør personsøgning på dashboard',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'search', 'person', 'dashboard', 'p2'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Dashboard viser placeholder-tekst: "Personsøgning er under udvikling — her vil dine seneste personer blive vist." (EmptyOwners state i DashboardPageClient.tsx). Personsøgning via den universelle søgning (/dashboard/search og /api/search) virker, men dashboard-sektionen for seneste personer er ikke implementeret.'
      ),
      heading('Hvad virker'),
      bulletList([
        '✓ /api/search — unified search inkluderer personer fra CVR ElasticSearch',
        '✓ /api/person-search — dedikeret person søge-endpoint',
        '✓ /dashboard/owners/[enhedsNummer] — person detalje-side er fuldt implementeret',
        '✓ Person-resultater vises i søgeresultater',
      ]),
      heading('Hvad mangler'),
      bulletList([
        'Dashboard "Seneste personer" sektion — vis recent_entities med type="person"',
        'Quick-search for personer direkte fra dashboard (lignende adresse/virksomheds quick-search)',
        'Person typeahead i søgefeltet med navn-forslag fra CVR',
      ]),
      heading('Implementering'),
      bulletList([
        'Hent recent_entities med entity_type="person" fra Supabase',
        'Vis som cards med: Navn, roller (direktør/bestyrelsesmedlem), antal tilknyttede virksomheder',
        'Genbrug eksisterende PersonCard pattern fra owners-listen',
        'Tilføj person-typeahead til dashboard søgefelt',
      ]),
      labelValue('Effort', 'S (1-2 dage)'),
      labelValue('Risk', 'Lav — alle backend-endpoints eksisterer'),
    ],
  },

  // ── 13: Google OAuth login ────────────────────────────────────────────
  {
    summary: '[P2] Google OAuth login — "Fortsæt med Google" på login-side',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'auth', 'google', 'oauth', 'p2'],
    description: [
      heading('Kontekst'),
      p(
        'LinkedIn OAuth login eksisterer. Google OAuth er specificeret i backlog (Phase 1.5) men status er uklart. Supabase Auth understøtter Google provider out-of-the-box.'
      ),
      heading('Hvad der kræves'),
      bulletList([
        'Opret Google OAuth app i Google Cloud Console',
        'Konfigurer Google provider i Supabase Auth dashboard',
        'Tilføj "Fortsæt med Google" knap på login-side',
        'Wire til supabase.auth.signInWithOAuth({ provider: "google" })',
        'Håndter OAuth callback ved /auth/callback',
        'Auto-provision tenant ved første Google login',
      ]),
      heading('Vigtighed'),
      p(
        'Google login er den mest efterspurgte OAuth-metode for B2B SaaS. Reducerer friktion ved onboarding markant.'
      ),
      labelValue('Effort', 'S (1-2 dage)'),
      labelValue('Risk', 'Lav — Supabase har native Google OAuth support'),
    ],
  },

  // ── 14: Tinglysning dokument-endpoints 404 ────────────────────────────
  {
    summary: '[P2] Undersøg og fix tinglysning dokument-endpoints (returnerer 404)',
    issueType: 'Task',
    priority: 'Medium',
    labels: ['bug', 'tinglysning', 'investigation', 'p2'],
    description: [
      heading('Problem'),
      p(
        'Tinglysning dokument-endpoints returnerer 404 fra den eksterne service. Noteret i koden (app/api/tinglysning/dokument/route.ts, 2026-04-09): "/hentakt, /dokument, /akt, /bilag return 404 from the service."'
      ),
      heading('Berørte endpoints'),
      bulletList([
        '/api/tinglysning/dokument — hent specifikt tinglysningsdokument',
        'Tilhørende eTL API endpoints: /hentakt, /dokument, /akt, /bilag',
      ]),
      heading('Undersøgelse påkrævet'),
      bulletList([
        'Verificer om endpoints er nedlagt eller ændret i eTL API v1.12+',
        'Tjek om nye REST API (forventet maj 2026) erstatter disse',
        'Kontakt Tinglysningsretten support for afklaring',
        'Opdater kode til nye endpoints hvis tilgængelige',
        'Tilføj graceful degradation hvis endpoints forbliver utilgængelige',
      ]),
      labelValue('Effort', 'S (1-2 dage research)'),
      labelValue('Risk', 'Ukendt — afhænger af ekstern service status'),
    ],
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Creating missing functionality JIRA tickets...\n');

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
            // silently skip if link type differs
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
