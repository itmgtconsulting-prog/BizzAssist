/**
 * BizzAssist — Missing Features JIRA Tickets
 *
 * Creates JIRA tickets for missing data/features identified in the data audit:
 * 1. Ejendomme tab on person page (via person-owned companies, not direct)
 * 2. Ejendomme tab on company page for "virksomhedsordningen" (enkeltmandsvirksomheder)
 * 3. Salgs- og udbudshistorik (listing history is missing, sales history exists)
 * 4. Ejendomme as nodes in diagrams (partially exists but needs improvement)
 * 5. Historisk ejendomsskat og grundskyld (historical property tax data)
 *
 * Run: JIRA_API_TOKEN=<token> node scripts/create-missing-features-tickets.mjs
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
  return jiraRequest('POST', '/issue', body);
}

// ADF helpers
function p(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function labelValue(label, value) {
  return {
    type: 'paragraph',
    content: [
      { type: 'text', text: `${label}: `, marks: [{ type: 'strong' }] },
      { type: 'text', text: value },
    ],
  };
}

function heading(text, level = 3) {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function bulletList(items) {
  return {
    type: 'bulletList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [p(item)],
    })),
  };
}

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
    summary:
      'EPIC: Missing data features — ejendomme tabs, udbudshistorik, skat historik, diagrammer',
    issueType: 'Epic',
    priority: 'High',
    labels: ['feature', 'data-gaps', 'ejendomme'],
    description: [
      p(
        'This epic covers missing data integrations and UI features identified during the data source audit (April 2026).'
      ),
      heading('Features'),
      bulletList([
        'Ejendomme tab på virksomhedsordningen (enkeltmandsvirksomhed/personligt ejede selskaber) — personsiden mangler direkte ejendomsopslag',
        'Ejendomme tab på personsiden med samme design som virksomheds-tab',
        'Udbudshistorik (listing/offering history) — salgshistorik eksisterer men udbudsdata mangler',
        'Ejendomme-noder i diagrammer for ejendoms- og personsider — delvist implementeret men mangler data-trigger',
        'Historisk ejendomsskat og grundskyld — kun nuværende år vises, historik mangler',
      ]),
      heading('Design Princip'),
      p(
        'Alle nye ejendomme-tabs skal følge det eksisterende design fra virksomheds-tab (Virksomheder-tabben) med 3-sektions cards, badges, og hierarkisk layout. PropertyOwnerCard-komponenten genbruges.'
      ),
    ],
  },

  // ── TICKET 1: Ejendomme tab på personsiden ─────────────────────────────
  {
    summary: '[P1] Ejendomme tab på personsiden — direkte personejede ejendomme',
    issueType: 'Story',
    priority: 'High',
    labels: ['feature', 'ejendomme', 'person-page', 'p1'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Personsiden (app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx) har allerede en "Ejendomme" tab (aktivTab === "properties", linje 1832-1932), men den viser KUN ejendomme ejet via virksomheder (CVR-opslag). Den henter ejendomme ved at samle CVR-numre fra personens ejede virksomheder og kalde /api/ejendomme-by-owner?cvr=<cvrs>.'
      ),
      heading('Hvad mangler'),
      bulletList([
        'Direkte personejede ejendomme (uden virksomhed) — kræver EJF opslag med personens enhedsNummer i stedet for CVR',
        'Mange privatpersoner ejer ejendomme direkte uden virksomhed — disse vises slet ikke i dag',
        'Virksomhedsordningen (enkeltmandsvirksomheder) — personen ejer ofte ejendomme både personligt og via virksomhed',
      ]),
      heading('Løsning'),
      bulletList([
        'Udvid /api/ejendomme-by-owner til at acceptere enhedsNummer-parameter (person) ud over CVR (virksomhed)',
        'Backend: Tilføj EJF GraphQL query med ejendePersonEnhedsNummer filter (i stedet for ejendeVirksomhedCVRNr)',
        'Personsiden: Vis to sektioner i ejendomme-tab — "Personligt ejede" og "Ejet via virksomheder"',
        'Begge sektioner bruger PropertyOwnerCard-komponenten (allerede importeret)',
      ]),
      heading('Design — skal matche Virksomheder-tab'),
      p(
        'Brug SAMME design som virksomheds-tab (Virksomheder-tabben) på både person- og virksomhedssiden:'
      ),
      bulletList([
        'Grid layout: grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 (allerede brugt)',
        'PropertyOwnerCard med showOwner=true for ejendomme ejet via virksomheder',
        'Filter chips øverst: "Alle" / "Personligt ejede" (blå) / "Via virksomheder" (amber)',
        'Progressive loading med same batching (FIRST_BATCH=5, REST_BATCH=10)',
        'Header med samlet antal ejendomme + opdeling',
      ]),
      heading('API-ændring'),
      codeBlock(
        `// Nuværende endpoint:
GET /api/ejendomme-by-owner?cvr=12345678&offset=0&limit=5

// Ny parameter:
GET /api/ejendomme-by-owner?enhedsNummer=4000012345&offset=0&limit=5

// Backend: EJF GraphQL query med:
// ejendePersonEnhedsNummer: "4000012345" (i stedet for ejendeVirksomhedCVRNr)`,
        'typescript'
      ),
      heading('Berørte filer'),
      bulletList([
        'app/api/ejendomme-by-owner/route.ts — tilføj enhedsNummer parameter + EJF person-query',
        'app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx — udvid ejendomme-tab',
        'Eventuelt: app/lib/dfCertAuth.ts — sikr at person-EJF query bruger korrekt grant',
      ]),
      labelValue('Effort', 'M (3-5 dage)'),
      labelValue(
        'Risk',
        'Medium — EJF person-query er ikke testet endnu; kræver DataAccessGrant for persondata'
      ),
    ],
  },

  // ── TICKET 2: Ejendomme tab på virksomhedssiden (forbedring) ──────────
  {
    summary: '[P1] Ejendomme tab — tilføj virksomhedsordning/enkeltmandsvirksomhed-ejede ejendomme',
    issueType: 'Story',
    priority: 'High',
    labels: ['feature', 'ejendomme', 'company-page', 'virksomhedsordning', 'p1'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Virksomhedssiden (VirksomhedDetaljeClient.tsx) har en fungerende "Ejendomme" tab med PropertyOwnerCard-grid, filter chips (Alle/Ejendomme/Ejendomshandler), og progressive loading. Den bruger /api/ejendomme-by-owner?cvr=<cvrs> til at finde ejendomme.'
      ),
      heading('Hvad mangler'),
      bulletList([
        'For enkeltmandsvirksomheder (virksomhedsordningen) ejes ejendomme ofte af PERSONEN bag virksomheden, ikke af CVR-nummeret',
        'Når en enkeltmandsvirksomhed har 0 ejendomme via CVR, bør vi vise ejernes personlige ejendomme',
        'Kræver: find personens enhedsNummer fra deltagere-arrayet → kald EJF med person-filter',
      ]),
      heading('Løsning'),
      bulletList([
        'Detekter virksomhedsform: "Enkeltmandsvirksomhed" (form.kortBeskrivelse === "ENK")',
        'For ENK: Hent ejerens enhedsNummer fra deltagere (rolle: "FULDT_ANSVARLIG_DELTAGER")',
        'Kald /api/ejendomme-by-owner?enhedsNummer=<ejer> (ny parameter fra BIZZ ticket ovenfor)',
        'Vis i en separat sektion: "Ejerens personlige ejendomme" med forklaring',
        'Behold eksisterende CVR-baserede ejendomme i egen sektion',
      ]),
      heading('Design'),
      p('Brug SAMME design som Virksomheder-tabben:'),
      bulletList([
        'Tilføj ekstra filter chip: "Ejerens ejendomme" (lilla, UserCircle icon)',
        'Genbrug PropertyOwnerCard med en label der viser ejernavn i stedet for CVR',
        'Vis forklaring-badge: "Personligt ejet af [ejernavn]"',
      ]),
      heading('Berørte filer'),
      bulletList([
        'app/dashboard/companies/[cvr]/VirksomhedDetaljeClient.tsx — ejendomme-tab udvidelse',
        'Afhænger af: /api/ejendomme-by-owner enhedsNummer-udvidelse (ticket ovenfor)',
      ]),
      labelValue('Effort', 'S (1-2 dage) — afhænger af person-ejendomme API-ticket'),
      labelValue('Risk', 'Lav — eksisterende design genbruges; kun nyt data-kald'),
    ],
  },

  // ── TICKET 3: Konsistent design mellem ejendomme-tabs ─────────────────
  {
    summary:
      '[P2] Ensret ejendomme-tab design på person- og virksomhedssiden med virksomheds-tab design',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'design', 'ejendomme', 'consistency', 'p2'],
    description: [
      heading('Kontekst'),
      p(
        'Virksomheds-tabben ("Virksomheder") på både virksomheds- og personsiden bruger et rigt 3-sektions card-design med stamdata, organisation, og regnskab. Ejendomme-tabben bruger det simplere PropertyOwnerCard (kun adresse + type + BFE badge).'
      ),
      heading('Mål'),
      p('Opgradér PropertyOwnerCard til et rigere format der matcher virksomheds-tab designet:'),
      heading('Nuværende PropertyOwnerCard indhold'),
      bulletList([
        'Adresse med MapPin icon',
        'Postnummer og by',
        'Ejendomstype badge (farvekodede: lilla/emerald/amber/blå)',
        'BFE-nummer',
        'Ejer CVR link (valgfrit)',
        'Link til ejendomsside',
      ]),
      heading('Ønsket 3-sektions design (matcher virksomheds-card)'),
      codeBlock(
        `┌─────────────────────────────────────────────────────────────┐
│  🏠 Strandvejen 123, 4. tv        [Ejerlejlighed] [Aktiv] │
├────────────────────┬──────────────────┬─────────────────────┤
│  STAMDATA          │  ØKONOMI         │  SKATTEDATA         │
│  BFE: 12.345.678   │  Vurdering:      │  Grundskyld:        │
│  Matrikel: 5ab     │  2.400.000 DKK   │  8.160 DKK/år       │
│  Areal: 85 m²      │  Grundværdi:     │  Ejendomsskat:      │
│  Byggeår: 1934     │  1.200.000 DKK   │  4.800 DKK/år       │
│  Opvarming: Fjern  │  Seneste handel: │                     │
│                    │  2.150.000 (2023)│                     │
├────────────────────┴──────────────────┴─────────────────────┤
│  Ejer: CVR 12345678 — Ejendomsselskabet ApS     [→ Åbn]   │
└─────────────────────────────────────────────────────────────┘`,
        'text'
      ),
      heading('Data der skal hentes'),
      bulletList([
        'Sektion 1 (Stamdata): Allerede tilgængelig i EjendomSummary + kan udvides med BBR-data',
        'Sektion 2 (Økonomi): Kræver vurderingsdata — kald /api/vurdering?bfeNummer=X per ejendom (lazy)',
        'Sektion 3 (Skat): Kræver grundskyld/ejendomsskat — fra /api/vurdering-forelobig (lazy)',
        'Seneste handel: Fra /api/salgshistorik?bfeNummer=X (lazy)',
      ]),
      heading('Implementering'),
      bulletList([
        'Opret ny PropertyDetailCard komponent (eller udvid PropertyOwnerCard)',
        'Lazy-load økonomi/skat-data per kort når det scrolles ind i viewport (IntersectionObserver)',
        'Vis skeleton-state mens data loader',
        'Genbrug samme bg-[#0f1729] / border-slate-700/50 / divider styling som virksomheds-cards',
      ]),
      heading('Berørte filer'),
      bulletList([
        'app/components/ejendomme/PropertyOwnerCard.tsx — udvid eller opret ny variant',
        'app/dashboard/companies/[cvr]/VirksomhedDetaljeClient.tsx — brug nyt card',
        'app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx — brug nyt card',
      ]),
      labelValue('Effort', 'M (3-5 dage)'),
      labelValue(
        'Risk',
        'Medium — lazy-loading af vurderingsdata per card kan generere mange API-kald for ejere med mange ejendomme. Overvej batch-endpoint.'
      ),
    ],
  },

  // ── TICKET 4: Udbudshistorik ──────────────────────────────────────────
  {
    summary: '[P2] Udbudshistorik — integrér markedsdata for ejendomsudbud og prisændringer',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'ejendomme', 'udbudshistorik', 'markedsdata', 'p2'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'Salgshistorik (EJF_Ejerskifte + EJF_Handelsoplysninger) er LIVE og fungerer på både ejendoms- og virksomhedssider. Udbudshistorik (listing history) er kun en placeholder med teksten: "Udbudshistorik med prisændringer og handelstyper kræver markedsdata-integration (backlog)."'
      ),
      heading('Hvad eksisterer allerede'),
      bulletList([
        'Mock interface defineret: UdbudsHistorikRaekke med status, prisaendring, pris, dato (app/lib/mock/ejendomme.ts linjer 146-153)',
        'Placeholder UI i "Økonomi" tab på ejendomssiden (EjendomDetaljeClient.tsx linje 3653-3663)',
        'Mock data tab med eksempel-data (linje 6021-6076)',
      ]),
      heading('Datakilde-muligheder'),
      bulletList([
        'Boliga.dk API — Mest komplet dansk ejendomsudbuds-database (historiske annoncer, prisændringer, liggetid)',
        'Boligsiden.dk — Officiel API fra Dansk Ejendomsmæglerforening (aktive udbud)',
        'EDC/Nybolig/DanBolig feeds — Individuelle mæglerkæder',
        'OIS (Offentlig Informationsserver) — Begrænset udbudsdata',
        'Scraping er IKKE en option (GDPR + legal risiko)',
      ]),
      heading('Ønsket funktionalitet'),
      bulletList([
        'Udbudspris og dato for alle historiske udbud',
        'Prisændringer over tid (originalpris → endelig pris)',
        'Liggetid (dage på markedet)',
        'Mægler/kæde information',
        'Udbudstype (til salg, til leje, tvangssalg)',
        'Billeder/fotos (hvis tilgængeligt via API)',
      ]),
      heading('Implementeringsplan'),
      bulletList([
        '1. Research: Evaluer Boliga API adgang og priser (kontakt boliga.dk)',
        '2. API route: /api/udbudshistorik?bfeNummer=X (eller ?adresse=X som fallback)',
        '3. UI: Udfyld eksisterende placeholder i "Økonomi" tab',
        '4. Integration på virksomhedsside: Vis udbud som del af ejendomshandler',
        '5. Kombiner med salgshistorik: Vis udbudspris vs. faktisk salgspris',
      ]),
      heading('UI Design'),
      codeBlock(
        `Udbudshistorik tabel:
| Dato       | Status      | Udbudspris  | Ændring     | Liggetid | Mægler     |
|------------|-------------|-------------|-------------|----------|------------|
| 2024-03-15 | Solgt       | 2.495.000   | -105.000    | 87 dage  | EDC        |
| 2023-11-01 | Udbudt      | 2.600.000   | —           | —        | EDC        |
| 2021-06-20 | Solgt       | 2.200.000   | 0           | 14 dage  | Nybolig    |`,
        'text'
      ),
      labelValue('Effort', 'L (1-2 uger) — inkluderer ekstern API evaluering og kontrakt'),
      labelValue('Risk', 'Høj — afhænger af ekstern dataleverandør; pris og API-adgang ukendt'),
      labelValue('Afhængigheder', 'Kræver kommerciel aftale med dataleverandør'),
    ],
  },

  // ── TICKET 5: Ejendomme i diagrammer ──────────────────────────────────
  {
    summary: '[P2] Forbedre ejendomme-noder i diagrammer for person- og ejendomssider',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'diagram', 'ejendomme', 'p2'],
    description: [
      heading('Nuværende tilstand'),
      p('Ejendomme som diagram-noder er ALLEREDE implementeret i kodebasen:'),
      bulletList([
        'DiagramNode type "property" eksisterer (DiagramData.ts linje 61)',
        'DiagramPropertySummary interface defineret (DiagramData.ts linje 39-50)',
        'buildDiagramGraph() tilføjer property leaf-nodes (DiagramData.ts linje 351-377)',
        'buildPersonDiagramGraph() tilføjer property leaf-nodes (DiagramData.ts linje 661-686)',
        'Grøn styling implementeret i DiagramForce.tsx (PROPERTY_FILL, PROPERTY_STROKE)',
        'Max 6 ejendomme per virksomhed (MAX_PROPS_PER_COMPANY)',
      ]),
      heading('Hvad mangler / kan forbedres'),
      bulletList([
        '1. Data-trigger: Ejendomme-data (ejendommeData) hentes kun når "properties" tabben aktiveres. Hvis brugeren går direkte til "diagram" tabben, er propertiesByCvr tom/undefined',
        '2. Personligt ejede ejendomme vises IKKE i person-diagrammet — kun virksomhedsejede (fordi data kommer fra CVR-baseret /api/ejendomme-by-owner)',
        '3. Ejendomsside-diagram (/api/ejerskab/chain): Viser allerede ejendom som central node, men har IKKE andre ejendomme ejet af samme ejere',
        '4. Overflow handling: Når en virksomhed ejer >6 ejendomme vises de bare ikke — ingen "+X mere" node',
        '5. Ejendomsnoderne viser kun adresse og type — mangler vurdering og areal',
      ]),
      heading('Løsning'),
      bulletList([
        'Pre-fetch ejendomme-data når diagram-tab åbnes (ikke kun properties-tab) — allerede delvist gjort via aktivTab check på linje 922-938, men timing-issue kan forekomme',
        'Tilføj personligt ejede ejendomme til person-diagram (når person-EJF query er implementeret, se relateret ticket)',
        'Tilføj overflow-node: "+12 ejendomme" med link til properties-tab',
        'Berig ejendomsnoder med areal og vurdering (DiagramPropertySummary udvidelse)',
        'På ejendomssiden: vis andre ejendomme ejet af ejerne som sekundære property-noder',
      ]),
      heading('Teknisk detalje'),
      codeBlock(
        `// DiagramData.ts — nuværende MAX_PROPS_PER_COMPANY = 6
// Tilføj overflow node:
if (props.length > MAX_PROPS_PER_COMPANY) {
  const overflowId = \`props-overflow-\${cvr}\`;
  nodes.push({
    id: overflowId,
    label: \`+\${props.length - MAX_PROPS_PER_COMPANY} ejendomme\`,
    type: 'property',
    link: undefined, // link til properties-tab
  });
  edges.push({ from: companyNode.id, to: overflowId });
}`,
        'typescript'
      ),
      heading('Berørte filer'),
      bulletList([
        'app/components/diagrams/DiagramData.ts — overflow logic + data enrichment',
        'app/components/diagrams/DiagramForce.tsx — overflow node styling',
        'app/dashboard/companies/[cvr]/VirksomhedDetaljeClient.tsx — pre-fetch timing',
        'app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx — person-ejede ejendomme i diagram',
        'app/api/ejerskab/chain/route.ts — tilføj andre ejendomme for ejere',
      ]),
      labelValue('Effort', 'M (3-5 dage)'),
      labelValue(
        'Risk',
        'Lav — bygger på eksisterende implementering; primært data-timing og enrichment'
      ),
    ],
  },

  // ── TICKET 6: Historisk ejendomsskat og grundskyld ────────────────────
  {
    summary: '[P2] Historisk ejendomsskat og grundskyld — vis skatteudvikling over tid',
    issueType: 'Story',
    priority: 'Medium',
    labels: ['feature', 'ejendomme', 'skat', 'grundskyld', 'historik', 'p2'],
    description: [
      heading('Nuværende tilstand'),
      p(
        'SKAT-tabben på ejendomssiden (EjendomDetaljeClient.tsx, aktivTab === "skatter") viser KUN nuværende beskatning:'
      ),
      bulletList([
        'Grundskyld til kommunen (fra foreløbig vurdering eller estimeret)',
        'Ejendomsværdiskat (fra foreløbig vurdering)',
        'Total skat (sum af grundskyld + ejendomsværdiskat)',
        'Grundskyldspromille for kommunen',
        'Særhåndtering af kolonihaver (fritaget for ejendomsværdiskat)',
      ]),
      heading('Hvad mangler'),
      bulletList([
        'Historisk grundskyld over tid (år for år) — kun ét år vises',
        'Historisk ejendomsskat (ejendomsværdiskat) over tid',
        'Grundskyld-stigningsbegrænsning (4,75% loft, ESL § 45) — kommenteret ud i koden med "Kræver historisk grundskyld-data" (linje 998-999)',
        'Skatteudvikling graf/tabel der viser trends',
        'Sammenligning: gammel vurdering (2011-system) vs. ny vurdering (2020+) og skatte-impact',
        'Indefrysning af grundskyld (overgangsordning 2024-2028)',
      ]),
      heading('Datakilder'),
      p('Historisk data er tilgængeligt via flere kilder:'),
      bulletList([
        '1. Datafordeler VUR GraphQL v2 — allerede brugt til vurderingshistorik (alle år), men skatteberegning udføres ikke for historiske år',
        '2. Vurderingsportalen API (api-fs.vurderingsportalen.dk) — foreløbige vurderinger med FAKTISKE skatteberegninger (grundskyld, ejendomsskat), men kun for nyeste vurderingsår',
        '3. Grundskyldspromille-tabel (GRUNDSKYLDSPROMILLE i vurdering/route.ts) — kun 2025-satser; historiske satser mangler',
        '4. SKAT/Skatteforvaltningen — eventuel API for historiske skatteberegninger (skal undersøges)',
      ]),
      heading('Implementeringsplan'),
      bulletList([
        '1. Udvid /api/vurdering til at beregne estimeret grundskyld for ALLE historiske vurderingsår (ikke kun nyeste)',
        '2. Tilføj historiske grundskyldspromiller per kommune (2020-2025 minimum) i GRUNDSKYLDSPROMILLE tabel',
        '3. Implementer grundskyld-stigningsbegrænsning beregning (4,75% loft baseret på forrige års grundskyld)',
        '4. Beregn indefrysningsbeløb for overgangsordningen (2024-2028)',
        '5. UI: Tilføj "Skattehistorik" sektion i SKAT-tabben med tabel og graf',
        '6. Research: Undersøg om SKAT har API med faktiske historiske skatteberegninger',
      ]),
      heading('UI Design'),
      codeBlock(
        `SKAT-tabben udvidelse:

┌─ Nuværende beskatning (eksisterer) ─────────────────────┐
│  Grundskyld: 8.160 DKK/år  │  Ejendomsskat: 4.800 DKK  │
└─────────────────────────────────────────────────────────┘

┌─ Skattehistorik (NYT) ─────────────────────────────────┐
│                                                         │
│  📊 [Linjegraf: Grundskyld + Ejendomsskat over tid]    │
│                                                         │
│  | År   | Grundværdi  | Grundskyld | Ejendomsskat |    │
│  |------|-------------|------------|--------------|    │
│  | 2025 | 1.200.000   | 8.160      | 4.800        |    │
│  | 2024 | 1.150.000   | 7.820      | 4.600        |    │
│  | 2023 | 1.100.000   | 7.480      | 4.400        |    │
│  | 2022 | 1.050.000   | 7.140      | 4.200        |    │
│  | ...  | ...         | ...        | ...          |    │
│                                                         │
│  ⚠️ Stigningsbegrænsning: Grundskyld stiger max        │
│     4,75% pr. år (ESL § 45)                             │
│                                                         │
│  💰 Indefrysning (overgangsordning):                    │
│     Indefrosset beløb: 12.450 DKK (2024-2028)          │
└─────────────────────────────────────────────────────────┘`,
        'text'
      ),
      heading('Berørte filer'),
      bulletList([
        'app/api/vurdering/route.ts — beregn historisk grundskyld for alle vurderingsår',
        'app/api/vurdering/route.ts — tilføj historiske grundskyldspromiller (2020-2025)',
        'app/dashboard/ejendomme/[id]/EjendomDetaljeClient.tsx — udvid SKAT-tabben med historik-sektion',
        'Eventuelt: ny komponent app/components/ejendomme/SkatHistorikChart.tsx (Recharts linjegraf, lazy-loaded)',
      ]),
      heading('Lovgivning der skal overholdes'),
      bulletList([
        'Ejendomsskatteloven (ESL) § 45 — 4,75% stigningsbegrænsning på grundskyld',
        'Ejendomsvurderingsloven (EVL) § 9 — fritagelser (kolonihaver, landbrug mm.)',
        'Overgangsordningen 2024-2028 — indefrysning af grundskyldsstigning ved nye vurderinger',
        'Kommunale grundskyldspromiller fastsættes årligt — historiske satser skal researches',
      ]),
      labelValue('Effort', 'L (1-2 uger) — inkluderer research af historiske skattesatser'),
      labelValue(
        'Risk',
        'Medium — historiske grundskyldspromiller skal indsamles manuelt; estimerede beregninger kan afvige fra faktiske skatteberegninger'
      ),
    ],
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Creating missing features JIRA tickets...\n');

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
            // Epic link type may vary
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
