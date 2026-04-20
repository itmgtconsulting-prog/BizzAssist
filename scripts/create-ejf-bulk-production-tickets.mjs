#!/usr/bin/env node
/**
 * Opretter 4 JIRA-tickets omkring produktions-aktivering af EJF bulk-ingest
 * + incremental opdateringer (Hændelsesbesked / Delta-udtræk / Tinglysning).
 *
 *   1. Aktivér ingest-ejf-bulk i produktion + monitorering + backfill-verifikation
 *   2. Konfigurér EJF Filudtræk (Mode A) — EJF_BULK_DUMP_URL — så fuld kørsel
 *      færdiggøres i én Vercel-invocation
 *   3. Incremental EJF-synk via Datafordeler Hændelsesbesked (register=EJF)
 *   4. Evaluér Tinglysning event-feed for incremental synk af tinglysnings-data
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';
const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

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
const table = (rows) => ({
  type: 'table',
  attrs: { isNumberColumnEnabled: false, layout: 'default' },
  content: rows.map((cells, rowIdx) => ({
    type: 'tableRow',
    content: cells.map((cell) => ({
      type: rowIdx === 0 ? 'tableHeader' : 'tableCell',
      content: [typeof cell === 'string' ? para(txt(cell)) : cell],
    })),
  })),
});

// ─── Ticket 1: Aktivér i produktion + monitorering ─────────────────────────

const t1 = {
  summary:
    'EJF bulk-ingest: aktivér i produktion, verificér første backfill, og tilføj monitorering',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Mål'),
      para(
        txt('Tag '),
        code('/api/cron/ingest-ejf-bulk'),
        txt(' (BIZZ-534, deployet til test 2026-04-19) i produktion så '),
        code('public.ejf_ejerskab'),
        txt(' holdes opdateret — minimum ugentligt, helst dagligt. Implementér monitorering så vi opdager udeblevne eller ufuldstændige kørsler.')
      ),
      heading(2, 'Kontekst'),
      para(
        txt('Cron er allerede konfigureret i '),
        code('vercel.json'),
        txt(' ('),
        code('0 4 * * *'),
        txt(' = dagligt 04:00 UTC), men det er kun aktivt når branchen bliver mergesat til main + deployet til produktions-Vercel-projekt. Migration '),
        code('046_ejf_ejerskab_bulk.sql'),
        txt(' skal være kørt på prod-Supabase.')
      ),
      heading(2, 'Ressource-budget (skal bekræftes efter første kørsel)'),
      table([
        ['Ressource', 'Estimat', 'Grænseværdi'],
        ['EJF GraphQL-opslag', '~6–12 M nodes (én fuld gennemgang)', 'Gratis m. grant — 0 kr.'],
        ['Vercel function-runtime', '~300 s × 30 d ≈ 2,5 t/md', 'Pro-plan: 100 t/md included'],
        ['Supabase storage (ejf_ejerskab + index)', '~3–5 GB', 'Pro-plan: 8 GB included'],
        ['Supabase DB-CPU (upsert-spike)', '~4-5 min kl. 04 UTC', 'Risiko: evt. CPU-throttling i spike'],
        ['Mode B cold-start', '~30 dages daglig kørsel før fuld backfill', 'Blocker — Mode A nødvendig (se søster-ticket)'],
      ]),
      heading(2, 'Tasks'),
      ul(
        li(
          para(
            txt('Merge '),
            code('develop → main'),
            txt(' og verificér at '),
            code('vercel.json')
            ,
            txt(' crons-blok er aktiv i prod-deployment (Vercel UI → Settings → Cron Jobs).')
          )
        ),
        li(
          para(
            txt('Kør migration '),
            code('046_ejf_ejerskab_bulk.sql'),
            txt(' mod prod-Supabase (om ikke allerede gjort via migration-pipeline).')
          )
        ),
        li(
          para(
            txt('Verificér at '),
            code('CRON_SECRET'),
            txt(', '),
            code('DATAFORDELER_OAUTH_CLIENT_ID/_SECRET'),
            txt(' (evt. cert-fallback), og '),
            code('SUPABASE_SERVICE_ROLE_KEY'),
            txt(' er sat i Vercel production env.')
          )
        ),
        li(
          para(
            txt('Manuel trigger første kørsel (fra Vercel UI eller curl): '),
            code('curl -H "Authorization: Bearer $CRON_SECRET" -H "x-vercel-cron: 1" https://bizzassist.dk/api/cron/ingest-ejf-bulk'),
            txt('. Observer første run-row i '),
            code('public.ejf_ingest_runs'),
            txt(' og noter '),
            code('rows_processed / rows_inserted / error'),
            txt('.')
          )
        ),
        li(
          para(
            txt('Tilføj monitorering: Sentry cron-monitor på '),
            code('/api/cron/ingest-ejf-bulk'),
            txt(' + alert hvis '),
            code('ejf_ingest_runs.finished_at IS NULL'),
            txt(' efter 24 t, eller hvis '),
            code('rows_processed < 100'),
            txt(' (sandsynlig fejl).')
          )
        ),
        li(
          para(
            txt('Opdatér '),
            code('docs/BACKLOG.md'),
            txt(' + '),
            code('docs/agents/TEAM.md'),
            txt(' med real-target tal efter første fulde backfill.')
          )
        ),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('Cron kører i prod hver nat kl. 04:00 UTC; synligt i Vercel cron-logs.'))),
        li(para(txt('Første fulde backfill afsluttet (alle BFE\'er i Danmark har mindst ét ejer-row).'))),
        li(para(txt('Sentry cron-monitor alerter inden for 6 t hvis kørslen fejler eller udebliver.'))),
        li(para(txt('Ressourcebudget ovenfor verificeret og dokumenteret efter første uge.'))),
      ),
      heading(2, 'Depends on'),
      ul(
        li(para(strong('Søster-ticket (Mode A)'), txt(' — uden EJF_BULK_DUMP_URL tager backfill ~30 dage i Mode B.'))),
      ),
    ],
  },
};

// ─── Ticket 2: Mode A konfiguration ─────────────────────────────────────────

const t2 = {
  summary: 'EJF bulk-ingest Mode A: konfigurér EJF_BULK_DUMP_URL (Filudtræk) så backfill færdig i én kørsel',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Problem'),
      para(
        txt('Når '),
        code('EJF_BULK_DUMP_URL'),
        txt(' er '),
        strong('ikke sat'),
        txt(', falder cron tilbage til Mode B (GraphQL-pagination). Mode B har '),
        code('MAX_PAGES_PER_RUN=200'),
        txt(' × '),
        code('GQL_PAGE_SIZE=1000'),
        txt(' = 200.000 rækker/run, og hele EJF er ~6–12 M ejerskaber. Dvs. første fulde backfill tager 30+ daglige kørsler, før datasættet er komplet. Det overholder ikke "min 1 uge catchup"-kravet.')
      ),
      heading(2, 'Løsning: Mode A — Filudtræk'),
      para(
        txt('Datafordeler udstiller EJF som offentlig "Totaludtræk Flad Prædefineret JSON" — gzip\'et JSONL som streames direkte ind i '),
        code('ingestFromBulkFile()'),
        txt(' i cron-routen. Én kørsel processer hele dumpen (typisk 2–4 GB gzip).')
      ),
      heading(2, 'Tasks'),
      ul(
        li(
          para(
            txt('Log ind på '),
            code('selvbetjening.datafordeler.dk'),
            txt(' og hent URL til "EJF Totaludtræk Flad Prædefineret JSON" for vores bruger.')
          )
        ),
        li(
          para(
            txt('Whitelist '),
            code('dataudtraek.datafordeler.dk'),
            txt(' + '),
            code('selvbetjening.datafordeler.dk'),
            txt(' på Hetzner-proxy (pt. kun '),
            code('services.datafordeler.dk'),
            txt(' / '),
            code('graphql.datafordeler.dk'),
            txt(' er åbnet).')
          )
        ),
        li(
          para(
            txt('Sæt '),
            code('EJF_BULK_DUMP_URL'),
            txt(' i Vercel production env.')
          )
        ),
        li(
          para(
            txt('Verificér at dumpen er '),
            strong('NDJSON'),
            txt(' (én record per linje). Hvis det er single JSON array, skal '),
            code('ingestFromBulkFile()'),
            txt(' udvides med streaming JSON-parser ('),
            code('stream-json'),
            txt(' / '),
            code('JSONStream'),
            txt(') for at undgå OOM.')
          )
        ),
        li(
          para(
            txt('Verificér at JSON-feltnavne matcher '),
            code('RawEjfNode'),
            txt('-interfacet i '),
            code('app/api/cron/ingest-ejf-bulk/route.ts'),
            txt(' (særligt '),
            code('ejendePersonBegraenset.id/navn/foedselsdato'),
            txt(' og '),
            code('ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref.CVRNummer'),
            txt(') — tilpas '),
            code('mapNodeToRow()'),
            txt(' hvis filformatet afviger fra GraphQL-shape.')
          )
        ),
        li(
          para(
            txt('Test mod '),
            strong('test.bizzassist.dk'),
            txt(' først: manuel trigger, observer at '),
            code('rows_processed'),
            txt(' > 1 M efter én kørsel og ingen cursor-resume.')
          )
        ),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('Én Vercel-invocation (≤ 300 s) processer hele EJF-dumpen.'))),
        li(para(code('ejf_ingest_runs.error'), txt(' = null og '), code('finished_at'), txt(' udfyldt.'))),
        li(para(txt('Datamæssig paritet med Mode B: samme ejere/ejendomme repræsenteret, ingen systematiske mapping-tab.'))),
      ),
      heading(2, 'Relaterer'),
      ul(
        li(para(txt('BIZZ-534 (grundlæggende bulk-ingest ticket).'))),
        li(
          para(
            txt('Memory '),
            code('reference_datafordeler_ejf.md'),
            txt(' — Filudtræk-spor dokumenteret.')
          )
        ),
      ),
    ],
  },
};

// ─── Ticket 3: Hændelsesbesked / Incremental EJF ───────────────────────────

const t3 = {
  summary: 'Incremental EJF-synk via Datafordeler Hændelsesbesked (register=EJF) — erstat dagligt fuld bulk-ingest med delta',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Mål'),
      para(
        txt('Når første fulde backfill (BIZZ-534 + søster-tickets) er på plads, skal den daglige "fuld gennemgang" erstattes med '),
        strong('delta-synk'),
        txt(' baseret på Datafordelers Hændelsesbesked API (samme mønster som '),
        code('/api/cron/pull-bbr-events'),
        txt(' bruger til BBR i dag). Det reducerer Vercel-runtime fra 300 s/dag til sekunder og fjerner DB-CPU-spike kl. 04 UTC.')
      ),
      heading(2, 'Baggrund'),
      para(
        txt('Datafordeler Hændelsesbesked ('),
        code('https://hændelsesbesked.datafordeler.dk/api/v1/hændelse'),
        txt(') udstiller event-stream pr. register: '),
        code('BBR'),
        txt(', '),
        code('EJF'),
        txt(', '),
        code('MAT'),
        txt(', '),
        code('CVR'),
        txt(', m.fl. API returnerer events siden et '),
        code('datefrom'),
        txt('-cursor — dvs. kun ændringer.')
      ),
      para(
        em('NB: '),
        txt('Hændelsesbesked kræver Basic Auth med '),
        code('DATAFORDELER_USER'),
        txt(' / '),
        code('DATAFORDELER_PASS'),
        txt(' (ikke OAuth/apikey). Disse credentials er pt. '),
        strong('ikke'),
        txt(' i '),
        code('.env.local'),
        txt(' — skal oprettes som selvstændig tjenestebruger på '),
        code('selvbetjening.datafordeler.dk'),
        txt(' og whitelistes til både BBR- og EJF-registre.')
      ),
      heading(2, 'Design'),
      para(txt('Ny cron: '), code('/api/cron/pull-ejf-events'), txt(' — hver 6. time (samme cadence som pull-bbr-events):')),
      ul(
        li(para(txt('Hent '), code('last_event_at'), txt(' fra ny tabel '), code('public.ejf_event_cursor'), txt('.'))),
        li(
          para(
            txt('Kald '),
            code('GET /api/v1/hændelse?register=EJF&datefrom=<cursor>&pagesize=100'),
            txt(' — paginér op til fx 2000 events/run.')
          )
        ),
        li(
          para(
            txt('For hver event, slå op i '),
            code('EJFCustom_EjerskabBegraenset'),
            txt(' på '),
            code('bestemtFastEjendomBFENr'),
            txt(' eller '),
            code('id_lokalId'),
            txt(' og upsert rækken i '),
            code('ejf_ejerskab'),
            txt('.')
          )
        ),
        li(para(txt('Opdatér cursor til seneste '), code('registreringstidspunkt'), txt('.'))),
        li(
          para(
            txt('Stadig behold '),
            code('/api/cron/ingest-ejf-bulk'),
            txt(' — men skift schedule til '),
            code('0 4 * * 0'),
            txt(' (ugentlig fuld reconciliation) i stedet for daglig.')
          )
        ),
      ),
      heading(2, 'Tasks'),
      ul(
        li(para(txt('Opret tjenestebruger på Datafordeler selvbetjening med adgang til EJF Hændelsesbesked. Sæt '), code('DATAFORDELER_USER/_PASS'), txt(' i Vercel env.'))),
        li(para(txt('Probe: '), code('curl -u $U:$P "https://hændelsesbesked.datafordeler.dk/api/v1/hændelse?register=EJF&datefrom=$YESTERDAY&pagesize=5"'), txt(' — verificér 200 + data-array.'))),
        li(para(txt('Ny migration: '), code('public.ejf_event_cursor'), txt(' (samme mønster som '), code('bbr_event_cursor'), txt(').'))),
        li(para(txt('Implementér '), code('app/api/cron/pull-ejf-events/route.ts'), txt(' ved at kopiere og tilpasse '), code('pull-bbr-events/route.ts'), txt('.'))),
        li(para(txt('Tilføj schedule i '), code('vercel.json'), txt(': '), code('0 */6 * * *'), txt(' = hver 6. time.'))),
        li(para(txt('Skift bulk-ingest schedule til ugentlig søndag 04:00 UTC ('), code('0 4 * * 0'), txt(') som safety-net.'))),
        li(para(txt('Monitorering: alert hvis '), code('ejf_event_cursor.last_event_at'), txt(' ikke er rykket inden for 12 t.'))),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('Daglig Vercel-runtime for EJF-synk falder fra ~300 s til < 60 s.'))),
        li(para(txt('En ejerskabsændring tinglyst samme dag er synlig i '), code('ejf_ejerskab'), txt(' inden 12 t.'))),
        li(para(txt('Ugentlig fuld reconciliation fanger evt. drift (fx events forsinket i Hændelsesbesked).'))),
        li(para(txt('Intet datatab ved overgang: '), code('rows_processed'), txt(' i begge cron-typer matcher ved sammenligning.'))),
      ),
      heading(2, 'Relaterer'),
      ul(
        li(para(txt('BIZZ-534, BIZZ-489 (pull-bbr-events-mønster allerede etableret).'))),
      ),
    ],
  },
};

