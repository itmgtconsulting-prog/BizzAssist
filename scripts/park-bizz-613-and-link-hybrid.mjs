#!/usr/bin/env node
/**
 * Parker BIZZ-613 (EJF Hændelsesbesked) — erstattet af BIZZ-615 hybrid-flow.
 * Tilføjer krydsreference-kommentarer på BIZZ-611/612/615 så tickets læses
 * som én samlet hybrid-arkitektur.
 *
 * Hybrid-flow:
 *   BIZZ-611  Aktivér ingest-ejf-bulk i prod (engangs-deployment)
 *   BIZZ-612  Mode A — Filudtræk til første fulde backfill (engangsoperation)
 *   BIZZ-615  Tinglysning-delta → targeted EJF-lookup (primær daglig delta-kilde)
 *
 * BIZZ-613 Hændelsesbesked parkes — overflødig når Tinglysning-delta dækker ~99%.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ─── ADF helpers ────────────────────────────────────────────────────────────

const para = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const em = (s) => txt(s, [{ type: 'em' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const heading = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });
const codeBlock = (text, lang) => ({
  type: 'codeBlock',
  attrs: lang ? { language: lang } : {},
  content: [{ type: 'text', text }],
});

// ─── 1) Parker BIZZ-613 ────────────────────────────────────────────────────

const parkComment613 = {
  type: 'doc',
  version: 1,
  content: [
    heading(2, 'Parkeret — overflødig i hybrid-arkitekturen'),
    para(
      txt('Efter probe af Tinglysningens '),
      code('/tinglysning/ssl/tinglysningsobjekter/aendringer'),
      txt(' (verificeret live 2026-04-20, se '),
      strong('BIZZ-615'),
      txt(') har vi et simplere delta-spor for EJF-opdateringer der '),
      strong('ikke'),
      txt(' kræver Datafordeler Hændelsesbesked-abonnement:')
    ),
    ul(
      li(para(txt('Tinglysning returnerer ~100 BFE-ændringer/døgn med præcis '), code('AendringsDato'), txt('.'))),
      li(para(txt('For hver ændret BFE kalder vi eksisterende '), code('EJFCustom_EjerskabBegraenset'), txt(' med '), code('where: { bestemtFastEjendomBFENr: { eq: BFE } }'), txt(' og upsert\'er i '), code('ejf_ejerskab'), txt('.'))),
      li(para(txt('Dækker ~99 % af alle ejerskifter. De sidste 1 % (kommune-ændringer, matrikel-opdelinger uden tinglysning) fanges af ugentlig fuld reconciliation via Mode A (BIZZ-612).'))),
    ),
    heading(2, 'Hvorfor parkere i stedet for at køre begge'),
    ul(
      li(para(txt('Undgår en ekstra Datafordeler-service-user + whitelist af '), code('hændelsesbesked.datafordeler.dk'), txt(' på proxy.'))),
      li(para(txt('Undgår duplikerede notifikationer (samme ejerskifte ville fyre event i både Tinglysning og EJF Hændelsesbesked).'))),
      li(para(txt('Mindre vedligehold — én cursor-tabel i stedet for to.'))),
    ),
    heading(2, 'Re-aktivering hvis behov opstår'),
    para(
      txt('Hvis det viser sig at Tinglysning-delta er utilstrækkelig (fx hvis mange ejerskabsændringer sker uden at blive tinglyst med det samme), kan denne ticket reaktiveres. Implementerings-planen i description er stadig gyldig.')
    ),
    heading(2, 'Beslutning'),
    para(
      strong('Parker'),
      txt(' (ikke afvist — planen bevares som reserve). Transition til '),
      em('Won\'t Do / Done'),
      txt(' med label '),
      code('parked-architectural'),
      txt('.')
    ),
  ],
};

// ─── 2) Krydsreference på hybrid-tickets ────────────────────────────────────

const hybridArchNote = {
  type: 'doc',
  version: 1,
  content: [
    heading(2, 'Hybrid-arkitektur (2026-04-20 — ejer-data delta-synk)'),
    para(
      txt('Denne ticket er del af en 3-trins hybrid-arkitektur for at holde '),
      code('public.ejf_ejerskab'),
      txt(' opdateret i produktion. Tickets skal implementeres i rækkefølge:')
    ),
    ul(
      li(
        para(
          strong('BIZZ-611 '),
          txt('(aktivér i prod + monitorering) — deploy cron + Sentry-monitor.')
        )
      ),
      li(
        para(
          strong('BIZZ-612 '),
          txt('(Mode A Filudtræk) — '),
          strong('engangsoperation'),
          txt(' til første fulde backfill; kører derefter kun ugentligt som safety-net.')
        )
      ),
      li(
        para(
          strong('BIZZ-615 '),
          txt('(Tinglysning-delta → targeted EJF-lookup) — '),
          strong('primær daglig delta-kilde'),
          txt(' hver 6. time. ~100 BFE\'er/døgn, ~10 s Vercel-runtime/dag.')
        )
      ),
    ),
    heading(2, 'Hvad der IKKE laves'),
    para(
      txt('BIZZ-613 (EJF Hændelsesbesked) parkes — erstattet af BIZZ-615 hybrid-flow der dækker samme behov uden ekstra Datafordeler-abonnement.')
    ),
    heading(2, 'Latency i steady state'),
    codeBlock(
      `Ejerskifte tinglyst kl. T0
  → Tinglysning API har eventet T0 + ~1 min
  → Vores cron T0 + op til 6 t
  → EJF-sync (Tinglysning → EJF) T0 + 24-48 t
  → Synligt i BizzAssist: T0 + 6-48 t (worst), T0 + 6 t (best)`,
      'text'
    ),
    heading(2, 'Ressourcer i steady state'),
    ul(
      li(para(code('ingest-ejf-bulk'), txt(' (ugentligt Mode A) — ~60 s/uge'))),
      li(para(code('pull-tinglysning-aendringer'), txt(' (hver 6. time) — ~10 s × 4/dag = 40 s/dag'))),
      li(para(txt('Datafordeler: ~100 EJF-GraphQL-queries/dag. Tinglysning: ~20 kald/dag. 0 kr.'))),
      li(para(txt('Supabase: ~100-500 row-upserts/dag.'))),
    ),
  ],
};

// ─── 3) BIZZ-615 supplerende tekniske hints til implementer ─────────────────

const implHints615 = {
  type: 'doc',
  version: 1,
  content: [
    heading(2, 'Til implementeren — eksisterende helpers der bør genbruges'),
    ul(
      li(
        para(
          code('app/lib/tlFetch.ts'),
          txt(' — mTLS-cert-loader + HTTPS-request-helper. Understøtter allerede POST (se '),
          code('tlPost'),
          txt(' eller tilføj hvis kun GET findes). '),
          strong('Brug endpoint-path'),
          txt(' '),
          code('/tinglysning/ssl/tinglysningsobjekter/aendringer'),
          txt(' (ikke '),
          code('/rest/'),
          txt(' som er bruger-login-baseret).')
        )
      ),
      li(
        para(
          code('app/api/cron/pull-bbr-events/route.ts'),
          txt(' — skabelon til cursor-drevet cron: verify-secret + hent cursor + paginér + match mod tracked objects + opdatér cursor. Genbrug samme struktur.')
        )
      ),
      li(
        para(
          code('app/lib/dfTokenCache.ts'),
          txt(' ('),
          code('getSharedOAuthToken'),
          txt(') — til EJF GraphQL-opslag pr. BFE.')
        )
      ),
      li(
        para(
          code('app/api/cron/ingest-ejf-bulk/route.ts'),
          txt(' ('),
          code('mapNodeToRow'),
          txt(' + '),
          code('flushBatch'),
          txt(') — factor denne ud til '),
          code('app/lib/ejfIngest.ts'),
          txt(' så både bulk- og delta-cron deler row-mapping. '),
          strong('Vigtigt'),
          txt(' — ingen duplikeret logik.')
        )
      ),
    ),
    heading(2, 'Endpoint-eksempel (live-verificeret 2026-04-20)'),
    codeBlock(
      `POST https://www.tinglysning.dk/tinglysning/ssl/tinglysningsobjekter/aendringer
Content-Type: application/json
mTLS-cert: ./certs/nemlogin-prod/BizzAssist.p12

Body:
{
  "AendredeTinglysningsobjekterHentType": {
    "bog": "EJENDOM",
    "datoFra": "2026-04-19",
    "datoTil": "2026-04-20",
    "fraSide": 1
  }
}

Response (status 200, 100 items/side):
{
  "AendredeTinglysningsobjekterHentResultat": {
    "AendretTinglysningsobjektSamling": [
      {
        "EjendomIdentifikator": {
          "BestemtFastEjendomNummer": "2057011",
          "Matrikel": [{
            "CadastralDistrictName": "Agershvile, Vedbæk",
            "CadastralDistrictIdentifier": "2006152",
            "Matrikelnummer": "0001eh"
          }]
        },
        "AendringsDato": "2026-04-19T05:00:14.644+02:00"
      },
      … 99 flere
    ],
    "SoegningResultatInterval": {
      "FraNummer": "1",
      "TilNummer": "100",
      "FlereResultater": true   ← paginér via fraSide++
    }
  }
}`,
      'text'
    ),
    heading(2, 'Rækkefølge af implementering'),
    ul(
      li(para(txt('1) Migration '), code('049_tinglysning_aendring_cursor.sql'), txt(' med singleton-cursor-tabel (kopi af '), code('bbr_event_cursor'), txt('-mønster).'))),
      li(para(txt('2) Factor '), code('mapNodeToRow + flushBatch'), txt(' ud fra '), code('ingest-ejf-bulk/route.ts'), txt(' til '), code('app/lib/ejfIngest.ts'), txt('.'))),
      li(para(txt('3) Ny route '), code('app/api/cron/pull-tinglysning-aendringer/route.ts'), txt(' — paginér Tinglysning, for hver BFE kald '), code('fetchEjerskabForBFE(bfe)'), txt(', upsert via '), code('flushBatch'), txt('.'))),
      li(para(txt('4) Tilføj schedule til '), code('vercel.json'), txt(': '), code('"schedule": "0 */6 * * *"'), txt('.'))),
      li(para(txt('5) Skift '), code('ingest-ejf-bulk'), txt(' schedule fra '), code('0 4 * * *'), txt(' til '), code('0 4 * * 0'), txt(' (ugentlig søndag).'))),
      li(para(txt('6) Unit tests: mock Tinglysning-respons, verificér at BFE\'er upsert\'es korrekt i '), code('ejf_ejerskab'), txt('.'))),
      li(para(txt('7) E2E: manuel trigger mod test.bizzassist.dk, verificér '), code('tinglysning_aendring_cursor.last_event_at'), txt(' rykkes.'))),
    ),
    heading(2, 'Acceptance — BIZZ-611 dependency'),
    para(
      txt('Kan ikke deployes før BIZZ-611 (prod-aktivering) er kørt + BIZZ-612 (første fuld backfill). Ellers laver delta-cron\'en EJF-opslag mod en tom '),
      code('ejf_ejerskab'),
      txt('-tabel og glemmer de ikke-ændrede 99 % af data.')
    ),
  ],
};

