#!/usr/bin/env node
/**
 * Samler BIZZ-657..661 under en ny epic og etablerer blocks-kæde så hver
 * ticket afventer foregående. Tilføjer også "Afhænger af"-sektion i
 * beskrivelsen så det er eksplicit for den der tager ticketen.
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

const CHAIN = [
  { key: 'BIZZ-657', title: '601a — EjendomDetaljeClient' },
  { key: 'BIZZ-658', title: '601b — VirksomhedDetaljeClient' },
  { key: 'BIZZ-659', title: '601c — PersonDetailPageClient' },
  { key: 'BIZZ-660', title: '601d — DiagramForce' },
  { key: 'BIZZ-661', title: '601e — 6 mellemstore filer' },
];

// ─── 1. Create epic ─────────────────────────────────────────────────────
const epicRes = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: 'BIZZ' },
    issuetype: { name: 'Epic' },
    priority: { name: 'Medium' },
    summary: 'Refactor: split oversized .tsx components (>1500 linjer)',
    labels: ['refactor', 'maintainability', 'code-quality', 'epic'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Formål'),
        p(
          txt(
            '10 .tsx-filer er over 1500 linjer. De bremser HMR, gør code review svært og skaber merge-konflikter. Dekomponér sekventielt så vi kan validere mønsteret i 601a og genbruge det videre.'
          )
        ),
        h(2, 'Udførelses-rækkefølge (sekventiel)'),
        ul(
          li(p(strong('1. BIZZ-657 '), txt('— 601a: EjendomDetaljeClient (7.834 linjer)'))),
          li(
            p(
              strong('2. BIZZ-658 '),
              txt('— 601b: VirksomhedDetaljeClient (7.852) — genbruger 601a-tab-pattern')
            )
          ),
          li(
            p(
              strong('3. BIZZ-659 '),
              txt(
                '— 601c: PersonDetailPageClient (4.320) — deler PersonArticleSearchPanel med 601b'
              )
            )
          ),
          li(p(strong('4. BIZZ-660 '), txt('— 601d: DiagramForce (2.662)'))),
          li(p(strong('5. BIZZ-661 '), txt('— 601e: 6 mellemstore filer (1.500-1.916)')))
        ),
        h(2, 'Global acceptance'),
        ul(
          li(p(txt('Ingen '), code('.tsx'), txt('-fil > 2.000 linjer efter epic er Done.'))),
          li(p(code('npm test'), txt(' + '), code('npm run test:e2e'), txt(' grønne hele vejen.'))),
          li(p(txt('HMR reload < 2s målt i dev-server.'))),
          li(p(txt('Ingen UI-regression — kun intern struktur ændres.')))
        ),
        h(2, 'Relaterede'),
        p(
          strong('Forgænger: '),
          code('BIZZ-597'),
          txt(
            ' (Done) etablerede delt '
          ),
          code('EjendommeTabs'),
          txt('-pattern; alle 601-tasks skal genbruge det.')
        ),
        p(strong('Oprindelig parent-ticket: '), code('BIZZ-601'), txt(' (On Hold, dækker samme tema).')),
      ],
    },
  },
});
if (epicRes.status !== 201) {
  console.error('epic fail:', epicRes.status, epicRes.body.slice(0, 300));
  process.exit(1);
}
const EPIC = JSON.parse(epicRes.body).key;
console.log('✅ Epic created:', EPIC);

// ─── 2. Link existing BIZZ-601 til epic som "relates" ──────────────────
await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key: 'BIZZ-601' },
  outwardIssue: { key: EPIC },
});
console.log('🔗 BIZZ-601 relates to', EPIC);

// ─── 3. Set parent (epic link) på hver child + tilføj dependency-note ──
for (let i = 0; i < CHAIN.length; i++) {
  const { key, title } = CHAIN[i];
  const prev = i > 0 ? CHAIN[i - 1] : null;
  const next = i < CHAIN.length - 1 ? CHAIN[i + 1] : null;

  // Sæt parent (epic)
  const parentR = await req('PUT', `/rest/api/3/issue/${key}`, {
    fields: { parent: { key: EPIC } },
  });
  console.log(
    parentR.status === 204
      ? `  ✅ ${key} parent=${EPIC}`
      : `  ⚠️ ${key} parent-set status=${parentR.status} body=${parentR.body.slice(0, 200)}`
  );

  // Blocks-kæde: i blocks i+1
  if (next) {
    const lr = await req('POST', '/rest/api/3/issueLink', {
      type: { name: 'Blocks' },
      inwardIssue: { key: next.key },
      outwardIssue: { key },
    });
    console.log(
      lr.status === 201 ? `     🔗 blocks ${next.key}` : `     ⚠️ link ${lr.status}`
    );
  }

  // Tilføj dependency-afsnit som kommentar (non-destructive vs at rewrite description)
  const depBody = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        h(3, 'Afhængigheder'),
        p(
          prev
            ? txt(
                `⚠ Må IKKE startes før ${prev.key} (${prev.title}) er merged til main og deployed. Genbrug den struktur der blev etableret der.`
              )
            : strong('Første ticket i kæden — ingen forgænger. Fastlægger tab-dekomponerings-pattern som bruges af resten.')
        ),
        next
          ? p(
              txt('Blokerer '),
              code(next.key),
              txt(' ('),
              txt(next.title),
              txt(') — den næste i kæden afventer denne.')
            )
          : p(txt('Sidste ticket i kæden — afslutter epic '), code(EPIC), txt('.')),
        p(strong('Epic: '), code(EPIC)),
      ],
    },
  };
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, depBody);
  console.log(cr.status === 201 ? `     💬 dependency-note tilføjet` : `     ⚠️ comment ${cr.status}`);
}

console.log(`\nDone. Epic: ${EPIC}`);
console.log('Chain: ' + CHAIN.map((c) => c.key).join(' → '));
