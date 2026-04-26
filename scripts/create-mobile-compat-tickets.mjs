#!/usr/bin/env node
/**
 * Create epic + 8 child tickets for mobile browser compatibility audit.
 * Priorities: P1 (Medium), P2 (Medium), P3 (Low). All start in To Do.
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

// ─── Epic ────────────────────────────────────────────────────────────────
const epic = {
  fields: {
    project: { key: 'BIZZ' },
    issuetype: { name: 'Epic' },
    priority: { name: 'Medium' },
    summary: 'Mobile browser compatibility — iOS Safari + Chrome Mobile polish',
    labels: ['mobile', 'ux', 'ios-safari', 'a11y', 'epic'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          txt(
            'Audit af kodebasen (2026-04-21) identificerede konkrete mobile browser-issues primært på iOS Safari. App fungerer godt på desktop men har kanter på mobil. Ingen kritiske bugs — alle issues er progressive enhancements.'
          )
        ),
        h(2, 'Issues i denne epic'),
        ul(
          li(p(strong('P1: '), txt('Input auto-zoom på iOS (text-sm < 16px)'))),
          li(p(strong('P1: '), txt('Viewport maximumScale=1 blokerer pinch-to-zoom (a11y)'))),
          li(p(strong('P2: '), txt('Search-dropdown overflow < 390px'))),
          li(p(strong('P2: '), txt('Mapbox + d3-diagrammer: ingen timeout/retry på slow network'))),
          li(p(strong('P2: '), txt('Admin-tabeller mangler overflow-x-auto wrapper'))),
          li(p(strong('P3: '), txt('Hero-billede mangler responsive srcset/sizes'))),
          li(p(strong('P3: '), txt('Hero h1 text-7xl uræmbar < 340px'))),
          li(p(strong('P3: '), txt('PWA start_url peger på /dashboard (kræver auth)')))
        ),
        h(2, 'Ikke-issues'),
        p(
          txt(
            'Sidebar, modaler, drawers fungerer korrekt med fixed/sticky. Support-chat widget er korrekt positioneret bottom-left på mobil (verificeret via Playwright iPhone 13 emulation). Service worker er network-first for HTML + cache-first for static chunks — ingen stale-CSS-risk.'
          )
        ),
      ],
    },
  },
};

const tickets = [
  // P1
  {
    summary: 'Mobile: Input-felter med text-sm (14px) trigger iOS auto-zoom',
    priority: 'Medium',
    labels: ['mobile', 'ios-safari', 'ux', 'forms', 'p1'],
    content: [
      h(2, 'Problem'),
      p(
        txt('Alle '),
        code('<input>'),
        txt('-elementer bruger '),
        code('text-sm'),
        txt(' (14px). iOS Safari auto-zoomer når et input < 16px får focus — bryder layout + irriterende for brugeren.')
      ),
      h(2, 'Filer (ikke udtømmende)'),
      ul(
        li(p(code('app/login/LoginClient.tsx'), txt(' (~linje 415)'))),
        li(p(code('app/dashboard/layout.tsx'), txt(' (søg-input ~linje 768)'))),
        li(
          p(
            txt('Alle andre '),
            code('<input>'),
            txt(' + '),
            code('<textarea>'),
            txt(' med text-sm.')
          )
        )
      ),
      h(2, 'Fix'),
      p(
        txt('Sæt font-size til min. 16px på input/textarea: '),
        code('text-base'),
        txt(' (i stedet for '),
        code('text-sm'),
        txt('), eller tilføj '),
        code('@media (pointer: coarse) { input { font-size: 16px; } }'),
        txt(' i global CSS.')
      ),
      h(2, 'Acceptance'),
      ul(
        li(p(txt('iPhone 13 Safari: fokus i søge-input zoomer ikke viewport.'))),
        li(p(txt('Samme for login + bug-report + support-chat.'))),
        li(p(txt('Visuelt tjek: inputs er stadig æstetisk OK (ingen tekst clipping).')))
      ),
    ],
  },
  {
    summary: 'Mobile a11y: fjern maximumScale=1 fra viewport metadata',
    priority: 'Medium',
    labels: ['mobile', 'a11y', 'ios-safari', 'p1'],
    content: [
      h(2, 'Problem'),
      p(
        code('app/layout.tsx'),
        txt(' linje ~74-79 har '),
        code('maximumScale: 1'),
        txt(' i viewport-metadata. Det låser pinch-to-zoom på iOS + Android. Brugere med synsnedsættelse kan ikke zoome ind — WCAG 2.1 violation (1.4.4 Resize text).')
      ),
      h(2, 'Fix'),
      p(txt('Fjern '), code('maximumScale'), txt(' (eller sæt til 5). Lad browseren håndtere zoom naturligt.')),
      h(2, 'Acceptance'),
      ul(
        li(p(txt('Pinch-to-zoom virker på alle sider.'))),
        li(p(txt('Ingen regression i layout ved default zoom.')))
      ),
    ],
  },
  // P2
  {
    summary: 'Mobile: Search-dropdown overflow på iPhone SE/6 (< 390px bredde)',
    priority: 'Medium',
    labels: ['mobile', 'ux', 'search', 'p2'],
    content: [
      h(2, 'Problem'),
      p(
        txt('Søg-dropdown i dashboard-header ('),
        code('app/dashboard/layout.tsx'),
        txt(' ~linje 799-809) bruger beregnet width fra input-element uden '),
        code('max-width'),
        txt('-constraint. På iPhone SE (375px) kan dropdown stikke ud over viewport-kanten.')
      ),
      h(2, 'Fix'),
      p(
        txt('Tilføj '),
        code('max-w-[calc(100vw-1rem)]'),
        txt(' + clamp left-offset med '),
        code('left: max(0, ...)'),
        txt(' i inline-style.')
      ),
    ],
  },
  {
    summary: 'Mobile: Mapbox + DiagramForce mangler timeout/retry på langsomt netværk',
    priority: 'Medium',
    labels: ['mobile', 'ux', 'performance', 'mapbox', 'diagram', 'p2'],
    content: [
      h(2, 'Problem'),
      p(
        txt(
          'På 3G/4G kan Mapbox og d3-force-diagrammer hænge i loading-state uden feedback. Bruger ved ikke om siden er død eller bare langsom.'
        )
      ),
      h(2, 'Filer'),
      ul(
        li(p(code('app/components/ejendomme/PropertyMap.tsx'))),
        li(p(code('app/components/diagrams/DiagramForce.tsx')))
      ),
      h(2, 'Fix'),
      p(
        txt('Tilføj timeout (8-10s) med fallback: "Kunne ikke indlæse kort/diagram. ')
        ,
        txt('Prøv igen" + retry-knap. Log til Sentry hvis timeout faktisk rammes.')
      ),
    ],
  },
  {
    summary: 'Mobile: Admin-tabeller mangler overflow-x-auto wrapper',
    priority: 'Medium',
    labels: ['mobile', 'admin', 'ux', 'p2'],
    content: [
      h(2, 'Problem'),
      p(
        txt('Flere admin-tabeller ('),
        code('ServiceManagerClient.tsx'),
        txt(', '),
        code('UsersClient.tsx'),
        txt(', '),
        code('BillingClient.tsx'),
        txt(' m.fl.) har '),
        code('<table>'),
        txt(' uden horizontal scroll-wrapper. Kolonne-bredder overstiger 390px → tekst clipping eller zoom-out.')
      ),
      h(2, 'Fix'),
      p(
        txt('Wrap hver tabel i '),
        code('<div className="overflow-x-auto">'),
        txt(' eller brug Tailwind-utility. Sæt '),
        code('min-width: 0'),
        txt(' på parent hvis flex-child.')
      ),
    ],
  },
  // P3
  {
    summary: 'Mobile performance: Hero-billede mangler responsive srcset/sizes',
    priority: 'Low',
    labels: ['mobile', 'performance', 'p3'],
    content: [
      h(2, 'Problem'),
      p(
        code('app/components/Hero.tsx'),
        txt(' ~linje 76-81 bruger '),
        code('/images/dashboard-preview.png'),
        txt(' uden '),
        code('sizes'),
        txt(' eller responsive versions. Mobile downloader fuld desktop-størrelse.')
      ),
      h(2, 'Fix'),
      p(
        txt('Brug Next.js '),
        code('<Image>'),
        txt(' med '),
        code('sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 100vw"'),
        txt(' + generer mobile-optimeret version.')
      ),
    ],
  },
  {
    summary: 'Mobile: Hero h1 text-7xl uræmbar på iPhone SE/mindre (< 340px)',
    priority: 'Low',
    labels: ['mobile', 'ui', 'p3'],
    content: [
      h(2, 'Problem'),
      p(
        code('app/components/Hero.tsx'),
        txt(' linje 35 har '),
        code('text-5xl sm:text-6xl lg:text-7xl'),
        txt(
          '. iPhone SE (375px, xs breakpoint) får 48px → tekst klippes eller wrapper dårligt.'
        )
      ),
      h(2, 'Fix'),
      p(
        txt('Responsiv skala med XS-breakpoint: '),
        code('text-3xl sm:text-5xl lg:text-7xl'),
        txt(' (eller lignende hvor XS er læsbar).')
      ),
    ],
  },
  {
    summary: 'Mobile PWA: start_url=/dashboard kræver auth — launch-loop for afloggede',
    priority: 'Low',
    labels: ['mobile', 'pwa', 'p3'],
    content: [
      h(2, 'Problem'),
      p(
        code('public/manifest.json'),
        txt(' har '),
        code('"start_url": "/dashboard"'),
        txt('. Når PWA launches fra home-screen uden aktiv session → redirect til /login uden naturligt redirect-back.')
      ),
      h(2, 'Fix'),
      p(
        txt('Ændre '),
        code('start_url'),
        txt(' til '),
        code('/'),
        txt(' (landing), eller implementér '),
        code('/login?redirectTo=/dashboard'),
        txt(' handling og pege start_url dertil.')
      ),
    ],
  },
];

// ─── Create epic ─────────────────────────────────────────────────────────
const epicRes = await req('POST', '/rest/api/3/issue', epic);
if (epicRes.status !== 201) {
  console.error('epic fail:', epicRes.status, epicRes.body.slice(0, 400));
  process.exit(1);
}
const EPIC = JSON.parse(epicRes.body).key;
console.log('✅ Epic:', EPIC);

// ─── Create children ────────────────────────────────────────────────────
for (const t of tickets) {
  const body = {
    fields: {
      project: { key: 'BIZZ' },
      issuetype: { name: 'Task' },
      priority: { name: t.priority },
      summary: t.summary,
      labels: t.labels,
      parent: { key: EPIC },
      description: { type: 'doc', version: 1, content: t.content },
    },
  };
  const r = await req('POST', '/rest/api/3/issue', body);
  if (r.status === 201) {
    console.log('  ✅', JSON.parse(r.body).key, '-', t.summary.slice(0, 70));
  } else {
    console.log('  ❌', r.status, t.summary.slice(0, 50), r.body.slice(0, 200));
  }
}

console.log(`\nEpic: ${EPIC}`);
