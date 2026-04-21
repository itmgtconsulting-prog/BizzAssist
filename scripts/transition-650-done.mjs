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
      txt('Manuel trigger på test.bizzassist.dk (med '),
      code('Authorization: Bearer $CRON_SECRET'),
      txt(' + '),
      code('x-vercel-cron: 1'),
      txt('):')
    ),
    p(
      code(
        'GET /api/cron/pull-tinglysning-aendringer?windowDays=1&maxPages=2'
      )
    ),
    p(strong('Response (200 OK):')),
    p(
      code(
        '{"ok":true,"windowDays":1,"datoFra":"2026-04-20","datoTil":"2026-04-21","aendringerFound":200,"pagesFetched":2,"bfesUnique":200,"bfesProcessed":200,"rowsUpserted":785,"rowsFailed":0,"partialError":null,"durationMs":14448}'
      )
    ),
    h(3, 'Acceptance criteria'),
    ul(
      li(
        p(
          strong('Manuel trigger: '),
          txt('✓ Returnerer '),
          code('{ ok: true, bfesProcessed, rowsUpserted }'),
          txt(' som beskrevet.')
        )
      ),
      li(
        p(
          strong('Cursor-update: '),
          txt('✓ '),
          code('public.tinglysning_aendring_cursor'),
          txt(' opdateret: '),
          code('last_run_at=2026-04-21 00:31:39'),
          txt(', '),
          code('rows_processed=785'),
          txt(', '),
          code('bfes_processed=200'),
          txt(', '),
          code('error=null'),
          txt('.')
        )
      ),
      li(
        p(
          strong('Duration: '),
          txt('14,4s for 200 BFEer (×8 concurrency) — godt inden for '),
          code('maxDuration=300'),
          txt('. 5-dages-vindue estimeret ~70s ved sammelig volumen.')
        )
      ),
      li(
        p(
          strong('Monitoring: '),
          txt('✓ '),
          code('pull-tinglysning-aendringer'),
          txt(' registreret i '),
          code('CRONS[]'),
          txt(' ('),
          code('app/api/admin/cron-status/route.ts:114'),
          txt(') — watchdog detekterer overdue.')
        )
      ),
      li(
        p(
          strong('Migration: '),
          code('supabase/migrations/053_tinglysning_aendring_cursor.sql'),
          txt(' — singleton med check-constraint id=default, RLS enabled.')
        )
      ),
      li(
        p(
          strong('Helper-lib: '),
          code('app/lib/ejfIngest.ts'),
          txt(' eksporterer '),
          code('fetchEjerskabForBFE'),
          txt(', '),
          code('mapNodeToRow'),
          txt(', '),
          code('upsertEjfBatch'),
          txt(', '),
          code('getEjfToken'),
          txt(' — delt mellem pull-cron og ingest-ejf-bulk.')
        )
      ),
      li(
        p(
          strong('Scheduling: '),
          code('vercel.json'),
          txt(' har '),
          code('15 3 * * *'),
          txt(' — dagligt 03:15 UTC, før andre daglige jobs.')
        )
      ),
      li(
        p(
          strong('Sikkerhed: '),
          txt('✓ CRON_SECRET bearer + x-vercel-cron-header krav i '),
          code('withCronMonitor'),
          txt(' wrapper.')
        )
      )
    ),
    h(3, 'Note'),
    p(
      txt('Verifikation kørt på '),
      code('test'),
      txt(' (rate-limit-hensyn og bfes_processed=200 → ~785 rows). Prod-cron kører dagligt 03:15 UTC og vil tilsvarende holde '),
      code('ejf_ejerskab.max(sidst_opdateret)'),
      txt(' < 48h gammel.')
    ),
    p(strong('BIZZ-650 → Done.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-650/comment', { body });
console.log(c.status === 201 ? '✅ comment posted' : `❌ (${c.status}) ${c.body}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-650/transitions');
const transitions = JSON.parse(tr.body).transitions || [];
const done = transitions.find((t) => /^done$/i.test(t.name));
if (!done) {
  console.log('⚠️ Done transition not available');
  process.exit(1);
}
const r = await req('POST', '/rest/api/3/issue/BIZZ-650/transitions', {
  transition: { id: done.id },
});
console.log(r.status === 204 ? '✅ BIZZ-650 → Done' : `⚠️ (${r.status}) ${r.body}`);
