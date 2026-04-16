/**
 * Creates JIRA ticket for Boliga Pro API integration
 * and adds "On Hold" status to the project workflow.
 *
 * Run: JIRA_API_TOKEN=xxx node scripts/create-boliga-ticket.mjs
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

// ---------------------------------------------------------------------------
// Step 1: Create "On Hold" status if it doesn't exist
// ---------------------------------------------------------------------------

async function ensureOnHoldStatus() {
  console.log('\n--- Step 1: Checking for "On Hold" status ---');

  // Get all statuses for the project
  const statuses = await jiraRequest('GET', `/project/${PROJECT_KEY}/statuses`);
  const allStatuses = statuses.flatMap((t) => t.statuses || []);
  const existing = allStatuses.find(
    (s) => s.name.toLowerCase() === 'on hold'
  );

  if (existing) {
    console.log(`✓ "On Hold" status already exists (id: ${existing.id})`);
    return existing.id;
  }

  console.log('"On Hold" status not found. Attempting to create...');

  // Try creating via the statuses API (requires admin)
  try {
    const result = await jiraRequest('POST', '/statuses', {
      statuses: [
        {
          name: 'On Hold',
          statusCategory: 'IN_PROGRESS',
          description:
            'Issue is blocked or waiting on external input/approval',
        },
      ],
      scope: { type: 'PROJECT', project: { id: await getProjectId() } },
    });
    console.log('✓ "On Hold" status created successfully');
    return result?.[0]?.id;
  } catch (err) {
    console.error(
      '⚠ Could not create status via API. You may need to add it manually:'
    );
    console.error(
      '  → JIRA → Project Settings → Board → Columns → Add "On Hold" column'
    );
    console.error(`  Error: ${err.message}`);
    return null;
  }
}

async function getProjectId() {
  const project = await jiraRequest('GET', `/project/${PROJECT_KEY}`);
  return project.id;
}

// ---------------------------------------------------------------------------
// Step 2: Create Boliga Pro API ticket
// ---------------------------------------------------------------------------

async function createBoligaTicket() {
  console.log('\n--- Step 2: Creating Boliga Pro API ticket ---');

  const description = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Baggrund' }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'BizzAssist har allerede komplet salgshistorik fra Datafordeler EJF (faktiske handler med priser) og Tinglysning (skøder med køber/sælger). Der mangler dog markedsdata: udbudshistorik, liggetider, prisnedsættelser, og sammenlignelige handler med kr/m².',
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Krav' }],
      },
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: '1. Boliga Pro API-aftale' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Kontakt Boliga/Berlingske Media for API-adgang (boliga.dk/pro)',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Afklar priser (estimat: 5.000–25.000 kr/md afhængigt af volumen)',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Afklar DPA (Data Processing Agreement) jf. GDPR-krav',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Tilføj Boliga som sub-processor i app/privacy/page.tsx når aftale er på plads',
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: '2. API-integration (efter aftale)' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Nyt endpoint: /api/boliga?bfeNummer=XXX — hent udbudshistorik og sammenlignelige handler',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Data: udbudspris, salgspris, liggetid (dage), prisnedsættelser, kr/m², ejendomstype',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Sammenlignelige handler: radius-søgning (1-2 km) for lignende ejendomme efter størrelse/type',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Caching: LRU cache + HTTP cache headers (min. 1 time)',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Rate limiting via Upstash Redis (allerede konfigureret)',
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [
          {
            type: 'text',
            text: '3. UI — Ejendomsside (Økonomi-fanen)',
          },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Udbudshistorik-sektion: tabel med dato, udbudspris, prisnedsættelser, liggetid, mægler',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Sammenlignelige handler-sektion: kort + tabel med lignende solgte ejendomme, kr/m², afstand',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Udvid EjendomPrisChart med udbudspris vs. salgspris overlay',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Erstat "coming soon" placeholders i EjendomDetaljeClient.tsx (linje ~565-576)',
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Sikkerhed & compliance' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'API-nøgle i .env.local (BOLIGA_API_KEY) — aldrig i kode',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'AbortSignal.timeout(10000) på alle fetch-kald',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Tenant-scoped: alle kald via resolveTenantId()',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Ingen PII i logs eller Sentry',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'DPA med Boliga/Berlingske Media inden data sendes/modtages',
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Acceptance criteria' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: '[ ] Kommerciel aftale med Boliga på plads',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: '[ ] DPA underskrevet og Boliga tilføjet som sub-processor',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: '[ ] /api/boliga endpoint returnerer udbudshistorik + sammenlignelige handler',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: '[ ] Ejendomssiden viser udbudshistorik og sammenlignelige handler (ikke "coming soon")',
                  },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: '[ ] Unit tests for API-route + component tests for UI',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const result = await jiraRequest('POST', '/issue', {
    fields: {
      project: { key: PROJECT_KEY },
      summary:
        'Boliga Pro API-integration — udbudshistorik og sammenlignelige handler',
      description,
      issuetype: { name: 'Story' },
      priority: { name: 'Medium' },
      labels: ['integration', 'markedsdata', 'phase-2'],
    },
  });

  console.log(`✓ Ticket created: ${result.key}`);
  console.log(
    `  URL: https://${JIRA_HOST}/browse/${result.key}`
  );
  return result.key;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('BizzAssist — Boliga Pro API JIRA Ticket Creator\n');

  // Step 1: Ensure "On Hold" status exists
  await ensureOnHoldStatus();

  // Step 2: Create the ticket
  const ticketKey = await createBoligaTicket();

  console.log('\n--- Done ---');
  console.log(`Ticket: ${ticketKey}`);
  console.log(
    `URL: https://${JIRA_HOST}/browse/${ticketKey}`
  );
  console.log(
    '\nNote: Set ticket to "On Hold" status manually if the automated status creation requires workflow configuration.'
  );
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
