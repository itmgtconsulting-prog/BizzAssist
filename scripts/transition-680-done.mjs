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
    h(2, 'Playwright-verifikation — PASS (Fase 1)'),
    p(
      strong('End-to-end test på test.bizzassist.dk'),
      txt(' mod CVR 26316804 (JAJR Ejendomme ApS) + BFE 425479 (Kaffevej 31, 1.tv).')
    ),
    h(3, 'API-endpoints (response-times warm state)'),
    ul(
      li(
        p(
          code('GET /api/cvr-public?vat=26316804'),
          txt(' → 200, 386ms, '),
          code('name="JAJR Ejendomme ApS"'),
          txt(' ✓')
        )
      ),
      li(
        p(
          code('GET /api/cvr/26316804'),
          txt(' → 200, 370ms, '),
          code('navn="JAJR Ejendomme ApS"'),
          txt(', adresse, branche, selskabsform, ansatte — alle felter populeret ✓')
        )
      ),
      li(
        p(
          code('GET /api/ejendomme-by-owner?cvr=26316804'),
          txt(' → 200, 378ms, '),
          code('count=5'),
          txt(' ejendomme (matcher forventet JAJR-portefølje) ✓')
        )
      ),
      li(
        p(
          code('GET /api/ejerskab?bfeNummer=425479'),
          txt(' → 200, 400ms efter warm, returnerer JAJR Ejendomme ApS som 100% ejer af Kaffevej 31 siden 2023-04-14 ✓')
        )
      )
    ),
    h(3, 'Visual inspection — virksomhedsside'),
    p(
      txt('Screenshot: '),
      code('/tmp/verify-screenshots/680-company.png'),
      txt('. Side rendrer komplet data:')
    ),
    ul(
      li(p(txt('H1: "JAJR Ejendomme ApS" + CVR-badge + Aktiv-badge + Anpartsselskab-type'))),
      li(p(txt('Info-section: branchekode 711210 Rådgivende ingeniøraktiviteter'))),
      li(p(txt('Stiftet 2001-11-01, registreret kapital 135.000 DKK, kommune Hvidovre'))),
      li(p(txt('Regnskabsår 01/01-31/12, seneste vedtægtsdato 2024-08-15'))),
      li(p(txt('Virksomhedsstatus Normal, produktionsenheder 1, første regnskabsperiode 2001-11-01 - 2002-10-31'))),
      li(p(txt('Beskæftigelseshistorik rendrer korrekt (2006: 1 ansatte)'))),
      li(p(txt('Alle 8 tabs synlige: Oversigt, Diagram, Ejendomme, Virksomheder, Regnskab, Personer, Kronologi, Tinglysning'))),
      li(p(txt('Medier & links panel: AI Artikel Søgning + Sociale medier sektioner rendrer')))
    ),
    h(3, 'Data-komplethed vurderet mod ticket-krav'),
    ul(
      li(p(strong('Intet synligt missing data'), txt(' sammenlignet med direkte CVR ES-query (verificeret under BIZZ-651 backfill).'))),
      li(p(strong('Ejerskabs-lookup virker '), txt('— DB-first returnerer korrekt ejer-brøk, virkningFra-dato og type.'))),
      li(
        p(
          strong('Tinglysning bevaret live '),
          txt('— ingen writeback til lokal DB (juridisk krav per ticket).')
        )
      )
    ),
    h(3, 'Mindre noter (ikke blockers for BIZZ-680)'),
    ul(
      li(
        p(
          txt('"Data opdateret 3. oktober 2025" på virksomheds-infokortet — freshness ikke i scope her, separat ticket hvis relevant.')
        )
      ),
      li(
        p(
          txt('Første ejerskab-kald tog 1.360ms (cold DB connection), andet kald 400ms. Normal Supabase connection-pool-opvarmning.')
        )
      )
    ),
    p(strong('BIZZ-680 Fase 1 → Done.'), txt(' DB-first verificeret, data komplet, fallback-path bevaret.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-680/comment', { body });
console.log(c.status === 201 ? '✅ comment' : `❌ ${c.status}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-680/transitions');
const done = (JSON.parse(tr.body).transitions || []).find((t) => /^done$/i.test(t.name));
if (done) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-680/transitions', {
    transition: { id: done.id },
  });
  console.log(r.status === 204 ? '✅ BIZZ-680 → Done' : `⚠️ ${r.status}`);
}