// ─── Run ────────────────────────────────────────────────────────────────────

// 1. Post park-comment på BIZZ-613
{
  const res = await req('POST', '/rest/api/3/issue/BIZZ-613/comment', { body: parkComment613 });
  if (res.status === 201) console.log('✅ BIZZ-613 parked comment posted');
  else console.log(`❌ BIZZ-613 comment failed (${res.status}):`, res.body.slice(0, 300));
}

// 2. Transition BIZZ-613 til Done (= parkeret/implementeres ikke)
{
  const tr = await req('GET', '/rest/api/3/issue/BIZZ-613/transitions');
  const transitions = JSON.parse(tr.body).transitions ?? [];
  // Vælg "Won't Do" hvis findes, ellers Done
  const target =
    transitions.find((t) => /won.?t\s*do/i.test(t.name)) ??
    transitions.find((t) => /^done$/i.test(t.name));
  if (target) {
    const r = await req('POST', '/rest/api/3/issue/BIZZ-613/transitions', {
      transition: { id: target.id },
    });
    if (r.status === 204) console.log(`✅ BIZZ-613 → ${target.name}`);
    else console.log(`⚠️  BIZZ-613 transition failed (${r.status}):`, r.body.slice(0, 300));
  } else {
    console.log('⚠️  No Done/Won\'t Do transition found for BIZZ-613');
    console.log('    Available:', transitions.map((t) => `${t.id}:${t.name}`).join(', '));
  }
}

