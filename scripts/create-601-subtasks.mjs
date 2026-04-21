#!/usr/bin/env node
/**
 * BIZZ-601 breakdown: 5 child tickets for å splitte oversized components.
 * Alle Medium priority, To Do, linked til BIZZ-601 (parent) via "relates to".
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString(
  'base64'
);
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method: m,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
        },
      },
      (x) => {
        let y = '';
        x.on('data', (c) => (y += c));
        x.on('end', () => res({ status: x.statusCode, body: y }));
      }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const commonAcceptance = [
  h(3, 'Fælles acceptance criteria'),
  ul(
    li(p(txt('Ingen enkelt ny eller eksisterende '), code('.tsx'), txt('-fil > 2000 linjer.'))),
    li(p(code('npm test'), txt(' + '), code('npm run test:e2e'), txt(' grønne — ingen regression.'))),
    li(p(txt('Ingen ændring i UI-adfærd, kun intern struktur.'))),
    li(
      p(
        code('React.memo'),
        txt(' + '),
        code('useCallback'),
        txt(' anvendes for props der destabiliserer children-renders.')
      )
    ),
    li(p(txt('Alle nye filer har JSDoc-header per CLAUDE.md.'))),
    li(p(txt('Dark-theme + bilingual strings via translations.ts bevares.'))),
  ),
];

const tickets = [
  {
    summary:
      'BIZZ-601a: split EjendomDetaljeClient.tsx (7.834 linjer) i per-tab subcomponents',
    labels: ['refactor', 'maintainability', 'code-quality', 'bizz-601'],
    description: [
      h(2, 'Scope'),
      p(
        code('app/dashboard/ejendomme/[id]/EjendomDetaljeClient.tsx'),
        txt(' er 7.834 linjer — største fil i repo. BIZZ-597 har allerede etableret delt '),
        code('EjendommeTabs'),
        txt('-pattern; brug samme dekomponeringsstrategi her.')
      ),
      h(3, 'Foreslået struktur'),
      p(code('app/dashboard/ejendomme/[id]/tabs/')),
      ul(
        li(p(code('EjendomOverblikTab.tsx'))),
        li(p(code('EjendomBBRTab.tsx'))),
        li(p(code('EjendomEjerforholdTab.tsx'))),
        li(p(code('EjendomOekonomiTab.tsx'))),
        li(p(code('EjendomSKATTab.tsx'))),
        li(p(code('EjendomTinglysningTab.tsx'))),
        li(p(code('EjendomDokumenterTab.tsx'))),
        li(p(code('EjendomKortTab.tsx'))),
        li(p(code('EjendomKronologiTab.tsx')))
      ),
      p(
        txt('Orchestrator '),
        code('EjendomDetaljeClient.tsx'),
        txt(' beholder state + tab-routing men delegerer rendering til children. Shared state løftes til '),
        code('useContext'),
        txt(' hvis flere tabs afhænger af samme data.')
      ),
      ...commonAcceptance,
      h(3, 'Tiltænkt PR-størrelse'),
      p(txt('Én commit per ekstraheret tab så review kan ske i chunks.')),
    ],
  },
  {
    summary:
      'BIZZ-601b: split VirksomhedDetaljeClient.tsx (7.852 linjer) — genbrug pattern fra 601a',
    labels: ['refactor', 'maintainability', 'code-quality', 'bizz-601'],
    description: [
      h(2, 'Scope'),
      p(
        code('app/dashboard/companies/[cvr]/VirksomhedDetaljeClient.tsx'),
        txt(
          ' — spejl af Ejendom-clienten fra 601a, samme dekomponeringsmønster. Skal landes EFTER 601a så tab-strukturen er valideret og kan kopieres 1:1 hvor det giver mening.'
        )
      ),
      h(3, 'Foreslået struktur'),
      p(code('app/dashboard/companies/[cvr]/tabs/')),
      ul(
        li(p(code('VirksomhedOverblikTab.tsx'))),
        li(p(code('VirksomhedRegnskabTab.tsx'))),
        li(p(code('VirksomhedDeltagereTab.tsx'))),
        li(p(code('VirksomhedEjendommeTab.tsx'))),
        li(p(code('VirksomhedDatterselskaberTab.tsx'))),
        li(p(code('VirksomhedMedierTab.tsx'))),
        li(p(code('VirksomhedDiagramTab.tsx')))
      ),
      p(
        strong('Genbrug: '),
        code('EjendommeTabs'),
        txt(' (fra BIZZ-597) skal bruges direkte i '),
        code('VirksomhedEjendommeTab'),
        txt(' — ingen duplikering.')
      ),
      ...commonAcceptance,
    ],
  },
  {
    summary:
      'BIZZ-601c: split PersonDetailPageClient.tsx (4.320 linjer) i subcomponents',
    labels: ['refactor', 'maintainability', 'code-quality', 'bizz-601'],
    description: [
      h(2, 'Scope'),
      p(
        code('app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx'),
        txt(' — BIZZ-597 reducerede dette fra 6k+ til 4.3k, men stadig over 2k-grænsen. Dekomponér:')
      ),
      p(code('app/dashboard/owners/[enhedsNummer]/tabs/')),
      ul(
        li(p(code('PersonOverblikTab.tsx'))),
        li(p(code('PersonEjendommeTab.tsx'), txt(' (genbruger EjendommeTabs fra BIZZ-597)'))),
        li(p(code('PersonVirksomhederTab.tsx'))),
        li(p(code('PersonDiagramTab.tsx'))),
        li(p(code('PersonMedierTab.tsx')))
      ),
      p(
        strong('Ekstraktion: '),
        code('PersonArticleSearchPanel'),
        txt(' (~400 linjer) skal flyttes til '),
        code('app/components/ai/PersonArticleSearchPanel.tsx'),
        txt(' så både PersonDetail og VirksomhedDetail (601b) kan dele det.')
      ),
      ...commonAcceptance,
    ],
  },
  {
    summary:
      'BIZZ-601d: split DiagramForce.tsx (2.662 linjer) i canvas/node/physics subcomponents',
    labels: ['refactor', 'maintainability', 'code-quality', 'diagrams', 'bizz-601'],
    description: [
      h(2, 'Scope'),
      p(
        code('app/components/diagrams/DiagramForce.tsx'),
        txt(' indeholder tre koncerns: SVG-rendering, node-rendering og physics-simulering. Split:')
      ),
      ul(
        li(
          p(
            code('DiagramCanvas.tsx'),
            txt(' — SVG-wrapper, zoom/pan-handlers, viewport-state.')
          )
        ),
        li(p(code('DiagramNodeRenderer.tsx'), txt(' — node-shapes, labels, afhængigt af entity-type.'))),
        li(
          p(
            code('lib/diagram/physicsEngine.ts'),
            txt(' — d3-force eller custom-physics, isoleret så den kan unit-testes uden React.')
          )
        ),
        li(
          p(
            code('hooks/useExpandPerson.ts'),
            txt(' — person-expand-logik pt. inline; flyt til hook så det kan genbruges + testes.')
          )
        )
      ),
      p(
        strong('Test-fokus: '),
        code('physicsEngine.ts'),
        txt(
          ' får dedikerede unit-tests for kollision, kraft-beregning, konvergens. Ingen React-mount i de tests.'
        )
      ),
      ...commonAcceptance,
    ],
  },
  {
    summary:
      'BIZZ-601e: split de 6 mellemstore filer (1.500-1.916 linjer) i subcomponents',
    labels: ['refactor', 'maintainability', 'code-quality', 'bizz-601'],
    description: [
      h(2, 'Scope'),
      p(
        txt('Filer i 1.500-2.000 linje range. Modest split er nok — ikke fuld tab-struktur som 601a/b/c.')
      ),
      ul(
        li(
          p(
            code('app/dashboard/kort/KortPageClient.tsx'),
            txt(' (1.916) — udtræk layer-controls, search-panel, property-markers som selvstændige komponenter.')
          )
        ),
        li(
          p(
            code('app/dashboard/settings/SettingsPageClient.tsx'),
            txt(' (1.758) — split per tab (profil/følger/abonnement/sikkerhed) — hver ~400 linjer.')
          )
        ),
        li(
          p(
            code('app/components/ejendomme/PropertyMap.tsx'),
            txt(' (1.714) — udtræk style-switcher + marker-layers + legend til subkomponenter.')
          )
        ),
        li(
          p(
            code('app/dashboard/admin/plans/PlansClient.tsx'),
            txt(' (1.683) — udtræk PlanEditor-modal + TokenPackEditor-modal.')
          )
        ),
        li(
          p(
            code('app/dashboard/layout.tsx'),
            txt(
              ' (1.569) — udtræk Sidebar + Breadcrumbs + SessionTimeoutHandler som selvstændige komponenter.'
            )
          )
        ),
        li(
          p(
            code('app/dashboard/admin/users/UsersClient.tsx'),
            txt(' (1.529) — udtræk UserEditModal + UserListTable + AdminActions.')
          )
        )
      ),
      ...commonAcceptance,
      p(
        strong('PR-strategi: '),
        txt('Én PR per fil, små diffs. Kan landes parallelt da filerne er uafhængige.')
      ),
    ],
  },
];

async function create(t) {
  const body = {
    fields: {
      project: { key: 'BIZZ' },
      issuetype: { name: 'Task' },
      priority: { name: 'Medium' },
      summary: t.summary,
      labels: t.labels,
      description: { type: 'doc', version: 1, content: t.description },
    },
  };
  const r = await req('POST', '/rest/api/3/issue', body);
  if (r.status !== 201) {
    console.error('FAIL', r.status, r.body.slice(0, 300));
    return null;
  }
  const key = JSON.parse(r.body).key;
  console.log('✅', key, '-', t.summary.slice(0, 80));
  // Link til BIZZ-601 som "relates to"
  const linkR = await req('POST', '/rest/api/3/issueLink', {
    type: { name: 'Relates' },
    inwardIssue: { key },
    outwardIssue: { key: 'BIZZ-601' },
  });
  console.log(linkR.status === 201 ? `   🔗 relates to BIZZ-601` : `   link-warn: ${linkR.status}`);
  return key;
}

const keys = [];
for (const t of tickets) {
  keys.push(await create(t));
}
console.log('\nAll created in To Do, Medium:');
keys.forEach((k, i) => console.log(`  ${k} — ${tickets[i].summary.slice(0, 60)}`));
