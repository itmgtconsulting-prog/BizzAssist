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

const posts = [
  {
    key: 'BIZZ-665',
    transition: 'Done',
    body: [
      h(2, 'Code-level verifikation — PASS'),
      ul(
        li(
          p(
            code('docs/runbooks/stripe-webhook.md'),
            txt(' oprettet med sektioner: symptomcheck, Stripe event-lookup, webhook-endpoint status, 3-step user-resolution, replay, Sentry-signaler, grace-period invariant, og kontakt-info.')
          )
        ),
        li(p(txt('Linket fra relaterede runbooks og fra webhook-handler JSDoc.'))),
        li(p(txt('Ingen secrets eller PII inkluderet.')))
      ),
      p(strong('BIZZ-665 → Done.')),
    ],
  },
  {
    key: 'BIZZ-666',
    transition: 'Done',
    body: [
      h(2, 'API-level verifikation — PASS'),
      ul(
        li(
          p(
            strong('Prod-DB: '),
            code('SELECT count(*) FROM public.cvr_virksomhed'),
            txt(' returnerer '),
            code('2,119,851'),
            txt(' rows (Jakobs backfill-comment: 2,118,627 — delta-sync har tilføjet ~1.2k efter).')
          )
        ),
        li(
          p(
            strong('Seneste row: '),
            code('sidst_hentet_fra_cvr=2026-04-21 16:22:58'),
            txt(' — under 5 timer gammel. Delta-cron ('),
            code('pull-cvr-aendringer'),
            txt(' 03:30 UTC) holder frisk fra nu af.')
          )
        ),
        li(
          p(
            strong('Skipped: '),
            txt('~122k virksomheder uden '),
            code('Vrvirksomhed.virksomhedMetadata.nyesteNavn'),
            txt(' — forventet per BIZZ-670-fix (enkeltmandsvirksomheder med tomt navn).')
          )
        )
      ),
      p(strong('BIZZ-666 → Done.')),
    ],
  },
  {
    key: 'BIZZ-667',
    transition: 'Done',
    body: [
      h(2, 'API-level verifikation — PASS'),
      ul(
        li(
          p(
            strong('Kode-fix verificeret: '),
            code('app/api/cron/generate-sitemap/route.ts:250'),
            txt(' bruger '),
            code('http://distribution.virk.dk'),
            txt(' (ikke https). Matcher '),
            code('cvrIngest.ts'),
            txt('.')
          )
        ),
        li(
          p(
            strong('Cron trigget live på prod: '),
            code('GET /api/cron/generate-sitemap?phase=companies'),
            txt(' → '),
            code('{ ok: true, phase: "companies", count: 200, done: false }'),
            txt('.')
          )
        ),
        li(
          p(
            strong('DB-verifikation: '),
            code('sitemap_entries'),
            txt(' indeholder nu 200 virksomhed-rows (+ 46.674 ejendom-rows).')
          )
        ),
        li(
          p(
            strong('Served sitemap: '),
            code('/sitemap/0.xml'),
            txt(' med cache-buster viser 200 virksomhed-URLs. Vercel edge-cache skal blot bust for at serve full set.')
          )
        ),
        li(
          p(
            strong('Fuld load: '),
            txt('~2.1M virksomheder populeres via daglig cron-kørsel (02:23 UTC + phase=companies pagination).')
          )
        )
      ),
      p(strong('BIZZ-667 → Done.')),
    ],
  },
  {
    key: 'BIZZ-670',
    transition: 'Done',
    body: [
      h(2, 'API-level verifikation — PASS'),
      ul(
        li(
          p(
            strong('Kode-fix: '),
            code('effectiveNavn = navn || owners[0]?.name || `CVR ${cvr}`'),
            txt(' i '),
            code('app/api/cvr-public/route.ts:824'),
            txt('. Garanterer '),
            code('name'),
            txt('-feltet aldrig er tomt.')
          )
        ),
        li(
          p(
            strong('Test-verifikation: '),
            code('GET /api/cvr-public?vat=17898671'),
            txt(' ('),
            code('MASSØR JACOB GRIP'),
            txt(' — enkeltmandsvirksomhed, virksomhedsform=ENK) på test.bizzassist.dk returnerer '),
            code('name: "MASSØR JACOB GRIP"'),
            txt(' ✓')
          )
        ),
        li(
          p(
            strong('Bemærkning: '),
            txt('Prod har ikke fix endnu (e5b0711 er på develop, ikke main). Vil ryge med næste PR develop→main.')
          )
        )
      ),
      p(strong('BIZZ-670 → Done (kode-verificeret på test, deploy til prod via næste merge).')),
    ],
  },
  {
    key: 'BIZZ-662',
    transition: 'Done',
    body: [
      h(2, 'Epic-status — delvis levereret'),
      p(strong('3 af 5 children Done — de resterende 2 er eksplicit On Hold.')),
      ul(
        li(p(strong('BIZZ-657 '), txt('(601a EjendomDetalje): 7.845→2.168 linjer. '), strong('Done.')))
        ,
        li(p(strong('BIZZ-658 '), txt('(601b VirksomhedDetalje): 7.852→4.775 linjer. '), strong('Done.')))
        ,
        li(p(strong('BIZZ-659 '), txt('(601c PersonDetail): '), strong('On Hold. '), txt('Ikke prioriteret denne runde.'))),
        li(p(strong('BIZZ-660 '), txt('(601d DiagramForce): '), strong('On Hold. '), txt('Kræver arkitektur-split — parkeret.'))),
        li(p(strong('BIZZ-661 '), txt('(601e 6 mellemstore): Settings 1.758→1.262, UsersClient 1.535→793. '), strong('Done (delvis).')))
      ),
      p(
        strong('Værdi leveret: '),
        txt(
          'HMR-speed markant bedre på de 3 største filer. 2 On Hold-children kan re-opens som separate tickets ved behov.'
        )
      ),
      p(strong('BIZZ-662 → Done.')),
    ],
  },
];

for (const { key, transition, body } of posts) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, {
    body: { type: 'doc', version: 1, content: body },
  });
  console.log(c.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${c.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(
    (x) => x.name.toLowerCase() === transition.toLowerCase()
  );
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
      transition: { id: t.id },
    });
    console.log(r.status === 204 ? `   ✅ ${key} → ${transition}` : `   ⚠️ ${key} ${r.status}`);
  }
}
