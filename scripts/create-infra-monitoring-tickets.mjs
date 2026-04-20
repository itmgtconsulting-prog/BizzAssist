#!/usr/bin/env node
/**
 * Opretter 5 JIRA-tickets til at lukke hullerne i infrastruktur-overvågning
 * og cron-status-visning, så Service Manager kan handle på fejl automatisk.
 *
 *   1. Cron Status Dashboard + wire recordHeartbeat() til alle 11 remaining crons
 *   2. Fix broken health checks (Stripe, Datafordeleren) + live-probe for de 4 "static" komponenter
 *   3. Auto-route infra/cron-fejl til Service Manager agent (auto-resolution trigger)
 *   4. Sentry cron-monitor integration (backup-observability)
 *   5. Unified Operations Dashboard — konsolidér service-management + service-manager + cron-status
 *
 * Baggrund: BIZZ-304, BIZZ-305, BIZZ-306 fra go-live-readiness er Done, men
 * efter-rul til alle crons er ikke gennemført — kun /api/cron/service-scan
 * bruger cron_heartbeats-tabellen, og infra-monitorering rammer kun 6 ud af 10
 * komponenter med reel live-probe.
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
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';

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

// ─── Ticket 1: Cron Status Dashboard + heartbeats rollout ────────────────────

const t1 = {
  priority: 'High',
  summary: 'Ops: Cron Status Dashboard + wire recordHeartbeat() til alle 11 resterende crons',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Problem'),
      para(
        txt('Tabellen '),
        code('public.cron_heartbeats'),
        txt(' eksisterer (migration '),
        code('041_cron_heartbeats.sql'),
        txt(', oprettet under BIZZ-305) og har schema til '),
        code('job_name, last_run_at, last_status, last_duration_ms, expected_interval_minutes, last_error'),
        txt('. Men kun '),
        strong('1 ud af 12'),
        txt(' crons kalder '),
        code('recordHeartbeat()'),
        txt(' i dag (service-scan ved '),
        code('app/api/cron/service-scan/route.ts:905'),
        txt('). De andre 11 crons er blinde — ingen måde for admin at se om fx '),
        code('ingest-ejf-bulk'),
        txt(' eller '),
        code('pull-bbr-events'),
        txt(' fejler.')
      ),
      para(
        txt('Samtidig findes der '),
        strong('ingen UI-view'),
        txt(' der viser cron-status. Selv hvis heartbeats blev skrevet, kunne admins ikke se dem uden at kigge direkte i Supabase.')
      ),
      heading(2, 'Leverancer'),
      ul(
        li(
          para(
            strong('Del A — Wire heartbeats til alle crons. '),
            txt('Tilføj '),
            code('recordHeartbeat({ jobName, status, duration, interval })'),
            txt(' i try/finally-blok til alle 11 resterende cron-routes:')
          )
        ),
        li(
          para(
            code('pull-bbr-events'),
            txt(', '),
            code('ingest-ejf-bulk'),
            txt(', '),
            code('deep-scan'),
            txt(', '),
            code('warm-cache'),
            txt(', '),
            code('daily-report'),
            txt(', '),
            code('daily-status'),
            txt(', '),
            code('monitor-email'),
            txt(', '),
            code('generate-sitemap'),
            txt(' (x3 phases), '),
            code('poll-properties'),
            txt(', '),
            code('purge-old-data'),
            txt(', '),
            code('ai-feedback-triage'),
            txt('.')
          )
        ),
        li(
          para(
            strong('Del B — Cron Status Dashboard. '),
            txt('Ny route '),
            code('/dashboard/admin/cron-status'),
            txt(' (eller ny tab under admin/service-management). Tabel viser pr. cron:')
          )
        ),
        li(para(txt('Job name, schedule (cron expression fra vercel.json)'))),
        li(para(txt('Seneste run-tidspunkt + status (OK / ERROR / OVERDUE hvis >2× forventet interval)'))),
        li(para(txt('Duration for seneste run'))),
        li(para(txt('Seneste fejlmeddelelse hvis status=error'))),
        li(para(txt('Antal runs siden midnat + fejl-rate'))),
        li(para(txt('Grøn/gul/rød badge pr. cron; samlet oversigt øverst (fx "10/12 crons OK")'))),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('Alle 12 crons i '), code('vercel.json'), txt(' skriver heartbeat ved hver invocation.'))),
        li(para(txt('Dashboard viser korrekt status for alle 12; OVERDUE-detektion fungerer (test ved at stoppe en cron manuelt).'))),
        li(para(txt('Fejlede runs viser fejlmeddelelsen i UI\'et uden at admin skal i Supabase.'))),
        li(para(txt('Siden auto-refresher hver 30. sek.'))),
      ),
      heading(2, 'Reference'),
      ul(
        li(para(code('supabase/migrations/041_cron_heartbeats.sql'), txt(' — schema'))),
        li(para(code('app/api/cron/service-scan/route.ts:905'), txt(' — eksisterende '), code('recordHeartbeat()'), txt('-call (brug som skabelon)'))),
        li(para(code('vercel.json'), txt(' — source-of-truth for cron-liste + schedules'))),
      ),
      heading(2, 'Relaterer'),
      ul(
        li(para(txt('Build-on-top-af '), strong('BIZZ-305'), txt(' (cron heartbeat monitoring, Done — kun infra er færdig, rollout mangler).'))),
      ),
    ],
  },
};

// ─── Ticket 2: Fix broken + add missing health checks ────────────────────────

const t2 = {
  priority: 'Medium',
  summary: 'Infrastruktur-status: fix Stripe/Datafordeler "HTTP fejl" + live-probe for CVR/Brave/Resend/Upstash/Mediastack/Twilio',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Problem'),
      para(
        txt('Admin-siden '),
        code('/dashboard/admin/service-management'),
        txt(' viser "8/10 operationelle" men er upålidelig:')
      ),
      ul(
        li(
          para(
            strong('Stripe '),
            txt('viser '),
            code('Ukendt — HTTP fejl ved statushentning'),
            txt('. Statuspage-whitelist indeholder '),
            code('status.stripe.com'),
            txt(' ('),
            code('app/api/admin/service-status/route.ts:69'),
            txt('), men fetch fejler — formentlig client-side CORS eller 5xx fra proxy. Ingen fejl-detaljer vises.')
          )
        ),
        li(
          para(
            strong('Datafordeleren '),
            txt('viser '),
            code('Ukendt — HTTP 401 kan ikke nås'),
            txt('. HTTP HEAD-probe bliver afvist fordi Datafordeler kræver Basic Auth på hele domænet. Check-metoden er forkert.')
          )
        ),
        li(
          para(
            strong('4 komponenter er "static" '),
            txt('— ingen reel probe, status er hardkodet til '),
            code('operational'),
            txt(': Upstash Redis, Resend, CVR ElasticSearch, Brave Search. Kan være nede uden vi opdager det.')
          )
        ),
        li(
          para(
            strong('Ikke-overvåget overhovedet: '),
            txt('Mediastack, Twilio, Tinglysning mTLS-endpoint.')
          )
        ),
      ),
      heading(2, 'Leverancer'),
      ul(
        li(para(strong('Fix Stripe-probe'), txt(': log den faktiske HTTP-fejl server-side, fix root-cause (eller skift til '), code('https://status.stripe.com/api/v2/summary.json'), txt(' via proxy).'))),
        li(para(strong('Fix Datafordeler-probe'), txt(': brug en kendt auth\'et endpoint der returnerer 200, fx '), code('GET /BBR/BBRPublic/1/rest/sag?pagesize=1'), txt(' med Basic Auth (bruger/pass findes allerede i env).'))),
        li(para(strong('Live-probe for statiske komponenter'))),
        li(para(txt('Upstash Redis: '), code('PING'), txt('-kommando via '), code('@upstash/redis'), txt(' client'))),
        li(para(txt('Resend: '), code('GET https://api.resend.com/domains'), txt(' med API-nøgle → 200 OK'))),
        li(para(txt('CVR ElasticSearch: '), code('GET /_cluster/health'), txt(' eller let søge-query'))),
        li(para(txt('Brave Search: '), code('GET /res/v1/web/search?q=test&count=1'), txt(' → 200'))),
        li(para(strong('Tilføj nye komponenter til dashboard'))),
        li(para(txt('Mediastack: '), code('GET http://api.mediastack.com/v1/news?access_key=…&limit=1'), txt(' (check pr. dag, ikke pr. load — de har lavt kvota)'))),
        li(para(txt('Twilio: '), code('GET https://api.twilio.com/2010-04-01/Accounts/{sid}.json'), txt(' → 200'))),
        li(
          para(
            txt('Tinglysning: mTLS handshake check mod '),
            code('https://www.tinglysning.dk/tinglysning/ssl/'),
            txt(' + cert-udløbs-dato (bygger på '),
            strong('BIZZ-304'),
            txt(' som allerede overvåger cert-udløb).')
          )
        ),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('Ingen "HTTP fejl" eller "Ukendt" på Stripe/Datafordeleren når de faktisk er oppe.'))),
        li(para(txt('Alle 10 + 3 = 13 komponenter viser reel status baseret på probe.'))),
        li(para(txt('Probes cachet 60 s — ikke ét kald pr. page-render.'))),
        li(para(txt('Fejl i probe logges til Sentry, ikke kun i UI.'))),
      ),
      heading(2, 'Reference'),
      ul(
        li(para(code('app/dashboard/admin/service-management/ServiceManagementClient.tsx:118-218'), txt(' — SERVICES array'))),
        li(para(code('app/api/admin/service-status/route.ts:65-79'), txt(' — whitelist + probe-logik'))),
      ),
      heading(2, 'Relaterer'),
      ul(li(para(txt('Build-on-top-af '), strong('BIZZ-306'), txt(' (External API availability monitoring, Done — partial rollout).')))),
    ],
  },
};

// ─── Ticket 3: Auto-route failures to Service Manager agent ─────────────────

const t3 = {
  priority: 'High',
  summary: 'Service Manager: auto-trigger agent ved cron-heartbeat-fejl og infra-down events',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Mål'),
      para(
        txt('Når en cron fejler eller en infra-komponent går ned, skal Service Manager-agenten (der allerede kan scanne Vercel-deployments og foreslå AI-fixes) '),
        strong('automatisk'),
        txt(' sættes i gang med at undersøge og løse problemet — uden at admin skal opdage det manuelt via dashboard.')
      ),
      heading(2, 'Nuværende situation'),
      ul(
        li(para(txt('Service Manager reagerer i dag på Vercel-deployment-fejl (auto-scan hver time via '), code('/api/cron/service-scan'), txt(') og på email-alerts (via '), code('/api/cron/monitor-email'), txt(' der læser '), code('monitor@pecuniait.com'), txt(').'))),
        li(para(txt('Den reagerer '), strong('ikke'), txt(' på cron-heartbeat-fejl eller på infra-status-ændringer fra '), code('/dashboard/admin/service-management'), txt('.'))),
        li(para(txt('Approved fixes sidder og venter på manuel "Apply Hotfix"-klik — de bliver ikke rullet ud automatisk.'))),
      ),
      heading(2, 'Leverancer'),
      ul(
        li(
          para(
            strong('Trigger 1: Cron heartbeat failure / overdue. '),
            txt('Når '),
            code('cron_heartbeats.last_status = \'error\''),
            txt(' ELLER '),
            code('now() - last_run_at > 2× expected_interval'),
            txt(', opret et '),
            code('service_manager_scans'),
            txt('-row med '),
            code('scan_type = \'cron_failure\''),
            txt(' + payload om det fejlende job. Dette kan køres i selve '),
            code('service-scan'),
            txt('-cron (hver time) som ekstra check.')
          )
        ),
        li(
          para(
            strong('Trigger 2: Infra-komponent down. '),
            txt('Når probe (efter fix af søster-ticket) returnerer '),
            code('down'),
            txt(' to gange i træk, opret '),
            code('service_manager_scans'),
            txt(' med '),
            code('scan_type = \'infra_down\''),
            txt(' + komponent-navn. Undgår flaky single-probe-false-positive.')
          )
        ),
        li(
          para(
            strong('Klassifikation i Service Manager-agent: '),
            txt('Agent skal selv kunne skelne mellem "løsbar via kodefix" (fx ændret JSON-shape, manglende null-check) og "infra-action påkrævet" (fx Stripe nede, Supabase nede). For infra-action: notifér via Resend + opret JIRA-ticket uden at forsøge auto-fix.')
          )
        ),
        li(
          para(
            strong('Auto-apply for approved fixes '),
            txt('(valgfri — kan være separat ticket): Hvis en fix har kørt gennem safety-validering ('),
            code('max 50 lines'),
            txt(', blocked patterns) OG er marked approved, rul den automatisk ud via release-agent-flow. Behold admin-knap som backup.')
          )
        ),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('Cron der fejler 2 gange i træk udløser '), code('service_manager_scans'), txt(' med '), code('scan_type = \'cron_failure\''), txt(' inden for 30 min.'))),
        li(para(txt('Infra-komponent der går ned udløser '), code('service_manager_scans'), txt(' med '), code('scan_type = \'infra_down\''), txt(' inden for 10 min.'))),
        li(para(txt('Agent foreslår en fix (kode) eller opretter JIRA (infra) afhængigt af klassifikation.'))),
        li(para(txt('Ingen falske positive ved single-probe-glitch — kræver 2 konsekutive failures.'))),
      ),
      heading(2, 'Reference'),
      ul(
        li(para(code('app/api/cron/service-scan/route.ts'), txt(' — hourly scan-routine, kan udvides'))),
        li(para(code('app/api/cron/monitor-email/route.ts'), txt(' — eksisterende pattern for '), code('scan_type'), txt('-trigger'))),
        li(para(code('app/api/admin/service-manager/scan/route.ts'), txt(' — selve scanner-logikken'))),
        li(para(code('app/api/admin/service-manager/auto-fix/route.ts'), txt(' — AI fix-generation'))),
      ),
    ],
  },
};

// ─── Ticket 4: Sentry cron-monitor integration ──────────────────────────────

const t4 = {
  priority: 'Medium',
  summary: 'Observability: Sentry Cron Monitoring på alle 12 cron-routes',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Problem'),
      para(
        txt('Sentry er allerede integreret til error-tracking (se '),
        code('app/lib/dawa.ts'),
        txt(', '),
        code('app/api/vurdering/*'),
        txt(', m.fl.), men '),
        strong('ingen cron-routes'),
        txt(' bruger '),
        code('Sentry.withMonitor()'),
        txt(' eller cron-checkin. Det betyder vi ikke har historisk cron-performance-data, ikke kan se fejl-trending over tid, og ingen eksternt alert-system hvis hele Vercel-deployment er nede.')
      ),
      heading(2, 'Leverancer'),
      ul(
        li(
          para(
            txt('Wrap alle 12 cron-GET-handlers i '),
            code('Sentry.withMonitor(\'job-name\', async () => { ... }, { schedule: { type: \'crontab\', value: \'…\' }, maxRuntime: 5, checkinMargin: 1 })'),
            txt(' — ref: '),
            code('https://docs.sentry.io/platforms/javascript/guides/nextjs/crons/'),
            txt('.')
          )
        ),
        li(para(txt('Opret Sentry cron-monitor pr. job med alert-regler ved missed/failed.'))),
        li(para(txt('Link Sentry alerts til samme klassifikation som Service Manager (søster-ticket) — undgå duplikerede alerts.'))),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('Alle 12 cron-GET-handlers wrapper deres logik i '), code('Sentry.withMonitor()'), txt('.'))),
        li(para(txt('Sentry dashboard viser status pr. cron; missed/failed udløser alert.'))),
        li(para(txt('Sentry-cron-checkin er supplement — ikke erstatning — for vores '), code('cron_heartbeats'), txt('-tabel.'))),
      ),
      heading(2, 'Værdi'),
      para(
        txt('Belt-and-suspenders-observability: '),
        code('cron_heartbeats'),
        txt(' (intern, realtime) + Sentry (ekstern, trending + alert-eskalering). Sentry er også det sted ops typisk tjekker først, så det bør ikke være blind for cron-status.')
      ),
    ],
  },
};

// ─── Ticket 5: Unified Operations Dashboard ─────────────────────────────────

const t5 = {
  priority: 'Medium',
  summary: 'Unified Operations Dashboard: konsolidér Service Management + Service Manager + Cron Status i én admin-side',
  description: {
    type: 'doc',
    version: 1,
    content: [
      heading(2, 'Mål'),
      para(
        txt('Én admin-side der viser det samlede billede: infra-komponenter + cron-status + Service Manager activity + åbne issues. I dag skal admin besøge '),
        strong('3+ forskellige sider'),
        txt(' ('),
        code('/dashboard/admin/service-management'),
        txt(', '),
        code('/dashboard/admin/service-manager'),
        txt(', samt det kommende '),
        code('/dashboard/admin/cron-status'),
        txt(' fra søster-ticket) for at få overblik.')
      ),
      heading(2, 'Design'),
      ul(
        li(para(strong('Top-level tile-grid '), txt('med health-status pr. kategori: Infrastructure, Crons, Service Manager Agent, Alerts.'))),
        li(para(strong('Drill-down '), txt('på klik — åbner den relevante sub-side uden at forlade admin-konteksten.'))),
        li(para(strong('Samlet count-badge '), txt('på admin-nav: "3 issues" hvis der er åbne infra-down eller failed-cron events.'))),
        li(para(strong('Event-timeline '), txt('nederst: kronologisk log af alt der er sket siden midnat (deploys, cron-runs, infra-status-ændringer, Service Manager-scans).'))),
      ),
      heading(2, 'Acceptance criteria'),
      ul(
        li(para(txt('Admin kan svare på "er alt OK?" på under 5 sekunder fra landing page.'))),
        li(para(txt('Alle 13 infra-komponenter + 12 cron-status + 10 seneste Service Manager-scans synlige fra ét sted.'))),
        li(para(txt('Badges matcher underliggende data (ingen cache-drift mellem tile og drill-down).'))),
        li(para(txt('Mobile-responsive (admin bruger det også fra telefon når der er alerts).'))),
      ),
      heading(2, 'Afhænger af'),
      ul(
        li(para(txt('Cron Status Dashboard-ticket (Del B — heartbeat-rollout + UI).'))),
        li(para(txt('Auto-route-ticket (Service Manager trigger-integration).'))),
        li(para(txt('Live-probe-ticket (så infra-tile\'ene faktisk viser sandheden).'))),
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

const created = [];
for (const tk of [t1, t2, t3, t4, t5]) {
  const res = await req('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: PROJECT },
      summary: tk.summary,
      description: tk.description,
      issuetype: { id: issueType.id },
      priority: { name: tk.priority },
    },
  });
  if (res.status === 201) {
    const key = JSON.parse(res.body).key;
    console.log(`✅ ${key} [${tk.priority}]  —  ${tk.summary}`);
    console.log(`   https://${HOST}/browse/${key}`);
    created.push({ key, summary: tk.summary });
  } else {
    console.log(`❌ FAILED (${res.status}) "${tk.summary}":`, res.body.slice(0, 400));
  }
}

// Link: t5 (Unified Dashboard) depends on t1, t2, t3
if (created.length >= 5) {
  for (const dep of [created[0], created[1], created[2]]) {
    const res = await req('POST', '/rest/api/3/issueLink', {
      type: { name: 'Blocks' },
      inwardIssue: { key: created[4].key },
      outwardIssue: { key: dep.key },
    });
    if (res.status === 201) console.log(`  ↳ ${dep.key} Blocks ${created[4].key}`);
  }
}