// ─── Ticket 4: Tinglysning event-feed evaluation ────────────────────────────

const t4 = {
  summary: 'Tinglysning: evaluér e-TL event-feed / hændelser til incremental synk (undersøgelses-ticket)',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Mål'),
      para(
        txt('Vurdér om Tinglysningsrettens e-TL tilbyder en event-feed (Hændelser, ændringsstream, polling-endpoint) der kan bruges til incremental synk af tinglysningsdata — analogt til Datafordeler Hændelsesbesked for EJF/BBR.')
      ),
      heading(2, 'Baggrund'),
      para(
        txt('I dag kalder vi e-TL "live" pr. BFE/CVR-opslag via mTLS ('),
        code('app/api/tinglysning/*/route.ts'),
        txt('). Ingen aggregerings-tabel findes. Hvis e-TL har et ændrings-API, kan vi bygge en '),
        code('tinglysning_events'),
        txt('-tabel og pre-materialize seneste tinglysnings-status pr. ejendom — fjerner latency fra property detail page og muliggør "seneste tinglysninger"-feed.')
      ),
      heading(2, 'Undersøgelsespunkter'),
      ul(
        li(
          para(
            txt('Læs '),
            code('docs/tinglysning/system-systemmanual-v1.53.txt'),
            txt(' og '),
            code('docs/tinglysning/http-api-beskrivelse-v1.12.txt'),
            txt(' for ord som "hændelse", "event", "delta", "ændring", "notifikation", "polling".')
          )
        ),
        li(para(txt('Tjek e-TL selvbetjeningsportalen for event-stream-abonnement.'))),
        li(para(txt('Skriv til Tinglysningsrettens tekniske support hvis det ikke fremgår af dokumentationen.'))),
        li(para(txt('Vurdér: dækning (events vs. polling vs. delta-udtræk), latency (hvor hurtigt dukker nyligt tinglyste dokumenter op?), pris (abonnement-tier, trafikgebyr), format (XML/JSON/SOAP — kompatibelt med eksisterende parser?).'))),
      ),
      heading(2, 'Leverancer'),
      ul(
        li(
          para(
            txt('Kort analyse-dokument i '),
            code('docs/adr/'),
            txt(' med fund + anbefaling (gå-videre / parker / afvis).')
          )
        ),
        li(
          para(
            txt('Hvis anbefaling er "gå-videre": opret implementerings-ticket med estimat og skema-forslag.')
          )
        ),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('ADR skrevet og committet.'))),
        li(para(txt('Beslutning dokumenteret: implementér / parker / afvis.'))),
        li(para(txt('Hvis "implementér" → follow-up ticket oprettet med teknisk plan.'))),
      ),
    ],
  },
};

// ─── Kør ────────────────────────────────────────────────────────────────────

const meta = await req(
  'GET',
  `/rest/api/3/issue/createmeta?projectKeys=${PROJECT}&expand=projects.issuetypes`
);
const types = JSON.parse(meta.body).projects?.[0]?.issuetypes ?? [];
const issueType =
  types.find((t) => /^task$/i.test(t.name)) ??
  types.find((t) => /^story$/i.test(t.name)) ??
  types.find((t) => !t.subtask);

for (const tk of [t1, t2, t3, t4]) {
  const res = await req('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: PROJECT },
      summary: tk.summary,
      description: tk.description,
      issuetype: { id: issueType.id },
      priority: { name: tk === t1 || tk === t2 ? 'High' : 'Medium' },
    },
  });
  if (res.status === 201) {
    const key = JSON.parse(res.body).key;
    console.log(`✅ ${key}  —  ${tk.summary}`);
    console.log(`   https://${HOST}/browse/${key}`);
  } else {
    console.log(`❌ FAILED (${res.status}) "${tk.summary}":`, res.body.slice(0, 400));
  }
}