// 3. Post hybrid-arch note på BIZZ-611 og BIZZ-612
for (const key of ['BIZZ-611', 'BIZZ-612']) {
  const res = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: hybridArchNote });
  if (res.status === 201) console.log(`✅ ${key} hybrid-arch note posted`);
  else console.log(`❌ ${key} comment failed (${res.status}):`, res.body.slice(0, 300));
}

// 4. Post impl-hints på BIZZ-615
{
  const res = await req('POST', '/rest/api/3/issue/BIZZ-615/comment', { body: implHints615 });
  if (res.status === 201) console.log('✅ BIZZ-615 impl-hints posted');
  else console.log(`❌ BIZZ-615 comment failed (${res.status}):`, res.body.slice(0, 300));
}

// 5. Link tickets: BIZZ-615 blocks-by BIZZ-611, BIZZ-612
for (const { outward, inward, type } of [
  { outward: 'BIZZ-615', inward: 'BIZZ-611', type: 'Blocks' },
  { outward: 'BIZZ-615', inward: 'BIZZ-612', type: 'Blocks' },
]) {
  const res = await req('POST', '/rest/api/3/issueLink', {
    type: { name: type },
    inwardIssue: { key: inward },
    outwardIssue: { key: outward },
  });
  if (res.status === 201) console.log(`✅ Linked: ${inward} ${type} ${outward}`);
  else console.log(`⚠️  Link ${inward}→${outward} failed (${res.status}):`, res.body.slice(0, 300));
}

console.log('\nDone. Ticket-oversigt:');
console.log('  https://bizzassist.atlassian.net/browse/BIZZ-611  — Aktivér prod + monitorering');
console.log('  https://bizzassist.atlassian.net/browse/BIZZ-612  — Mode A Filudtræk (engangs-backfill)');
console.log('  https://bizzassist.atlassian.net/browse/BIZZ-613  — [parked] Hændelsesbesked');
console.log('  https://bizzassist.atlassian.net/browse/BIZZ-615  — Tinglysning-delta → targeted EJF (daglig)');
