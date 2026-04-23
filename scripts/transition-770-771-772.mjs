#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const perTicket = {
  'BIZZ-772': { type: 'doc', version: 1, content: [
    p(strong('Shipped — AdminNavTabs tilføjet til DomainsListClient')),
    p(txt('Tidligere renderede '), code('/dashboard/admin/domains'), txt(' rå uden tab-bar, så brugeren mistede Brugere/Fakturering/etc. tabs når de klikkede Domains. Nu wrapper '), code('<AdminNavTabs activeTab="domains">'), txt(' øverst i '), code('DomainsListClient.tsx'), txt('. Matches alle andre admin-sider.')),
    p(txt('For drill-down til et specifikt domain er layoutet allerede korrekt via BIZZ-761 ('), code('/dashboard/admin/domains/[id]/layout.tsx'), txt(' med DomainAdminTabs som sub-nav).')),
    p(strong('Commit: '), code('0d826e8'), txt('. '), strong('→ In Review.')),
  ]},
  'BIZZ-771': { type: 'doc', version: 1, content: [
    p(strong('Shipped — Option A — fuld bredde')),
    p(txt('Admin-pages havde inkonsistent max-width (3xl/4xl/5xl/6xl). Standardiseret til '), code('max-w-7xl'), txt(' (1280px) — matches Plans som allerede var på den bredde.')),
    p(txt('Files widened:')),
    ul(
      li(p(txt('analytics (5xl → 7xl)'))),
      li(p(txt('ai-media-agents (3xl → 7xl)'))),
      li(p(txt('cron-status (6xl → 7xl)'))),
      li(p(txt('ops (6xl → 7xl)'))),
      li(p(txt('security (3xl → 7xl)'))),
      li(p(txt('service-management (6xl → 7xl) + loading'))),
      li(p(txt('domains (6xl → 7xl)'))),
    ),
    p(txt('Users + Billing havde ingen width-cap — uændret.')),
    p(strong('Commit: '), code('0d826e8'), txt('. '), strong('→ In Review.')),
  ]},
  'BIZZ-770': { type: 'doc', version: 1, content: [
    p(strong('Scope-too-large — foreslår split til sub-tickets før implementation')),
    p(txt('Denne ticket dækker '), strong('15+ eksterne interfaces + 10+ interne komponenter'), txt(' med live probes + alert-konfiguration + per-service thresholds. Det er 2-4 ugers arbejde og kræver nye API-endpoints, Sentry-integration, Upstash metrics, DB-performance-metrics, samt reorganisering af ServiceManagementClient.tsx.')),
    p(strong('Nuværende state:')),
    ul(
      li(p(txt('13 services har live probes (Vercel/Supabase/Anthropic/Stripe/Mapbox via statusUrl, Upstash/Resend/Datafordeler/CVR/Brave/Mediastack/Twilio via probeId)'))),
      li(p(txt('Backend health-endpoint eksisterer: '), code('/api/health?deep=true'))),
      li(p(txt('Cron /api/cron/daily-status aggregerer daglig rapport'))),
    ),
    p(strong('Anbefalet split (forslag til user):')),
    ul(
      li(p(code('BIZZ-770a'), txt(' — Database performance metrics (query latens p50/p95/p99, connection pool, autovacuum)'))),
      li(p(code('BIZZ-770b'), txt(' — Internal components: rate-limiter, pgvector queue, audit write-rate, webhook delivery/parse errors'))),
      li(p(code('BIZZ-770c'), txt(' — Per-tenant/domain AI token burn-rate + cost allocation'))),
      li(p(code('BIZZ-770d'), txt(' — Sentry SDK full integration (tags, breadcrumbs, source maps)'))),
      li(p(code('BIZZ-770e'), txt(' — Alert configuration UI + notification channels (Sentry/email/SMS)'))),
      li(p(code('BIZZ-770f'), txt(' — Reorganiser ServiceManagementClient i "External" vs "Internal" sections'))),
    ),
    p(strong('→ Holder i To Do. Split før shipping anbefales.')),
  ]},
};

for (const [key, body] of Object.entries(perTicket)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  if (key !== 'BIZZ-770') {
    const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
    const target = (JSON.parse(tr.body).transitions || []).find((t) => /^in review$/i.test(t.name));
    if (target) {
      const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: target.id } });
      console.log(r.status === 204 ? `  ✅ ${key} → In Review` : `  ⚠️ ${r.status}`);
    }
  } else {
    console.log(`  ◻ ${key} holds in To Do (scope-note added)`);
  }
}
