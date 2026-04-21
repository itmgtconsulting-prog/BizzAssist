#!/usr/bin/env node
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

const body = {
  type: 'doc',
  version: 1,
  content: [
    h(2, 'API-level verifikation — PASS'),
    p(
      strong('Flow end-to-end på test.bizzassist.dk'),
      txt(' for Jakob Juul Rasmussen (enhedsNummer 4000115446):')
    ),
    ul(
      li(
        p(
          code('GET /api/ejerskab/person-bridge?enhedsNummer=4000115446'),
          txt(
            ' returnerede 200 med navn Jakob Juul Rasmussen, foedselsdato 1972-07-11, viaBfe 2081243 (Søbyvej 11).'
          )
        )
      ),
      li(
        p(
          code('GET /api/ejerskab/person-properties?navn=Jakob+Juul+Rasmussen&fdato=1972-07-11'),
          txt(' returnerede 200 med '),
          strong('9 personligt ejede BFE-numre'),
          txt(' + properties[].ejerandel + virkningFra (BIZZ-596).')
        )
      ),
      li(
        p(
          strong('BFE-liste: '),
          code(
            '[2081243, 173448, 167448, 2024847, 5157134, 10133930, 100065801, 100165718, 100435372]'
          ),
          txt('. 2081243 er bopæl Søbyvej 11. Fire er fuldstændig-ejendomme (1/1), fem er ejerlejligheder (1/2).')
        )
      ),
      li(
        p(
          strong('SQL-verifikation: '),
          txt(
            'Direct query mod ejf_ejerskab returnerer samme 9 rækker som API — data-flow er konsistent.'
          )
        )
      )
    ),
    h(3, 'Infrastruktur'),
    ul(
      li(
        p(
          strong('ejf_ejerskab-volumen: '),
          txt('3.524.474 rows (gældende) på test — 2.494.727 unique BFE, 2.370.573 unique ejere.')
        )
      ),
      li(
        p(
          strong('Migrationer: '),
          code('046_ejf_ejerskab_bulk.sql'),
          txt(', '),
          code('047_ejf_ejerskab_id_text.sql'),
          txt(', '),
          code('048_ejf_ejerskab_navn_exact_idx.sql'),
          txt(' — alle applied.')
        )
      ),
      li(
        p(
          strong('Endpoints: '),
          code('/api/ejerskab/person-bridge'),
          txt(', '),
          code('/api/ejerskab/person-properties'),
          txt(', '),
          code('/api/cron/ingest-ejf-bulk'),
          txt(' (daglig delta-ingest).')
        )
      ),
      li(
        p(
          strong('Indeks: '),
          code('ix_ejf_person_lookup'),
          txt(' på (lower(ejer_navn), ejer_foedselsdato) — B-tree lookup verificeret.')
        )
      )
    ),
    p(
      strong('Hybrid-arkitektur bekræftet: '),
      txt(
        'CVR person-bridge leverer deterministisk (navn, fødselsdato), som looker op mod bulk-ingesteret ejf_ejerskab-tabel. Ingen speciel Datafordeler-grant nødvendig.'
      )
    ),
    p(strong('BIZZ-534 → Done.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-534/comment', { body });
console.log(c.status === 201 ? '✅ comment posted' : `❌ (${c.status}) ${c.body}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-534/transitions');
const transitions = JSON.parse(tr.body).transitions || [];
const done = transitions.find((t) => /^done$/i.test(t.name));
if (!done) {
  console.log('⚠️ Done transition not available');
  process.exit(1);
}
const r = await req('POST', '/rest/api/3/issue/BIZZ-534/transitions', {
  transition: { id: done.id },
});
console.log(r.status === 204 ? '✅ BIZZ-534 → Done' : `⚠️ (${r.status}) ${r.body}`);
