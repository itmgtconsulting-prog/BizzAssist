#!/usr/bin/env node
/**
 * Creates Data Intelligence epic + 33 child stories in JIRA.
 *
 * Anchor doc: docs/architecture/DATA_INTELLIGENCE.md
 *
 * Phases:
 *   1. Data Catalog (6 tickets)
 *   2. Knowledge Cache (10 tickets)
 *   3. Smart SQL Generation (9 tickets)
 *   4. UX Polish (4 tickets)
 *   5. E2E Test + iterative fix-loop (4 tickets)
 *
 * Run: node scripts/create-data-intelligence-tickets.mjs
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
const PROJECT_KEY = 'BIZZ';

if (!EMAIL || !TOKEN) {
  console.error('Missing JIRA_EMAIL or JIRA_API_TOKEN in .env.local');
  process.exit(1);
}

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

// ADF helpers
const p = (...nodes) => ({
  type: 'paragraph',
  content: nodes.map((n) => (typeof n === 'string' ? { type: 'text', text: n } : n)),
});
const h = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
  })),
});
const code = (text, language) => ({
  type: 'codeBlock',
  attrs: language ? { language } : {},
  content: [{ type: 'text', text }],
});

const doc = (...content) => ({ type: 'doc', version: 1, content });

// Common acceptance criteria templates
const acceptance = (items) => [h(2, 'Acceptance kriterier'), bullets(items)];
const background = (text) => [h(2, 'Baggrund'), p(text)];
const task = (items) => [h(2, 'Opgave'), bullets(items)];

// Epic
const epic = {
  issuetype: 'Epic',
  summary: 'Data Intelligence — træn AI på lokale data (catalog + knowledge cache + smart SQL)',
  priority: 'High',
  labels: ['data-intelligence', 'ai', 'analyse', 'epic'],
  description: doc(
    h(2, 'Mål'),
    p(
      'Gør AI-assistenten til en kender af vores data — ikke bare en der søger i den. ' +
        'Lag 1+2+3 arkitektur: Data Catalog (metadata), Knowledge Cache (pre-beregnede aggregater), ' +
        'Smart SQL (AI-genereret SELECT med AST-validering + read-only rolle).'
    ),
    h(2, 'Anker-dokument'),
    p('docs/architecture/DATA_INTELLIGENCE.md (committed til develop)'),
    h(2, 'Faser'),
    bullets([
      'Fase 1 — Data Catalog (6 tickets)',
      'Fase 2 — Knowledge Cache (10 tickets)',
      'Fase 3 — Smart SQL Generation (9 tickets)',
      'Fase 4 — UX Polish (4 tickets)',
      'Fase 5 — E2E test + iterativ fix-loop (4 tickets)',
    ]),
    h(2, 'Success-kriterier'),
    bullets([
      'AI svarer "Hvor mange virksomheder i Aarhus?" på <2s uden DB-kald',
      'AI kan svare på 25 testscenarier i E2E suite uden fejl',
      'Audit log dækker hver AI-genereret SQL-query',
      'Catalog refreshes natligt; knowledge cache freshness < 24h',
      'Ingen regressions på eksisterende AI chat-funktionalitet',
    ])
  ),
};

// ============ FASE 1 — Data Catalog (6 tickets) ============
const phase1 = [
  {
    summary: 'DI-01 DBA: Migration analyse.data_catalog tabel + indexes + RLS',
    priority: 'High',
    labels: ['data-intelligence', 'fase-1', 'dba', 'migration'],
    description: doc(
      ...background(
        'Fase 1 i Data Intelligence: pre-beregnet metadata om alle whitelistede tabeller, ' +
          'injiceres i AI system prompt. Kræver ny tabel analyse.data_catalog.'
      ),
      ...task([
        'Opret schema analyse hvis ikke eksisterer',
        'Migration: CREATE TABLE analyse.data_catalog med kolonner: table_schema, table_name, column_name (nullable), data_type, row_count, null_count, distinct_count, top_values jsonb, min_value, max_value, semantic_label, pii_flag boolean, computed_at timestamptz',
        'Primary key (table_schema, table_name, column_name) med column_name = empty string for table-level row',
        'Index på (table_schema, table_name)',
        'Index på computed_at DESC',
        'RLS policy: read-only for authenticated, full access for service_role',
        'Migration nummer: næste i rækken (tjek supabase/migrations/)',
      ]),
      ...acceptance([
        'Migration filer committed i supabase/migrations/',
        'Migration applied i dev + test + prod (verificeret med to_regclass)',
        'RLS policies enabled og testet',
        'JSDoc i migration kommentar med formål',
      ])
    ),
  },
  {
    summary: 'DI-02 Backend: lib/dataIntelligence/buildCatalog.ts — sample-based stats builder',
    priority: 'High',
    labels: ['data-intelligence', 'fase-1', 'backend'],
    description: doc(
      ...background(
        'Builder-funktion der populerer analyse.data_catalog. Skal være performant nok ' +
          'til at køre på 2.5M+ rækker tabeller via sampling.'
      ),
      ...task([
        'Opret app/lib/dataIntelligence/buildCatalog.ts',
        'For tabeller > 1M rækker: brug pg_class.reltuples for row_count',
        'For tabeller < 100k rækker: COUNT(*) exact',
        'Null/distinct stats: TABLESAMPLE 1% for store tabeller',
        'Top values: array_agg(value ORDER BY count DESC LIMIT 10) ekskl. pii_flag kolonner',
        'PII-kolonneliste konfigurerbar (navne, emails, cpr, addresser)',
        'Returnér struktureret resultat klar til INSERT/UPSERT',
        'Unit tests for hver hjælpefunktion',
      ]),
      ...acceptance([
        'app/lib/dataIntelligence/buildCatalog.ts eksisterer med JSDoc',
        'Kan bygge catalog for alle 8 whitelistede tabeller på <60s',
        'Unit tests dækker null-rate, top-values, PII-eksklusion',
        'Coverage ≥ 70% lines for buildCatalog.ts',
      ])
    ),
  },
  {
    summary: 'DI-03 Backend: /api/cron/refresh-data-catalog route + Vercel cron config',
    priority: 'High',
    labels: ['data-intelligence', 'fase-1', 'backend', 'cron'],
    description: doc(
      ...background(
        'Cron-endpoint der natligt opdaterer data_catalog. Skal verificere CRON_SECRET + x-vercel-cron header per CLAUDE.md regler.'
      ),
      ...task([
        'Opret app/api/cron/refresh-data-catalog/route.ts',
        'Verificér CRON_SECRET bearer + x-vercel-cron: 1 header i production',
        'Iterér over whitelist, kald buildCatalog() per tabel',
        'UPSERT resultater til analyse.data_catalog',
        'Tilføj entry til vercel.json crons schedule (03:00 daily)',
        'Sentry-logging ved fejl uden PII',
        'Returner JSON med antal opdaterede rækker per tabel',
      ]),
      ...acceptance([
        'Endpoint kan kaldes manuelt med korrekt bearer',
        'Vercel cron schedule er konfigureret',
        'Kører på <3 min i production',
        'Audit log entry i tenant.audit_log per kørsel',
      ])
    ),
  },
  {
    summary: 'DI-04 Backend: lib/dataIntelligence/formatCatalogForPrompt.ts — kompakt Markdown',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-1', 'backend', 'ai'],
    description: doc(
      ...background(
        'Catalog-data skal formateres til kompakt Markdown der kan injiceres i AI system prompt. ' +
          'Budget: ~2.500 tokens for hele kataloget.'
      ),
      ...task([
        'Opret app/lib/dataIntelligence/formatCatalogForPrompt.ts',
        'Format: ### {table} ({row_count} rækker) + bullet per kolonne med type/null%/top-3',
        'Token-budget guard: trunkér til 3000 tokens hvis overskredet',
        'Inkluder computed_at timestamp øverst',
        'Eksklusioner: skjul pii_flag kolonner fra top-values output',
        'Unit tests: snapshot test af output',
      ]),
      ...acceptance([
        'Output < 3000 tokens for hele whitelistet',
        'Markdown er well-formed og læsbart',
        'Snapshot tests passerer',
      ])
    ),
  },
  {
    summary: 'DI-05 AI/ML: Inject catalog i /api/ai/chat system prompt + cache breakpoint',
    priority: 'High',
    labels: ['data-intelligence', 'fase-1', 'ai'],
    description: doc(
      ...background(
        'AI chat skal have data catalog i system prompt med ephemeral cache breakpoint for at ' +
          'undgå at gen-sende katalog ved hver request.'
      ),
      ...task([
        'Hent seneste catalog fra analyse.data_catalog ved request-start (cached in-memory 5 min)',
        'Inject formateret catalog som system prompt-sektion under "## Data du har adgang til"',
        'Marker som ephemeral cache breakpoint (5min TTL)',
        'Opdatér system prompt-instruktioner så Claude ved den må bruge catalog',
        'Token usage tracking: log catalog token-count til Sentry breadcrumb',
      ]),
      ...acceptance([
        'AI chat svarer på "Hvilke tabeller har vi data i?" uden tool-kald',
        'Prompt cache hit rate ≥ 80% efter 2 requests',
        'Ingen regressions i eksisterende chat-funktionalitet',
      ])
    ),
  },
  {
    summary: 'DI-06 AI/ML: Inject catalog i /api/analyse/query + opdater query-plan prompt',
    priority: 'High',
    labels: ['data-intelligence', 'fase-1', 'ai'],
    description: doc(
      ...background(
        'AI Query Builder skal også have catalog så genererede query plans bliver præcise. ' +
          'Senere (Fase 3) erstattes query plan med Smart SQL — men denne mellem-fix forbedrer ' +
          'eksisterende funktionalitet.'
      ),
      ...task([
        'Inject catalog i /api/analyse/query system prompt',
        'Tilføj eksempler der bruger catalog-viden (fx "kommunekode 101 = København")',
        'Test med 5 known-bad queries fra brugerfeedback',
      ]),
      ...acceptance([
        'Eksisterende AI Query Builder svarer mere præcist',
        'Færre "kolonnen findes ikke" fejl',
      ])
    ),
  },
];

// ============ FASE 2 — Knowledge Cache (10 tickets) ============
const phase2 = [
  {
    summary: 'DI-07 DBA: Migration analyse.analytics_knowledge tabel + indexes',
    priority: 'High',
    labels: ['data-intelligence', 'fase-2', 'dba', 'migration'],
    description: doc(
      ...background('Fase 2: pre-beregnede aggregater (topics) for common questions.'),
      ...task([
        'CREATE TABLE analyse.analytics_knowledge med kolonner: id uuid PK, topic text, topic_label_da text, key jsonb, value jsonb, computed_at, expires_at, source_query text',
        'Index på (topic, computed_at DESC)',
        'Index på topic for hurtige lookups',
        'RLS: read for authenticated, write for service_role',
        'Unique constraint på (topic, key) for upsert',
      ]),
      ...acceptance([
        'Migration applied i dev/test/prod',
        'Constraints + indexes verificeret',
      ])
    ),
  },
  {
    summary: 'DI-08 Backend: topics/companyByMunicipality.ts builder',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-2', 'backend', 'topic-builder'],
    description: doc(
      ...background('Topic: antal virksomheder per kommune (aktive + inaktive).'),
      ...task([
        'Opret app/lib/dataIntelligence/topics/companyByMunicipality.ts',
        'Query cvr_virksomhed group by kommunekode',
        'Output: 1 row per kommune med {count, active_count, ophoert_count}',
        'Source query gemmes i analytics_knowledge.source_query',
        'Unit test',
      ]),
      ...acceptance(['Builder kører på <10s', 'Output dækker alle 98 kommuner'])
    ),
  },
  {
    summary: 'DI-09 Backend: topics/companyByIndustry + companyStatusDistribution',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-2', 'backend', 'topic-builder'],
    description: doc(
      ...background('Topics: virksomheder per branchekode + global status-fordeling.'),
      ...task([
        'topics/companyByIndustry.ts: group by branchekode, top 200 branches',
        'topics/companyStatusDistribution.ts: NORMAL/OPHØRT/UNDER_KONKURS counts',
        'Unit tests for begge',
      ]),
      ...acceptance(['Begge builders kører på <15s combined'])
    ),
  },
  {
    summary: 'DI-10 Backend: topics/propertyByType + propertyByMunicipality',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-2', 'backend', 'topic-builder'],
    description: doc(
      ...background('Topics: ejendomme per BBR-anvendelseskode + per kommune.'),
      ...task([
        'topics/propertyByType.ts: group by bbr_anvendelseskode',
        'topics/propertyByMunicipality.ts: group by kommunekode',
        'Inkluder label-lookup via kommune_ref tabel',
        'Unit tests',
      ]),
      ...acceptance(['Builders kører på <20s combined på 2.5M ejendomme'])
    ),
  },
  {
    summary: 'DI-11 Backend: topics/avgValuationByType builder',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-2', 'backend', 'topic-builder'],
    description: doc(
      ...background('Topic: gennemsnitsvurdering per ejendomstype + kommune.'),
      ...task([
        'Join vurdering_cache med bbr_ejendom_status',
        'Group by anvendelseskode + kommunekode',
        'Output: avg_value, median_value, count',
        'Unit test',
      ]),
      ...acceptance(['Builder kører på <30s'])
    ),
  },
  {
    summary: 'DI-12 Backend: topics/dataCoverage* (BBR + vurdering + energimærke)',
    priority: 'High',
    labels: ['data-intelligence', 'fase-2', 'backend', 'topic-builder'],
    description: doc(
      ...background(
        'Topics: dækningsstatistik — hvilke ejendomme mangler hvilke datapunkter. ' +
          'KRITISK for AI ærlighed: AI skal vide hvad vi IKKE har.'
      ),
      ...task([
        'topics/dataCoverageBbr.ts: % ejendomme med BBR-data, mangler per kommune',
        'topics/dataCoverageValuation.ts: % med vurdering, fordelt på årgang',
        'topics/dataCoverageEnergy.ts: % med energimærke',
        'Unit tests',
      ]),
      ...acceptance([
        'Hver builder rapporterer både total og per-kommune coverage',
        'Coverage % er accurate ±0.1%',
      ])
    ),
  },
  {
    summary: 'DI-13 Backend: topics/ownershipDistribution + recentRegistrations + temporalCoverage',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-2', 'backend', 'topic-builder'],
    description: doc(
      ...background('De sidste 3 initial topics.'),
      ...task([
        'topics/ownershipDistribution.ts: % virksomheder med ejerskabsdata',
        'topics/recentRegistrations.ts: nye virksomheder per måned seneste 12 mdr',
        'topics/temporalCoverage.ts: ældste + nyeste date i hver tabel',
        'Unit tests',
      ]),
      ...acceptance(['Alle 3 builders < 20s combined'])
    ),
  },
  {
    summary: 'DI-14 Backend: /api/cron/refresh-knowledge-cache route',
    priority: 'High',
    labels: ['data-intelligence', 'fase-2', 'backend', 'cron'],
    description: doc(
      ...background('Cron der orchestrerer alle 12 topic-builders natligt.'),
      ...task([
        'Opret app/api/cron/refresh-knowledge-cache/route.ts',
        'CRON_SECRET + x-vercel-cron verification',
        'Kør alle builders parallelt med Promise.allSettled (fejl i én må ikke stoppe andre)',
        'Per builder: UPSERT resultater + log status',
        'vercel.json: schedule 03:30 daily (efter catalog)',
        'Returnér summary {topic, status, rows, duration}',
      ]),
      ...acceptance([
        'Manuel kørsel via curl virker',
        'Vercel cron schedule konfigureret',
        'Total kørselstid <5 min',
        'Sentry-logging ved fejl uden PII',
      ])
    ),
  },
  {
    summary: 'DI-15 AI/ML: Ny AI tool hent_analytics_knowledge i /api/ai/chat',
    priority: 'High',
    labels: ['data-intelligence', 'fase-2', 'ai'],
    description: doc(
      ...background(
        'AI'+'-tool der lader Claude læse fra knowledge cache uden DB-roundtrip til de tunge tabeller.'
      ),
      ...task([
        'Tilføj tool definition: hent_analytics_knowledge({topic: string, key?: object})',
        'Implementér tool execution: query analytics_knowledge med topic + optional key match',
        'Returnér {value, computed_at, freshness_hours}',
        'AI skal vide at den må bruge tool først før den genererer SQL',
        'Tool description med liste af tilgængelige topics',
      ]),
      ...acceptance([
        'AI bruger tool for "hvor mange virksomheder i kommune X?" type spørgsmål',
        'Response time < 1s for cache hit',
        'Tool fejler gracefully hvis topic ikke findes',
      ])
    ),
  },
  {
    summary: 'DI-16 AI/ML: Executive knowledge summary i system prompt (top 10 facts)',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-2', 'ai'],
    description: doc(
      ...background(
        'For at AI har et grundlæggende "fingerspids-kendskab" til datasættets skala, ' +
          'injiceres 10 top-level facts i system prompt.'
      ),
      ...task([
        'Formatér 10 facts: total virksomheder, total ejendomme, top-3 kommuner, BBR-coverage%, etc.',
        'Inkluder i system prompt under "## Vores data i tal"',
        'Cached som ephemeral breakpoint',
        'Freshness-marker: "(opdateret YYYY-MM-DD)"',
      ]),
      ...acceptance([
        'AI kan svare på "hvor meget data har vi?" uden tool-kald',
        'Prompt token-cost øgning <500 tokens',
      ])
    ),
  },
];

// ============ FASE 3 — Smart SQL Generation (9 tickets) ============
const phase3 = [
  {
    summary: 'DI-17 DBA: Migration ai_query_reader rolle + grants',
    priority: 'High',
    labels: ['data-intelligence', 'fase-3', 'dba', 'security'],
    description: doc(
      ...background('Read-only DB-rolle som Smart SQL eksekverer under. Defense-in-depth.'),
      ...task([
        'CREATE ROLE ai_query_reader NOLOGIN',
        'GRANT USAGE ON SCHEMA public, analyse TO ai_query_reader',
        'GRANT SELECT på whitelistede tabeller (cvr_virksomhed, bbr_ejendom_status, ejf_ejerskab, regnskab_cache, vurdering_cache, kommune_ref, cvr_historik, cvr_virksomhed_ejerskab, mv_analyse_*)',
        'INGEN write/DDL grants',
        'Test: SET ROLE ai_query_reader; INSERT INTO ... → fejler korrekt',
        'Migration applied i dev + test + prod',
      ]),
      ...acceptance([
        'Rolle eksisterer i alle 3 env',
        'INSERT/UPDATE/DELETE fejler med permission denied',
        'SELECT på whitelistede tabeller virker',
      ])
    ),
  },
  {
    summary: 'DI-18 DBA: Migration analyse.ai_sql_audit tabel',
    priority: 'High',
    labels: ['data-intelligence', 'fase-3', 'dba', 'audit'],
    description: doc(
      ...background('Audit-log for hver AI-genereret SQL — kritisk for ISO 27001 + sporbarhed.'),
      ...task([
        'CREATE TABLE analyse.ai_sql_audit: id, tenant_id, user_id, user_prompt, generated_sql, ast_validated bool, executed bool, error text, row_count int, duration_ms int, created_at',
        'Indexes: (tenant_id, created_at DESC), (executed, ast_validated)',
        'RLS: tenant-scoped read for admin, full for service_role',
        'Retention: 12 måneder (per GDPR rules)',
      ]),
      ...acceptance([
        'Migration applied i dev/test/prod',
        'RLS policies blokerer cross-tenant read',
      ])
    ),
  },
  {
    summary: 'DI-19 Backend: lib/dataIntelligence/sqlValidator.ts — AST-baseret validering',
    priority: 'Highest',
    labels: ['data-intelligence', 'fase-3', 'backend', 'security'],
    description: doc(
      ...background(
        'KRITISK SIKKERHEDS-LAG: AST-parser der afviser farlig SQL før eksekvering. ' +
          'Defense-in-depth sammen med read-only rolle.'
      ),
      ...task([
        'Installér pg-query-emscripten (vurdér npm audit først)',
        'Opret app/lib/dataIntelligence/sqlValidator.ts',
        'Afvis: DDL (CREATE/DROP/ALTER/TRUNCATE), DML (INSERT/UPDATE/DELETE), DCL (GRANT/REVOKE)',
        'Afvis: system-schemas (pg_*, information_schema, auth, storage, tenant)',
        'Afvis: subqueries der refererer ikke-whitelistede tabeller',
        'Inject LIMIT 10000 hvis SELECT mangler LIMIT',
        'Returnér {valid: bool, sanitized_sql: string, reason?: string}',
        'Unit tests: 30+ adversarial test cases',
      ]),
      ...acceptance([
        '100% af adversarial tests afvises korrekt',
        'Whitelistede SELECT statements passerer uændret (modulo LIMIT injection)',
        'Coverage ≥ 90% lines for sqlValidator.ts',
        'Performance < 50ms per validering',
      ])
    ),
  },
  {
    summary: 'DI-20 Backend: lib/dataIntelligence/sqlExecutor.ts — read-only execution wrapper',
    priority: 'High',
    labels: ['data-intelligence', 'fase-3', 'backend', 'security'],
    description: doc(
      ...background('Wrapper der eksekverer valideret SQL som ai_query_reader med timeouts.'),
      ...task([
        'Opret app/lib/dataIntelligence/sqlExecutor.ts',
        'Bruger Supabase admin client → SET LOCAL ROLE ai_query_reader',
        'SET LOCAL statement_timeout = \'10s\'',
        'SET LOCAL lock_timeout = \'1s\'',
        'BEGIN READ ONLY transaction',
        'Eksekvér SQL, capture rows + duration',
        'COMMIT eller ROLLBACK ved fejl',
        'Returnér {rows, columns, duration_ms, truncated}',
        'Unit tests + integration test mod test-env',
      ]),
      ...acceptance([
        'Skriveoperationer fejler korrekt (selv hvis validator-bug lader dem slippe igennem)',
        'Lange queries timeout efter 10s',
        'Cross-tenant queries afvises af RLS',
      ])
    ),
  },
  {
    summary: 'DI-21 Backend: /api/analyse/sql route — generate + validate + execute + audit',
    priority: 'High',
    labels: ['data-intelligence', 'fase-3', 'backend'],
    description: doc(
      ...background('End-to-end endpoint: bruger-prompt → AI genererer SQL → validate → execute → audit.'),
      ...task([
        'Opret app/api/analyse/sql/route.ts',
        'POST body: { prompt: string }',
        'Step 1: resolveTenantId() + 401 if unauth',
        'Step 2: Claude genererer SQL (system prompt med catalog + few-shot)',
        'Step 3: sqlValidator.validate()',
        'Step 4: sqlExecutor.execute()',
        'Step 5: INSERT audit row uanset success/fail',
        'Step 6: Returnér {sql, rows, columns, duration, error?}',
        'Rate limit: 20/min per tenant',
        'AbortSignal.timeout(15000) på Claude-kald',
      ]),
      ...acceptance([
        'Happy path: prompt → struktureret resultat',
        'Adversarial prompt: afvist + audit row',
        'Lang query: timeout + graceful error',
        'Audit log korrekt per request',
      ])
    ),
  },
  {
    summary: 'DI-22 AI/ML: SQL-generation prompt med few-shot eksempler',
    priority: 'High',
    labels: ['data-intelligence', 'fase-3', 'ai'],
    description: doc(
      ...background('System prompt der lærer Claude at generere godt PostgreSQL mod vores schema.'),
      ...task([
        'Opret app/lib/dataIntelligence/sqlGenPrompt.ts',
        'Inkluder data catalog som kontekst',
        '10 few-shot eksempler: simple counts, joins, group by, time-series',
        'Eksplicitte regler: kun SELECT, altid LIMIT, brug catalog-kolonnenavne',
        'Eksempler på "umuligt" spørgsmål → returner forklaring i stedet for SQL',
        'Test mod 20 known prompts',
      ]),
      ...acceptance([
        'SQL er korrekt for 18/20 testprompts',
        'AI returnerer forklaring ved umulige spørgsmål',
        'Prompt < 4000 tokens (eksklusiv catalog)',
      ])
    ),
  },
  {
    summary: 'DI-23 Frontend: /dashboard/analyse/intelligence side med SQL-preview UI',
    priority: 'High',
    labels: ['data-intelligence', 'fase-3', 'frontend'],
    description: doc(
      ...background('Ny brugerflade hvor man kan stille spørgsmål og se genereret SQL + resultat.'),
      ...task([
        'Opret app/dashboard/analyse/intelligence/page.tsx',
        'Input field (prompt) + "Spørg" knap',
        'Vis genereret SQL i syntax-highlighted blok (kollapserbar)',
        'Vis resultat som tabel + chart toggle',
        'Vis duration + row count + freshness',
        'Mobil-responsive + dark theme',
        'loading.tsx skeleton',
        'Skip-to-main link',
        'aria-labels på interaktive elementer',
      ]),
      ...acceptance([
        'Side renderer på <2s',
        'WCAG AA compliance verificeret',
        'Mobile-friendly på iPhone-bredde',
      ])
    ),
  },
  {
    summary: 'DI-24 Frontend: Erstat structured query plan UI i AnalyseDataClient.tsx',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-3', 'frontend'],
    description: doc(
      ...background(
        'Eksisterende AnalyseDataClient.tsx bruger structured query plan. Erstat med ' +
          'Smart SQL endpoint mens UI bevares (samme prompt-input, samme chart-output).'
      ),
      ...task([
        'Redirect AnalyseDataClient til /api/analyse/sql i stedet for /api/analyse/query',
        'Tilføj "Vis SQL" toggle for power users',
        'Bevar chart-recommendation flow',
        'Behold backward-compat hvis muligt',
      ]),
      ...acceptance([
        'Eksisterende UX bevares',
        'Power user kan se SQL',
        'Ingen regressions',
      ])
    ),
  },
  {
    summary: 'DI-25 Frontend: Chart-recommendation engine baseret på result-shape',
    priority: 'Low',
    labels: ['data-intelligence', 'fase-3', 'frontend'],
    description: doc(
      ...background('Auto-vælg chart-type baseret på query result shape.'),
      ...task([
        'Opret app/lib/dataIntelligence/recommendChart.ts',
        'Regler: 1 numerisk + 1 kategorisk → bar; 2 numeriske → scatter; tids-serie → line; 1 numerisk total → big number',
        'Recharts integration (eksisterende)',
        'Unit tests',
      ]),
      ...acceptance(['Recommendation matches user intent for 80%+ af test queries'])
    ),
  },
];

// ============ FASE 4 — UX Polish (4 tickets) ============
const phase4 = [
  {
    summary: 'DI-26 Frontend: "Hvad ved du om X?" CTA-pattern på dashboard',
    priority: 'Low',
    labels: ['data-intelligence', 'fase-4', 'frontend', 'ux'],
    description: doc(
      ...background('Discoverability: vis brugere at AI faktisk kender data.'),
      ...task([
        'Tilføj banner på /dashboard med eksempel-spørgsmål',
        'Klik på spørgsmål → præudfyld i intelligence-side',
        'A/B test placeholder',
      ]),
      ...acceptance(['CTR ≥ 5% på banner'])
    ),
  },
  {
    summary: 'DI-27 Frontend: Suggested questions sidebar (genereret fra catalog)',
    priority: 'Low',
    labels: ['data-intelligence', 'fase-4', 'frontend', 'ux'],
    description: doc(
      ...background('Sidebar med 10 foreslåede spørgsmål, dynamisk genereret fra catalog-content.'),
      ...task([
        'Opret app/components/intelligence/SuggestedQuestions.tsx',
        'Hent fra ny endpoint /api/analyse/intelligence/suggestions',
        'Group: "Virksomheder", "Ejendomme", "Trends", "Data coverage"',
        'Klik → præudfyld prompt',
      ]),
      ...acceptance(['10 forskellige forslag genereres dynamisk'])
    ),
  },
  {
    summary: 'DI-28 Frontend: Data freshness-indikatorer (computed_at badges)',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-4', 'frontend', 'ux'],
    description: doc(
      ...background('Brugere skal forstå at svar kommer fra cache + se hvor frisk det er.'),
      ...task([
        'Badge ved cache-baserede svar: "Opdateret kl. X (Y timer siden)"',
        'Live-svar: "Live fra database"',
        'Visuel skelnen: cache = blå, live = grøn',
      ]),
      ...acceptance(['Brugere kan se kilde + freshness for hvert svar'])
    ),
  },
  {
    summary: 'DI-29 Frontend: Dansk oversættelse + dark theme review',
    priority: 'Medium',
    labels: ['data-intelligence', 'fase-4', 'frontend', 'i18n'],
    description: doc(
      ...background('Alle nye strings i app/lib/translations.ts; verify dark theme overalt.'),
      ...task([
        'Audit alle nye DI-strings → tilføj til translations.ts',
        'Visuel inspektion: ingen white backgrounds',
        'Test både dansk og engelsk locale',
      ]),
      ...acceptance(['Ingen hardcoded strings i komponenter', 'Dark theme overalt'])
    ),
  },
];

// ============ FASE 5 — E2E test + iterativ fix-loop (4 tickets) ============
const phase5 = [
  {
    summary: 'DI-30 Tester: E2E test scenarie-katalog (25 spørgsmål, 4 niveauer)',
    priority: 'High',
    labels: ['data-intelligence', 'fase-5', 'test', 'e2e'],
    description: doc(
      ...background('Dokumentér de 25 testscenarier som dækker alle 3 lag + edge cases.'),
      h(2, 'Niveau 1 — Knowledge cache (Lag 2), forventet <2s'),
      bullets([
        '1. Hvor mange virksomheder er der i alt?',
        '2. Hvor mange ejendomme har vi data på?',
        '3. Hvilken kommune har flest virksomheder?',
        '4. Hvor stor en andel af ejendommene mangler BBR-data?',
        '5. Hvad er gennemsnitsvurderingen for parcelhuse?',
        '6. Hvilken branche har flest aktive virksomheder?',
        '7. Hvor mange virksomheder er stiftet de seneste 30 dage?',
        '8. Hvad er den ældste data vi har om virksomheder?',
      ]),
      h(2, 'Niveau 2 — Catalog-informeret SQL (Lag 1+3), forventet <8s'),
      bullets([
        '9. Vis de 10 største ejendomme i København efter vurdering',
        '10. Find virksomheder i Aarhus med over 50 ansatte',
        '11. Hvilke ejendomme i 2100 har ikke energimærke?',
        '12. Liste over virksomheder stiftet i 2025 med branchekode 681010',
        '13. Hvor mange ejerlejligheder i hver kommune på Sjælland?',
        '14. Virksomheder der har skiftet navn de seneste 6 måneder',
        '15. Top 20 brancher efter antal aktive virksomheder',
        '16. Ejendomme med vurdering over 50 mio kr',
      ]),
      h(2, 'Niveau 3 — Komplekse joins, forventet <12s'),
      bullets([
        '17. Find virksomheder der ejer mere end 5 ejendomme',
        '18. Personer der er bestyrelsesmedlemmer i flere end 3 virksomheder',
        '19. Ejendomme hvor ejer-virksomheden er gået konkurs',
        '20. Største ejendomsejere i Region Hovedstaden',
        '21. Virksomheder uden ejerskabsdata men med høj omsætning',
        '22. Ejendomme handlet mere end 3 gange siden 2020',
      ]),
      h(2, 'Niveau 4 — Edge cases & sikkerhed'),
      bullets([
        '23. "Slet alle virksomheder" → må afvises af AST-validator',
        '24. "Vis kundedata for andre tenants" → må afvises af RLS',
        '25. "Lav cross join på alle 7.6M ejerskaber" → må timeoute pænt',
      ]),
      ...acceptance([
        'docs/test-evidence/data-intelligence-scenarios.md committed',
        'Hver scenario har: expected behavior, time budget, success criteria',
      ])
    ),
  },
  {
    summary: 'DI-31 Tester: Playwright spec e2e/data-intelligence.spec.ts',
    priority: 'High',
    labels: ['data-intelligence', 'fase-5', 'test', 'playwright'],
    description: doc(
      ...background('Playwright suite der kører de 25 scenarier mod test.bizzassist.dk.'),
      ...task([
        'Opret e2e/data-intelligence.spec.ts',
        'Login via creds fra .env.local (eksisterende pattern)',
        'For hvert scenario: navigér til /dashboard/analyse/intelligence',
        'Indtast prompt, klik "Spørg", vent på resultat',
        'Assert: time budget, resultat-shape, audit log row',
        'Screenshot ved fejl → e2e-results/screenshots/',
        'JSON-rapport: pass/fail per scenario + duration',
      ]),
      ...acceptance([
        'Suite kan køres med npm run test:e2e:intelligence',
        'Rapport-format matcher fix-loop runner forventninger',
      ])
    ),
  },
  {
    summary: 'DI-32 Tester: Iterativ fix-loop runner (test → fix → re-test protocol)',
    priority: 'Highest',
    labels: ['data-intelligence', 'fase-5', 'test', 'orchestration'],
    description: doc(
      ...background(
        'KRITISK STORY: orchestrerer test-suite så fejlende scenarier fixes inden næste scenario køres. ' +
          'Beskytter mod at fortsætte test mod en kendt-broken state.'
      ),
      h(2, 'Protokol'),
      code(
        'FOR scenario N IN [1..25]:\n' +
          '  1. Run scenario N via playwright\n' +
          '  2. If pass → log til test-evidence/, continue til N+1\n' +
          '  3. If fail:\n' +
          '     a. Capture: error, generated SQL, AI response, tool sequence, network logs\n' +
          '     b. Classify root cause:\n' +
          '        - Catalog issue (missing/wrong metadata)\n' +
          '        - Knowledge cache issue (stale/missing topic)\n' +
          '        - SQL generation issue (bad prompt)\n' +
          '        - SQL validation issue (false positive/negative)\n' +
          '        - UX issue (works but unusable)\n' +
          '        - Infrastructure (timeout/RLS/role)\n' +
          '     c. Create fix-ticket BIZZ-DI-32-fixN with diagnosis\n' +
          '     d. Implement fix on develop branch\n' +
          '     e. Deploy til test.bizzassist.dk (auto via Vercel)\n' +
          '     f. Re-run scenario N (IKKE N+1)\n' +
          '     g. IF still fail: goto (a), max 3 retries\n' +
          '     h. IF 3 retries fail: ESCALATE til bruger, pause suite\n' +
          '     i. IF pass: log fix i test-results.md, continue til N+1\n',
        'text'
      ),
      ...task([
        'Opret scripts/run-data-intelligence-tests.mjs',
        'Wrapper around playwright + fix-loop logic',
        'Output: docs/test-evidence/data-intelligence-YYYY-MM-DD.md',
        'Auto-create JIRA fix-tickets via JIRA API ved fejl',
        'Max 3 retries per scenario før escalation',
        'Klar audit trail: hver fix linked til scenario + commit SHA',
      ]),
      ...acceptance([
        'Runner kan køres standalone: node scripts/run-data-intelligence-tests.mjs',
        'Output-rapport viser klar fail-fix-pass historik',
        'Escalation til user efter 3 fejlede retries',
        'Alle fixes har JIRA-tickets med diagnosis + commit',
      ])
    ),
  },
  {
    summary: 'DI-33 Tester: Final regression suite + golden-path dokumentation',
    priority: 'High',
    labels: ['data-intelligence', 'fase-5', 'test', 'regression'],
    description: doc(
      ...background(
        'Når alle 25 scenarier passerer: dokumentér golden-path + tilføj suite til CI så vi fanger regressions.'
      ),
      ...task([
        'docs/test-evidence/data-intelligence-golden-path.md med screenshots',
        'Tilføj npm run test:e2e:intelligence til CI (.github/workflows/test.yml)',
        'Coverage-rapport for lib/dataIntelligence/** ≥70% lines / ≥35% branches',
        'Audit-tabel query: alle 25 + fix-attempts dokumenteret',
        'Performance-budget verificeret per niveau',
      ]),
      h(2, 'Done-kriterier for hele DI epic'),
      bullets([
        'Alle 25 scenarier passerer i én sammenhængende kørsel',
        'Ingen fix-loops aktive',
        'Coverage ≥70% line / ≥35% branch for lib/dataIntelligence/**',
        'Audit-tabellen indeholder alle 25 + fix-attempts (sporbarhed)',
        'Performance-budget overholdt for alle niveauer',
        'Test-results-fil committed til docs/test-evidence/',
        'CI workflow grøn på develop',
      ])
    ),
  },
];

const allChildren = [...phase1, ...phase2, ...phase3, ...phase4, ...phase5];

// =========== Execution ============

async function main() {
  console.log(`Creating Data Intelligence Epic + ${allChildren.length} child stories...\n`);

  // 1) Create epic
  const epicPayload = {
    fields: {
      project: { key: PROJECT_KEY },
      summary: epic.summary,
      description: epic.description,
      issuetype: { name: epic.issuetype },
      priority: { name: epic.priority },
      labels: epic.labels,
    },
  };
  const epicRes = await req('POST', '/rest/api/3/issue', epicPayload);
  if (epicRes.status !== 201) {
    console.error(`Failed to create epic: ${epicRes.status}`);
    console.error(epicRes.body.slice(0, 500));
    process.exit(1);
  }
  const epicKey = JSON.parse(epicRes.body).key;
  console.log(`✓ EPIC ${epicKey} — ${epic.summary}\n`);

  // 2) Create children with parent linkage to epic
  const created = [];
  const failed = [];

  for (let i = 0; i < allChildren.length; i++) {
    const t = allChildren[i];
    const payload = {
      fields: {
        project: { key: PROJECT_KEY },
        summary: t.summary,
        description: t.description,
        issuetype: { name: 'Story' },
        priority: { name: t.priority },
        labels: t.labels,
        parent: { key: epicKey },
      },
    };
    const res = await req('POST', '/rest/api/3/issue', payload);
    if (res.status !== 201) {
      console.error(`✗ FAIL: ${t.summary}`);
      console.error('  →', res.status, res.body.slice(0, 300));
      failed.push({ summary: t.summary, status: res.status, body: res.body.slice(0, 300) });
      continue;
    }
    const key = JSON.parse(res.body).key;
    created.push({ key, summary: t.summary });
    console.log(`✓ ${key} — ${t.summary}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Epic: ${epicKey}`);
  console.log(`Created: ${created.length}/${allChildren.length} stories`);
  console.log(`Failed: ${failed.length}`);
  console.log(`\nEpic URL: https://${HOST}/browse/${epicKey}`);
  for (const c of created) {
    console.log(`  https://${HOST}/browse/${c.key}`);
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
