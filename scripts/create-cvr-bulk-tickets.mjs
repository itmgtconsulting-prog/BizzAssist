#!/usr/bin/env node
/**
 * Opret 2 linked JIRA-tickets for CVR bulk-ingestion (delta-sync pattern).
 * Matcher BIZZ-534 (EJF-bulk) + BIZZ-650 (Tinglysning delta) mønsteret.
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

// ─── Ticket 1: Infrastructure ────────────────────────────────────────────
const ticket1 = {
  fields: {
    project: { key: 'BIZZ' },
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    summary: 'CVR bulk-ingestion — lokal cvr_virksomhed-tabel + daglig delta-sync via sidstOpdateret',
    labels: ['backend', 'cron', 'delta-sync', 'cvr', 'ingestion'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          txt(
            'BizzAssist slår i dag CVR-virksomheder op live mod Erhvervsstyrelsens Elasticsearch-API hver gang en bruger åbner en virksomhedsside. Det giver unødig latency (300-600ms per opslag) og gør os afhængige af 3. parts uptime. EJF-ejendomsdata (BIZZ-534) + Tinglysning-delta (BIZZ-650) har allerede etableret pattern for lokal bulk-cache + daglig delta-opdatering — samme tilgang er direkte anvendelig på CVR.'
          )
        ),
        p(
          strong('Delta-nøglen: '),
          code('sidstOpdateret'),
          txt(' — hvert CVR-record på Erhvervsstyrelsens Elasticsearch-indeks har '),
          code('Vrvirksomhed.sidstOpdateret'),
          txt(' og '),
          code('Vrvirksomhed.sidstIndlaest'),
          txt(' som range-filterbare datoer. Bekræftet i '),
          code('docs/cvr/cvr-indeks_data_katalog.docx'),
          txt('.')
        ),
        h(2, 'Design — matcher BIZZ-650 mønsteret'),
        p(
          strong('Rullende 5-dages vindue dagligt.'),
          txt(
            ' Hver cron-run henter virksomheder med sidstOpdateret >= (now-5d). 5-dages overlap betyder 1-4 dages cron-fejl fanger automatisk op på næste successfulde run. Idempotent upsert på composite PK (cvr, samtId) sikrer ingen duplikater.'
          )
        ),
        p(
          code(
            'POST /cvr-permanent/virksomhed/_search\n{ "query": { "range": { "Vrvirksomhed.sidstOpdateret": { "gte": "<fromDate>" } } }, "size": 1000, "sort": [{"Vrvirksomhed.sidstOpdateret":"asc"}] }'
          )
        ),
        p(
          txt('Pagination via '),
          code('search_after'),
          txt(' (stabil under indeksændringer) eller '),
          code('_scroll'),
          txt(' (hvis Erhvervsstyrelsen kræver det).')
        ),
        h(2, 'Leverancer'),
        ul(
          li(
            p(
              strong('Migration: '),
              code('054_cvr_virksomhed_bulk.sql'),
              txt(' — hovedtabel '),
              code(
                'cvr_virksomhed(cvr PK, samtId, navn, status, branche_kode, branche_tekst, virksomhedsform, stiftet, ophoert, ansatte_aar, ansatte_kvartal_1/2/3/4, adresse_json, sidst_opdateret, sidst_indlaest, sidst_hentet_fra_cvr)'
              ),
              txt('. Indekser: B-tree på '),
              code('(status, sidst_opdateret)'),
              txt(' + GIN på '),
              code('navn'),
              txt(' til fuzzy søgning.')
            )
          ),
          li(
            p(
              strong('Migration: '),
              code('055_cvr_deltager_bulk.sql'),
              txt(' — '),
              code(
                'cvr_deltager(enhedsNummer PK, navn, adresse_json, roller_json, sidst_opdateret)'
              ),
              txt(' + '),
              code(
                'cvr_deltagerrelation(virksomhed_cvr, deltager_enhedsNummer, type, gyldig_fra, gyldig_til, sidst_opdateret)'
              ),
              txt(' for ejerlag + ledelse.')
            )
          ),
          li(
            p(
              strong('Migration: '),
              code('056_cvr_aendring_cursor.sql'),
              txt(' — singleton cursor-tabel (samme mønster som '),
              code('tinglysning_aendring_cursor'),
              txt(').')
            )
          ),
          li(
            p(
              strong('Helper-lib: '),
              code('app/lib/cvrIngest.ts'),
              txt(
                ' — eksporterer esQuery, fetchAendretSiden, mapCvrToRow, upsertCvrBatch, getEsAuthHeader.'
              )
            )
          ),
          li(
            p(
              strong('Initial backfill script: '),
              code('scripts/backfill-cvr-bulk.mjs'),
              txt(
                ' — 1-gang-kørsel der scanner alle aktive virksomheder via sidstIndlaest-pagination. Forventet volumen: ~1.5M aktive + ~3M historiske virksomheder. Kopieres '
              ),
              code('test → prod'),
              txt(' via \\COPY når test er verificeret — samme workflow som BIZZ-534 EJF-backfill.')
            )
          ),
          li(
            p(
              strong('Delta-cron: '),
              code('app/api/cron/pull-cvr-aendringer/route.ts'),
              txt(
                ' — wrappet i withCronMonitor. Henter virksomheder + deltagere + relationer med sidstOpdateret i 5-dages vindue, upsert batches à 500.'
              )
            )
          ),
          li(
            p(
              strong('vercel.json: '),
              code('{ "path": "/api/cron/pull-cvr-aendringer", "schedule": "30 3 * * *" }'),
              txt(
                ' — 03:30 UTC, 15 min efter Tinglysning-delta så crons ikke kolliderer.'
              )
            )
          ),
          li(
            p(
              strong('cron-status dashboard: '),
              code("CRONS[]"),
              txt(' entry med jobName='),
              code("pull-cvr-aendringer"),
              txt(', intervalMinutes=24*60.')
            )
          ),
          li(
            p(
              strong('Unit-tests: '),
              txt(
                'mock Erhvervsstyrelsen ES-response. Verify 5-day window, search_after pagination, dedupe, idempotent upsert, error-paths.'
              )
            )
          ),
          li(
            p(
              strong('Monitoring-alert: '),
              code('checkCvrIngestHealth()'),
              txt(
                ' — alert hvis cursor.last_run_at er > 24t gammel, samme mønster som checkEjfIngestHealthAndCreateScans.'
              )
            )
          )
        ),
        h(2, 'Volumen-estimat'),
        ul(
          li(p(strong('Aktive virksomheder: '), txt('~1.5M i DK.'))),
          li(
            p(
              strong('Daglige ændringer: '),
              txt('10-50k virksomheder (baseret på Erhvervsstyrelsens offentlige statistik). 5-dages vindue = ~50-250k virksomheder per run.')
            )
          ),
          li(
            p(
              strong('Runtime: '),
              txt('~300ms per ES-batch × 500 per batch = estimeret 2-5 min per run ved 50k ændrede. Vercel maxDuration=300 giver margin.')
            )
          ),
          li(p(strong('Supabase storage: '), txt('~3-5 GB for virksomheder + deltagere.')))
        ),
        h(2, 'Acceptance criteria'),
        ul(
          li(
            p(
              code('/api/cron/pull-cvr-aendringer'),
              txt(' kan trigges manuelt med CRON_SECRET og returnerer '),
              code('{ ok: true, virksomhederProcessed, rowsUpserted }'),
              txt('.')
            )
          ),
          li(
            p(
              code('cvr_virksomhed.max(sidst_hentet_fra_cvr)'),
              txt(' på prod er < 48t gammel efter 1-2 cron-kørsler.')
            )
          ),
          li(p(txt('Cron-failure-alert udløses hvis '), code('cursor.last_run_at'), txt(' > 24t.'))),
          li(p(txt('Unit-tests ≥ 80% branch coverage på cvrIngest.ts.'))),
          li(
            p(
              txt('Initial backfill kørt på test først, derefter test→prod \\COPY — som BIZZ-534.')
            )
          )
        ),
        h(2, 'Afhængigheder'),
        ul(
          li(
            p(
              code('CVR_ES_USER'),
              txt(' + '),
              code('CVR_ES_PASS'),
              txt(' i Vercel env (alle targets: production, preview, development).')
            )
          ),
          li(
            p(
              txt('Schema-reference: '),
              code('docs/cvr/cvr-indeks_data_katalog.docx'),
              txt(' + '),
              code('docs/cvr/soegeeksempler_permanent_v6.pdf'),
              txt('.')
            )
          )
        ),
        h(2, 'Follow-up'),
        p(
          txt('Separat ticket (linket: “Runtime swap”) dækker swap af '),
          code('/api/cvr-public/*'),
          txt(
            ' til at læse fra denne lokale cache med fallback til live ES. Separer så vi kan deploy'
          ),
          txt('e bulk-infra uafhængigt af UI-facing changes.')
        ),
      ],
    },
  },
};

// ─── Ticket 2: Runtime swap ──────────────────────────────────────────────
const ticket2 = {
  fields: {
    project: { key: 'BIZZ' },
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    summary: 'CVR runtime swap — /api/cvr-public/* læser lokal cache først, falder tilbage til live ES',
    labels: ['backend', 'cvr', 'performance', 'cache'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Kontekst'),
        p(
          txt(
            'Når CVR-bulk-infrastrukturen er etableret (se linked ticket), skal runtime-endpoints skifte til at læse fra lokal '
          ),
          code('cvr_virksomhed'),
          txt('-tabel frem for live-ES. Skal gøres som en separat deploy så bulk-pipelinen kan verificeres isoleret.')
        ),
        h(2, 'Scope'),
        ul(
          li(p(code('/api/cvr-public/route.ts'), txt(' — hovedvirksomhedsopslag på CVR.'))),
          li(
            p(
              code('/api/cvr-public/person/route.ts'),
              txt(' — person via enhedsNummer (genbruger cvr_deltager).')
            )
          ),
          li(
            p(
              code('/api/cvr-public/related/route.ts'),
              txt(' — relaterede virksomheder/deltagere (genbruger cvr_deltagerrelation).')
            )
          )
        ),
        h(2, 'Adfærd'),
        ul(
          li(
            p(
              strong('Primær kilde: '),
              txt('Supabase cache hvis '),
              code('sidst_hentet_fra_cvr'),
              txt(' < 7 dage.')
            )
          ),
          li(
            p(
              strong('Fallback: '),
              txt('Live Erhvervsstyrelsens ES hvis cache er stale eller mangler (fx nyregistreret firma).')
            )
          ),
          li(
            p(
              strong('Writeback: '),
              txt('Når fallback til live sker, upsert resultatet til '),
              code('cvr_virksomhed'),
              txt(' inline, så næste opslag rammer cachen.')
            )
          ),
          li(
            p(
              strong('Response-header: '),
              code('x-cvr-source: cache | live'),
              txt(' til debug + Sentry-metrics.')
            )
          )
        ),
        h(2, 'Acceptance criteria'),
        ul(
          li(
            p(
              txt(
                'P50 virksomhedsside-load tid falder målbart (logges i Sentry performance) — fra ~500ms til <50ms for cached hits.'
              )
            )
          ),
          li(
            p(
              txt(
                'Cache-hit rate > 95% efter 48 timers opvarmning (måles via x-cvr-source-header).'
              )
            )
          ),
          li(
            p(
              txt(
                'Fallback-writeback dokumenteret — nye virksomheder hentet live ender i cachen automatisk.'
              )
            )
          ),
          li(p(txt('Ingen ændring i response-shape udadtil — eksisterende UI-kontrakter holdes.')))
        ),
        h(2, 'Afhængighed'),
        p(
          txt(
            'Blokeret af forgængeren (infrastruktur-ticket). Den ticket skal være Done + deployed på prod før denne startes.'
          )
        ),
      ],
    },
  },
};

async function create(ticket) {
  const r = await req('POST', '/rest/api/3/issue', ticket);
  if (r.status !== 201) {
    console.error('FAIL:', r.status, r.body.slice(0, 500));
    return null;
  }
  const j = JSON.parse(r.body);
  console.log('✅ created', j.key, '-', ticket.fields.summary.slice(0, 70));
  return j.key;
}

const key1 = await create(ticket1);
const key2 = await create(ticket2);

// Link ticket 2 som blocked-by ticket 1
if (key1 && key2) {
  const linkR = await req('POST', '/rest/api/3/issueLink', {
    type: { name: 'Blocks' },
    inwardIssue: { key: key2 },
    outwardIssue: { key: key1 },
  });
  console.log(linkR.status === 201 ? `🔗 ${key1} blocks ${key2}` : `link-warn: ${linkR.status}`);
}
