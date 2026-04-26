#!/usr/bin/env node
/**
 * Opretter Epic + 22 child-tickets for Domain Management (enterprise
 * dokumentautomatisering). Struktur:
 *   Fase 0 — ADR + data model
 *   Fase 1 — Super-admin Domain CRUD
 *   Fase 2 — Domain Admin (users + settings)
 *   Fase 3 — Templates + training material
 *   Fase 4 — Domain user shell + cases
 *   Fase 5 — AI generation pipeline
 *   Fase 6 — Governance (audit, GDPR, billing, E2E)
 *
 * Blocks-kæde: hver fases FØRSTE ticket blokeres af forrige fases SIDSTE.
 * Individuelle tickets inden for samme fase kan tages parallelt.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}

// ADF helpers
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });
const ol = (...i) => ({ type: 'orderedList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });

const doc = (...blocks) => ({ type: 'doc', version: 1, content: blocks });

// ─── Epic description ──────────────────────────────────────────────
const epicDesc = doc(
  h(2, 'Formål'),
  p(txt('Tilføj "Domain"-funktionalitet til BizzAssist: en enterprise-lagdeling ovenpå tenant-modellen der gør det muligt for større kunder (advokatfirmaer, ejendomsmæglere, revisorer, bankrådgivere) at uploade template-dokumenter, træne en AI-pipeline på deres interne eksempler/instruktioner, og lade deres ansatte generere udfyldte dokumenter på baggrund af sagsspecifikke uploads + BizzAssist-data (CVR, BBR, ejerskab mv).')),

  h(2, 'Brugs-scenarier'),
  ul(
    li(p(strong('Advokatfirma: '), txt('sagsbehandler uploader skøde + korrespondance, vælger "Købsaftale"-template, får udfyldt dokument med CVR-data, ejerskabsforhold, BBR-oplysninger automatisk indsat.'))),
    li(p(strong('Ejendomsmægler: '), txt('uploader salgsinformation, AI genererer vurderingsrapport + salgsbrochure med ejendomsdata og historik.'))),
    li(p(strong('Revisor: '), txt('uploader bogføringsdata + ledelsesprotokol, AI genererer årsrapport-udkast udfyldt med selskabsoplysninger fra CVR.'))),
  ),

  h(2, 'Rolle-model'),
  cb(
`super-admin (BizzAssist)  →  opretter Domain, tildeler første Domain Admin
domain_admin              →  administrerer Domain: users, templates, træning, indstillinger
domain_member             →  opretter sager, uploader sagsdokumenter, trigger AI-generering
(existing tenant roles er uændrede — Domain er parallel struktur)`
  ),

  h(2, 'Arkitektur — overordnet'),
  ul(
    li(p(strong('Ny public.domain-entitet: '), txt('parallel til tenant, men referer til owner_tenant_id for billing. Én tenant kan eje flere domains, men typisk 1:1.'))),
    li(p(strong('Membership-tabel: '), code('domain_member'), txt(' (user_id, domain_id, role). En bruger kan være medlem af flere domains (konsulent-case).'))),
    li(p(strong('Storage: '), txt('Supabase Storage buckets '), code('domain-templates'), txt(', '), code('domain-training'), txt(', '), code('domain-cases'), txt(', '), code('domain-generated'), txt('. Præfix '), code('{domain_id}/'), txt(' + RLS pr. sti.'))),
    li(p(strong('pgvector namespace: '), code('domain_{id}'), txt(' — følger eksisterende "namespace_[tenant_id]"-mønster fra CLAUDE.md for data-isolation.'))),
    li(p(strong('AI-pipeline: '), txt('Claude Opus + RAG over (template + instruktioner + eksempler + træningsdokumenter + case-dokumenter + BizzAssist-data). Output: udfyldt docx/pdf/markdown.'))),
    li(p(strong('Billing: '), txt('ny enterprise-plan; AI-tokens går gennem '), code('aiGate.assertAiAllowed'), txt(' (BIZZ-649-mønster) men med domain-scope i stedet for tenant-scope.'))),
  ),

  h(2, 'Fase-opdelt leverance'),
  ol(
    li(p(strong('Fase 0 — Foundation '), txt('(T-701 ADR + T-702 data model + T-703 auth gate). Etablerer grundlaget; intet user-visible endnu.'))),
    li(p(strong('Fase 1 — Super-admin CRUD '), txt('(T-704 to T-706). Vi kan oprette et Domain manuelt + tildele 1. Domain Admin.'))),
    li(p(strong('Fase 2 — Domain Admin '), txt('(T-707 to T-709). Domain Admin kan invitere brugere, redigere indstillinger.'))),
    li(p(strong('Fase 3 — Templates + træning '), txt('(T-710 to T-713). Upload + parsing + UI. Ingen AI endnu — rå storage.'))),
    li(p(strong('Fase 4 — Domain user shell '), txt('(T-714 to T-717). Menu, sags-oprettelse, case-dokument-upload.'))),
    li(p(strong('Fase 5 — AI-pipeline '), txt('(T-718 to T-720). Embedding, RAG-retrieval, Claude-prompt, docx-fill. MVP end-to-end.'))),
    li(p(strong('Fase 6 — Governance '), txt('(T-721 to T-723). Audit, GDPR-retention, billing/plan-gate, E2E + ISO 27001 review.'))),
  ),

  h(2, 'Data-model (udkast — fastlægges i T-702)'),
  cb(
`public.domain                   -- navn, slug, owner_tenant_id, status, settings jsonb, plan
public.domain_member            -- (domain_id, user_id, role 'admin'|'member')
public.domain_template          -- (domain_id, name, desc, file_path, instructions, examples jsonb,
                                --  placeholders jsonb, status, versioning)
public.domain_training_doc      -- (domain_id, name, file_path, doc_type, description)
public.domain_case              -- (domain_id, name, client_ref, status, created_by)
public.domain_case_doc          -- (case_id, name, file_path, file_type, extracted_text, uploaded_by)
public.domain_generation        -- (case_id, template_id, status, input_doc_ids[], output_path,
                                --  claude_tokens, user_prompt, timings, requested_by)
public.domain_embedding         -- (domain_id, source_type, source_id, chunk_text, vector(1536),
                                --  metadata) — pgvector, per-domain namespace
public.domain_audit_log         -- (domain_id, actor_user_id, action, target_id, metadata, ts)`,
    'sql'
  ),

  h(2, 'RLS-strategi'),
  ul(
    li(p(code('is_domain_admin(domain_id)'), txt(' + '), code('is_domain_member(domain_id)'), txt(' SECURITY DEFINER helpers (samme mønster som '), code('is_tenant_admin'), txt(').'))),
    li(p(txt('Super-admin: service_role bypasser RLS på '), code('domain'), txt('-tabeller; app_metadata.isAdmin check i API.'))),
    li(p(txt('Ingen cross-domain queries; every embedding-query MUST filter på '), code('domain_id'), txt(' (ISO 27001 A.13).'))),
  ),

  h(2, 'Storage-struktur'),
  cb(
`Supabase Storage:
  domain-templates/{domain_id}/{template_id}/source.{docx|pdf}
  domain-training/{domain_id}/{doc_id}/source.{docx|pdf|txt}
  domain-cases/{case_id}/{doc_id}/source.{docx|pdf|eml|msg}
  domain-generated/{generation_id}/output.{docx|pdf}

RLS per bucket:
  templates: read=domain_members, write=domain_admins only
  training:  read=domain_members, write=domain_admins only
  cases:     read+write=domain_members (case-scoped)
  generated: read=domain_members (scoped til opret-person + admin)`
  ),

  h(2, 'AI pipeline-design'),
  cb(
`GENERATION FLOW:
  [1] Bruger vælger: case_id + template_id + valgfri instruktions-tekst
  [2] Hent template: file + instructions + examples + placeholders
  [3] Vector search (pgvector, namespace=domain_{id}):
        top-k relevant træningsdokumenter + case-dokumenter
  [4] Hent BizzAssist-data for entities nævnt i case:
        CVR for virksomheder, BFE for ejendomme, person-navne
  [5] Claude Opus-kald: struktureret prompt med sections
        [TEMPLATE] [INSTRUKTIONER] [EKSEMPLER] [TRÆNING]
        [CASE-DOKUMENTER] [BIZZASSIST-DATA] [BRUGER-INPUT]
  [6] Output: udfyldt dokument i samme format som template
        (.docx: placeholder replacement via docxtemplater)
        (.pdf: generer fra markdown via pdfkit)
  [7] Gem i storage + domain_generation-række, trigger preview`
  ),

  h(2, 'GDPR + ISO 27001-overvejelser'),
  ul(
    li(p(strong('Data isolation: '), txt('alle queries filter på '), code('domain_id'), txt('; pgvector namespace pr. domain; separate Storage-prefixes.'))),
    li(p(strong('PII i uploads: '), txt('case-dokumenter kan indeholde personfølsomme oplysninger (kontrakter, mails). DPA udvidelse kræves; tilføj til '), code('app/privacy/page.tsx'), txt(' processor-list.'))),
    li(p(strong('Retention: '), txt('cases + generationer slettes automatisk efter N måneder (config pr. domain, default 24 mdr). Cron '), code('/api/cron/purge-old-data'), txt(' udvides.'))),
    li(p(strong('Sub-processors: '), txt('Anthropic (Claude) behandler case-data. Allerede i DPA via eksisterende AI-features — tilføj domain-afsnit.'))),
    li(p(strong('Export/delete: '), txt('Domain Admin kan eksportere alle domain-data; super-admin kan hard-delete et domain med cascade.'))),
  ),

  h(2, 'Billing'),
  ul(
    li(p(txt('Ny plan: '), code('enterprise_domain'), txt(' — månedlig base-fee + token-overage. Stripe product opsættes separat.'))),
    li(p(txt('AI-kald går gennem udvidet '), code('aiGate'), txt(' der tjekker domain-scope i stedet for tenant-scope når domain_id er sat.'))),
    li(p(txt('Domain deaktiveres hvis subscription bliver past_due (reuse af eksisterende grace-period-logik fra plan_configs).'))),
  ),

  h(2, 'Gradual rollout — skjul i produktion indtil release'),
  p(txt('Domain-feature skal ikke være synlig for kunder i produktion før vi er klar til launch. Det betyder at vi kan merge + deploye undervejs UDEN at kunder ser ufærdige features. Strategi:')),
  ul(
    li(p(strong('Feature flag '), code('NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED'), txt(' — sat til '), code('true'), txt(' i dev + test.bizzassist.dk, '), code('false'), txt(' (eller unset) i bizzassist.dk. Default-gate er '), code('false'), txt('.'))),
    li(p(strong('Hvad flag\'et skjuler: '), txt('"Domain"-menupunkt i main nav, '), code('/domain/**'), txt(' routes (returnerer 404 via middleware når disabled), super-admin "Domains"-menu, og invite-flow.'))),
    li(p(strong('Hvad er ALTID aktivt: '), txt('DB migrations (schema skal være klar i prod), RLS policies, cron-jobs der IKKE producerer user-facing output (retention cron kan køre, men rammer 0 rækker).'))),
    li(p(strong('Release-dag: '), txt('flip flag\'et til '), code('true'), txt(' i Vercel prod env + verify via E2E.'))),
  ),

  h(2, 'Milepæle & risiko'),
  ul(
    li(p(strong('MVP (Fase 0-5): '), txt('~3-4 uger arbejde — end-to-end demo med 1 kunde.'))),
    li(p(strong('Produktionsklar (Fase 6): '), txt('+1-2 uger til governance + ISO 27001 review.'))),
    li(p(strong('Risiko: '), txt('docx-placeholder-fill (docxtemplater edge cases), prompt-engineering for templates med komplekse strukturer, RAG-kvalitet på små træningskorpus.'))),
  ),

  h(2, 'Acceptance criteria for Epic som helhed'),
  ul(
    li(p(txt('Super-admin kan oprette et Domain og tildele Domain Admin i produktion.'))),
    li(p(txt('Domain Admin kan uploade en '), code('.docx'), txt('-template + 2 træningsdokumenter.'))),
    li(p(txt('Domain-bruger kan oprette en case, uploade 3 dokumenter, vælge template, og få en udfyldt '), code('.docx'), txt(' retur på <60s.'))),
    li(p(txt('Alle domain-data er isoleret: pentest eller manuel test bekræfter ingen cross-domain-lækage.'))),
    li(p(txt('GDPR sletning: delete-domain cascader til storage + embeddings + audit log.'))),
    li(p(code('npm test'), txt(' + '), code('npm run test:e2e'), txt(' grønne. Coverage ≥ 70% linjer på ny kode.'))),
  )
);

// ─── Child tickets ──────────────────────────────────────────────
const PHASES = [
  {
    phase: 0,
    name: 'Foundation',
    tickets: [
      {
        summary: 'Domain feature: ADR + design signoff',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Skriv Architecture Decision Record ('), code('docs/adr/ADR-XXX-domain-feature.md'), txt(') der dokumenterer alle designvalg før implementering starter. ALLE øvrige domain-tickets er blokeret indtil denne ADR er reviewed + signed af ARCHITECT.')),
          h(2, 'Scope — beslutninger der skal træffes'),
          ol(
            li(p(strong('Domain vs tenant: '), txt('parallel entitet vs feature-flag på eksisterende tenant. Forslag: parallel entitet med owner_tenant_id.'))),
            li(p(strong('Rolle-navne: '), code('domain_admin'), txt(' vs '), code('domain_owner'), txt('. Forslag: admin + member (keep it simple).'))),
            li(p(strong('Templates: .docx placeholder vs markdown-first. Forslag: .docx via docxtemplater (mest compatibility, bedst for slutbruger).'))),
            li(p(strong('Embeddings-provider: '), txt('OpenAI text-embedding-3-small vs Voyage AI vs Claude. Forslag: Voyage (optimeret til Claude) eller reuse eksisterende hvis pgvector allerede kører.'))),
            li(p(strong('docx-fill library: '), txt('docxtemplater (MIT) vs custom. Forslag: docxtemplater pro.'))),
            li(p(strong('Generation async eller sync? '), txt('Forslag: synchronous med streaming status (mest simpelt, <60s typisk).'))),
            li(p(strong('Namespace-strategi: '), code('domain_{id}'), txt(' vs '), code('d_{tenant_id}_{domain_slug}'), txt('. Forslag: '), code('domain_{uuid}'), txt(' (uuid er immutable).'))),
            li(p(strong('Case-struktur: '), txt('flat doc-liste vs hierarchic mapper. Forslag: flat + tagging MVP, hierarchic post-MVP.'))),
            li(p(strong('Data-retention default: '), txt('24 mdr for cases, permanent for templates/træning. Configureable pr. domain.'))),
          ),
          h(2, 'Leverance'),
          ul(
            li(p(code('docs/adr/ADR-XXX-domain-feature.md'), txt(' commit til main.'))),
            li(p(txt('Signoff fra ARCHITECT-agent dokumenteret i commit-besked.'))),
            li(p(txt('Alle downstream-tickets opdateres med endelige beslutninger.'))),
          ),
          h(2, 'Definition of Done'),
          ul(li(p(txt('ADR merged; ingen '), code('[TBD]'), txt('-markers tilbage; T-702 kan startes.'))))
        ),
        priority: 'High',
        labels: ['domain', 'architecture', 'adr', 'phase-0'],
      },
      {
        summary: 'Domain: database schema + migration (domain, member, template, training, case, case_doc, generation, embedding, audit_log)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Opret Supabase migration med alle 9 domain-tabeller + indexes + RLS policies + SECURITY DEFINER helpers. Byggesten for alle efterfølgende tickets.')),
          h(2, 'Tabeller'),
          cb(
`public.domain                (id, name, slug, owner_tenant_id, status, settings jsonb, plan, limits, created_by, timestamps)
public.domain_member         (domain_id, user_id, role, invited_by, invited_at, joined_at, UNIQUE pair)
public.domain_template       (domain_id, name, desc, file_path, file_type, instructions, examples jsonb, placeholders jsonb, status, version, created_by, timestamps)
public.domain_training_doc   (domain_id, name, file_path, doc_type, description, extracted_text, created_by, timestamps)
public.domain_case           (domain_id, name, client_ref, status, created_by, timestamps)
public.domain_case_doc       (case_id, name, file_path, file_type, extracted_text, uploaded_by, timestamps)
public.domain_generation     (case_id, template_id, status, input_doc_ids uuid[], output_path, claude_tokens, user_prompt, started_at, completed_at, requested_by)
public.domain_embedding      (domain_id, source_type, source_id, chunk_index, chunk_text, embedding vector(1536), metadata jsonb)
public.domain_audit_log      (domain_id, actor_user_id, action, target_type, target_id, metadata jsonb, created_at)`,
            'sql'
          ),
          h(2, 'RLS policies'),
          ul(
            li(p(code('is_domain_admin(uuid)'), txt(' + '), code('is_domain_member(uuid)'), txt(' SECURITY DEFINER helpers.'))),
            li(p(txt('Service role bypasser RLS på alle tabeller.'))),
            li(p(txt('Members kan READ domain + template + training_doc + audit_log (own domain).'))),
            li(p(txt('Admins kan ALL på alle tabeller (own domain).'))),
            li(p(txt('Members kan CRUD case + case_doc + generation hvor de er '), code('created_by'), txt('; admin ser alle.'))),
          ),
          h(2, 'Indexes'),
          ul(
            li(p(code('ix_domain_slug_unique'), txt(' på '), code('domain(slug)'), txt('.'))),
            li(p(code('ix_domain_member_user'), txt(' på '), code('(user_id, domain_id)'), txt('.'))),
            li(p(code('ix_domain_case_domain'), txt(' på '), code('(domain_id, status)'), txt('.'))),
            li(p(code('ivfflat'), txt(' index på '), code('domain_embedding.embedding'), txt(' (lists=100).'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Migration kører grønt på dev + preview + prod.'))),
            li(p(txt('RLS testet: user i Domain A ser ikke Domain B\'s templates/cases.'))),
            li(p(txt('Integration-test i '), code('__tests__/domain/schema.test.ts'), txt('.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'database', 'migration', 'phase-0'],
      },
      {
        summary: 'Domain: feature flag — skjul Domain-UI i produktion indtil launch',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Så vi kan merge + deploye alle domain-tickets til main/prod uden at slutkunder ser ufærdige features. Dev + test.bizzassist.dk viser feature\'en; prod skjuler den.')),
          h(2, 'Leverance'),
          cb(
`app/lib/featureFlags.ts
  isDomainFeatureEnabled(): boolean
    — returnerer true hvis NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED === 'true'
    — default false (altså skjult)
    — må IKKE kunne overrides client-side uden env-var

Vercel env vars:
  production  NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED=false (eller unset)
  preview     NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED=true
  development NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED=true
  test.bizzassist.dk (preview-alias) er dækket af preview-target.`,
            'typescript'
          ),
          h(2, 'Hvad flag\'et gater'),
          ul(
            li(p(strong('UI: '), txt('"Domain"-menupunkt i '), code('app/dashboard/layout.tsx'), txt(' + super-admin "Domains" i '), code('app/dashboard/admin/layout.tsx'), txt('.'))),
            li(p(strong('Routes: '), txt('middleware returnerer 404 for '), code('/domain/**'), txt(' og '), code('/dashboard/admin/domains/**'), txt(' når disabled.'))),
            li(p(strong('API: '), txt('alle '), code('/api/domain/**'), txt(' + '), code('/api/admin/domains/**'), txt(' returnerer 404 (ikke 403 — feature "findes ikke" for slutbruger).'))),
            li(p(strong('Invite-mails: '), txt('invite-flow disabled hvis flag er off.'))),
          ),
          h(2, 'Hvad er ALTID aktivt (uafhængigt af flag)'),
          ul(
            li(p(txt('Supabase migrations + schema (skal være klar i prod før flag vendes).'))),
            li(p(txt('RLS policies.'))),
            li(p(txt('Retention cron — kører, men rammer 0 rækker i prod når ingen domains findes endnu.'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('E2E på prod-lignende build med flag=false: '), code('/domain/test'), txt(' returnerer 404; "Domain"-menu er ikke i DOM; API returnerer 404.'))),
            li(p(txt('E2E på dev med flag=true: UI + routes + API virker normalt.'))),
            li(p(txt('Dokumenteret i '), code('docs/architecture/FEATURE_FLAGS.md'), txt(' med procedure for release-dag.'))),
            li(p(txt('Vercel env-vars verificeret i alle 3 targets (production/preview/development) — matcher memory '), code('reference_vercel_env_targets'), txt('.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'feature-flag', 'release-safety', 'phase-0'],
      },
      {
        summary: 'Domain: auth helpers (resolveDomainId, assertDomainAdmin, assertDomainMember) + Storage bucket setup',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Byg helpers der matcher eksisterende '), code('resolveTenantId()'), txt('-mønster men for domain-scope. Oprette 4 Supabase Storage buckets med RLS.')),
          h(2, 'Leverance'),
          cb(
`app/lib/domainAuth.ts
  resolveDomainId(request): { domain_id, role: 'admin'|'member' } | null
  assertDomainAdmin(domain_id): throws 403 hvis ikke admin
  assertDomainMember(domain_id): throws 403 hvis ikke member
  listUserDomains(user_id): Domain[]  — til main nav

app/lib/domainStorage.ts
  uploadTemplate(domain_id, file, opts)
  uploadTrainingDoc(domain_id, file, opts)
  uploadCaseDoc(case_id, file, opts)
  saveGeneration(generation_id, blob)
  getSignedUrl(path, ttl): string

supabase/storage:
  domain-templates   (private)
  domain-training    (private)
  domain-cases       (private)
  domain-generated   (private)
  RLS policies: member-read, admin-write pr. bucket
`,
            'typescript'
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Unit-tests for alle 3 assert-helpers dækker auth + non-member + admin-only routes.'))),
            li(p(txt('Manuel test: upload til bucket som member og admin — member får 403 på templates-bucket write.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'auth', 'storage', 'phase-0'],
      },
    ],
  },

  {
    phase: 1,
    name: 'Super-admin Domain CRUD',
    tickets: [
      {
        summary: 'Domain: super-admin UI — list/create/suspend domains (/dashboard/admin/domains)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Super-admin surface til at oprette nye Domain-kunder, vise liste, og suspendere/archivere.')),
          h(2, 'UI'),
          ul(
            li(p(code('/dashboard/admin/domains'), txt(' — tabel med navn, slug, owner_tenant, status, # members, # templates, # cases, created_at, actions.'))),
            li(p(code('/dashboard/admin/domains/new'), txt(' — form: navn, slug (auto-generer), owner_tenant (søg), plan-tier, ai_token_limit, retention_months.'))),
            li(p(code('/dashboard/admin/domains/[id]'), txt(' — detail + suspend/activate/archive/delete (med bekræftelse). Ses også metrics.'))),
          ),
          h(2, 'API'),
          cb(
`POST   /api/admin/domains              — create
GET    /api/admin/domains              — list alle
GET    /api/admin/domains/:id          — detail
PATCH  /api/admin/domains/:id          — update settings/plan
POST   /api/admin/domains/:id/suspend
POST   /api/admin/domains/:id/activate
DELETE /api/admin/domains/:id          — hard delete (cascade) — super-admin only`
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Kun users med '), code('app_metadata.isAdmin = true'), txt(' kan tilgå.'))),
            li(p(txt('Playwright E2E: login som super-admin, opret domain, suspend, activate, delete — stateful.'))),
            li(p(txt('Audit log entry pr. action.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'admin', 'ui', 'phase-1'],
      },
      {
        summary: 'Domain: assign + rotate Domain Admin (invite by email)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Super-admin skal kunne tildele en eller flere Domain Admins under create/detail-flow. Invite-by-email hvis user ikke findes endnu — Supabase invite magic link.')),
          h(2, 'Flow'),
          ol(
            li(p(txt('Super-admin på '), code('/dashboard/admin/domains/[id]'), txt(' → "Tildel Domain Admin" knap → email-input.'))),
            li(p(txt('Hvis user findes i '), code('auth.users'), txt(' med den email → direkte '), code('domain_member'), txt(' insert med role=admin.'))),
            li(p(txt('Hvis ikke → Supabase invite (auth.admin.inviteUserByEmail) + oprette pending '), code('domain_member'), txt(' row.'))),
            li(p(txt('Invite mail bruger Resend-skabelon med magic link til Domain Admin onboarding.'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Email-test: invite-modtager kan acceptere og lande på '), code('/domain/[id]/admin'), txt('.'))),
            li(p(txt('Kan rotere: fjerne admin-rolle, tildele til anden bruger.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'admin', 'invite', 'phase-1'],
      },
      {
        summary: 'Domain: plan/limits config — AI token-cap, retention, max users, max templates',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Super-admin skal kunne sætte hårde grænser pr. Domain: max AI-tokens/md, max users, max templates, retention-måneder.')),
          h(2, 'Leverance'),
          ul(
            li(p(txt('Schema-udvidelse: '), code('domain.limits'), txt(' jsonb.'))),
            li(p(txt('UI-editor i super-admin detail-siden.'))),
            li(p(txt('Enforcement i '), code('aiGate'), txt(' (domain-scope) + i invite-flow + i template-upload.'))),
            li(p(txt('Notification til Domain Admin ved 80% forbrug.'))),
          )
        ),
        priority: 'Medium',
        labels: ['domain', 'admin', 'billing', 'phase-1'],
      },
    ],
  },

  {
    phase: 2,
    name: 'Domain Admin',
    tickets: [
      {
        summary: 'Domain: /domain/[id]/admin layout + dashboard (user count, template count, recent activity)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Domain Admin landing-side + sub-nav struktur (Users | Templates | Training | Settings | Audit).')),
          h(2, 'UI'),
          ul(
            li(p(code('/domain/[id]/admin'), txt(' — dashboard med KPI-kort: users, templates, training-docs, cases i drift, AI-forbrug seneste 30d.'))),
            li(p(txt('Sub-nav for hver Domain Admin section.'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Kun '), code('domain_member WHERE role=admin'), txt(' kan tilgå.'))),
            li(p(txt('Admin af Domain A kan ikke se Domain B (RLS + UI-guard).'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'admin', 'ui', 'phase-2'],
      },
      {
        summary: 'Domain Admin: user management (invite, remove, role-toggle member↔admin)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Domain Admin skal kunne invitere nye brugere under Domain\'et (samme magic-link-flow som super-admin), promovere member→admin, fjerne members.')),
          h(2, 'UI'),
          ul(
            li(p(code('/domain/[id]/admin/users'), txt(' — tabel: email, rolle, joined_at, last_active, actions (fjern, promover).'))),
            li(p(txt('"Inviter bruger"-modal: email + rolle-valg.'))),
          ),
          h(2, 'Enforcement'),
          ul(
            li(p(txt('Respekterer '), code('domain.limits.max_users'), txt(' — disable invite-knap når limit nået.'))),
            li(p(txt('Kan ikke fjerne sig selv som sidste admin (fail-safe).'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'admin', 'users', 'phase-2'],
      },
      {
        summary: 'Domain Admin: settings editor (navn, retention, AI-preferences, branding)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Domain Admin redigerer domain-specifikke indstillinger inden for super-admin-tildelte grænser.')),
          h(2, 'Felter'),
          ul(
            li(p(strong('General: '), txt('display-navn, logo-upload (til generated docs), default-sprog.'))),
            li(p(strong('AI: '), txt('temperatur, preferred Claude-model (Sonnet vs Opus), custom system-prompt-suffix.'))),
            li(p(strong('Retention: '), txt('cases-retention (1-60 mdr, begrænset af super-admin-cap).'))),
            li(p(strong('Notifications: '), txt('hvilke events sender email, og til hvem.'))),
          ),
          h(2, 'Acceptance'),
          ul(li(p(txt('Ændringer audit-logges. UI viser "sidst opdateret af X"-badge pr. felt.'))))
        ),
        priority: 'Medium',
        labels: ['domain', 'admin', 'settings', 'phase-2'],
      },
    ],
  },

  {
    phase: 3,
    name: 'Templates + training material',
    tickets: [
      {
        summary: 'Domain: template upload API (.docx/.pdf/.txt) + text extraction + placeholder detection',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Upload endpoint for templates med parsing-pipeline der: (1) gemmer i Storage, (2) udtrækker tekst (mammoth for docx, pdf-parse for pdf), (3) auto-detekterer placeholders ('), code('{{navn}}'), txt(', '), code('[[CVR]]'), txt('), (4) skaber '), code('domain_template'), txt('-row.')),
          h(2, 'API'),
          cb(
`POST /api/domain/[id]/templates
  body: multipart (file + name + description)
  response: { template_id, placeholders: [...], extracted_text_preview }

GET  /api/domain/[id]/templates
PATCH /api/domain/[id]/templates/:tpl_id   — rediger metadata
DELETE /api/domain/[id]/templates/:tpl_id`
          ),
          h(2, 'Placeholder-syntax'),
          p(txt('Understøtter: '), code('{{felt}}'), txt(', '), code('{felt}'), txt(', '), code('[FELT]'), txt('. Detektor returnerer liste med positions + kontekst så UI kan vise preview.')),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Upload af eksempel-.docx → detekterer ≥ 90% af placeholders korrekt (test-suite med 5 eksempel-skabeloner).'))),
            li(p(txt('Storage-path: '), code('domain-templates/{domain_id}/{template_id}/source.docx'), txt('.'))),
            li(p(txt('File-size cap: 20 MB; MIME-validation; ClamAV-scan (hvis eksisterende).'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'templates', 'upload', 'phase-3'],
      },
      {
        summary: 'Domain: template editor UI — metadata, instruktioner, eksempler, placeholder-review',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Domain Admin UI til at tilføje instruktioner + eksempler + placeholder-beskrivelser efter upload. Disse bruges af AI-pipelinen (Fase 5).')),
          h(2, 'UI'),
          ul(
            li(p(code('/domain/[id]/admin/templates'), txt(' — liste.'))),
            li(p(code('/domain/[id]/admin/templates/[tpl_id]'), txt(' — editor:'))),
            li(p(ul(
              li(p(txt('Tab "Fil" — preview af docx (mammoth → HTML render).'))),
              li(p(txt('Tab "Instruktioner" — rich-text editor: hvordan AI skal udfylde skabelonen.'))),
              li(p(txt('Tab "Eksempler" — upload 0-5 udfyldte eksempler (brugt som few-shot prompting).'))),
              li(p(txt('Tab "Placeholders" — list, pr. placeholder: navn, beskrivelse, data-kilde-hint (f.eks. "brug CVR-lookup for virksomhedsnavn").'))),
              li(p(txt('Tab "Versioner" — history + rollback.'))),
            ))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'templates', 'ui', 'phase-3'],
      },
      {
        summary: 'Domain: training doc upload + management (separat fra templates)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Træningsdokumenter er kontekst-materiale AI\'en bruger ved enhver generering i domain\'et (interne guidelines, fagterminologi, juridiske præcedenser). Separeret fra templates fordi de ikke er output-skabeloner.')),
          h(2, 'Leverance'),
          ul(
            li(p(code('/domain/[id]/admin/training'), txt(' — upload + liste + edit + delete.'))),
            li(p(txt('Doc-typer: guide, policy, reference, example. Tag-baseret filtrering.'))),
            li(p(txt('Same parse-pipeline som case-docs: text extraction → '), code('extracted_text'), txt('-kolonne.'))),
          ),
          h(2, 'Acceptance'),
          ul(li(p(txt('Upload af 10 MB .pdf træningsdokument → parses + gemmes < 10s; Storage + DB row oprettet.'))))
        ),
        priority: 'Medium',
        labels: ['domain', 'training', 'upload', 'phase-3'],
      },
      {
        summary: 'Domain: template versioning + archive/rollback',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Når en admin re-uploader eller redigerer en skabelon, bevar tidligere version (audit + rollback). Max 10 versioner pr. template, ældste auto-purges.')),
          h(2, 'Schema'),
          cb(
`domain_template_version (
  id, template_id, version, file_path,
  instructions, examples, placeholders,
  created_by, created_at, note
)`,
            'sql'
          ),
          h(2, 'Acceptance'),
          ul(li(p(txt('Rollback til version N opdaterer '), code('domain_template'), txt(' + regenererer embeddings.'))))
        ),
        priority: 'Low',
        labels: ['domain', 'templates', 'versioning', 'phase-3'],
      },
    ],
  },

  {
    phase: 4,
    name: 'Domain user shell + cases',
    tickets: [
      {
        summary: 'Domain: "Domain"-menu i main nav (conditional, badge hvis flere domains)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Hvis indlogget bruger er medlem af ≥ 1 domain, vis "Domain"-menu i main nav. Hvis flere domains: dropdown med valg.')),
          h(2, 'Implementering'),
          ul(
            li(p(strong('Feature-flag-gate: '), txt('nav-item rendrer KUN hvis '), code('isDomainFeatureEnabled()'), txt(' fra T-703 er '), code('true'), txt('. I prod (flag=false) er menuen usynlig uanset membership.'))),
            li(p(txt('Hook: '), code('useUserDomains()'), txt(' kalder '), code('GET /api/domain/mine'), txt(', cache 5 min.'))),
            li(p(txt('Nav-item rendrer kun hvis '), code('flag === true && domains.length > 0'), txt('.'))),
            li(p(txt('Single domain → direkte link '), code('/domain/[id]'), txt('; multi → dropdown.'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Ikke-medlemmer ser INGEN "Domain"-menu (ingen ghost-tab).'))),
            li(p(txt('Admin af 2 domains ser dropdown med begge.'))),
            li(p(strong('Prod-safety: '), txt('verificeret at menuen er usynlig på '), code('bizzassist.dk'), txt(' også for brugere der ER domain-members (flag er kilde til synlighed, ikke membership).'))),
          )
        ),
        priority: 'Medium',
        labels: ['domain', 'user', 'navigation', 'phase-4'],
      },
      {
        summary: 'Domain: user dashboard /domain/[id] — cases liste + "opret sag"-knap',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Landing for domain-bruger. Viser egne + delte cases, med status, template-progress, seneste aktivitet.')),
          h(2, 'UI'),
          ul(
            li(p(code('/domain/[id]'), txt(' — liste/grid af cases (søgbar, filtrér på status + dato).'))),
            li(p(code('/domain/[id]/new-case'), txt(' — form: navn, client-referencen, beskrivelse.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'user', 'ui', 'phase-4'],
      },
      {
        summary: 'Domain: case detail + case-doc upload (.docx/.pdf/.eml/.msg/.txt)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Case-siden hvor bruger uploader sagsdokumenter. Drag-and-drop, batch-upload, preview.')),
          h(2, 'UI'),
          ul(
            li(p(code('/domain/[id]/case/[case_id]'), txt(' — doc-liste + drag-upload-zone + "Generer dokument"-knap (Fase 5).'))),
            li(p(txt('Preview: docx → HTML via mammoth; pdf → inline viewer; eml/msg → header + body render.'))),
            li(p(txt('Rediger sag-metadata inline (navn, status, client-ref, notes).'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Upload op til 50 MB pr. fil; max 50 filer pr. case. Progress + error handling.'))),
            li(p(txt('Soft-delete af docs (recover inden for 30 dage); hard-delete af case cascader til storage.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'user', 'cases', 'phase-4'],
      },
      {
        summary: 'Domain: worker til text extraction fra uploaded docs (docx, pdf, eml, msg)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Async parsing der fylder '), code('extracted_text'), txt('-kolonne så AI-pipelinen (Fase 5) kan bruge indholdet uden at re-parse ved hver generation.')),
          h(2, 'Teknik'),
          ul(
            li(p(code('mammoth'), txt(' for .docx, '), code('pdf-parse'), txt(' for .pdf, '), code('mailparser'), txt(' for .eml, '), code('msgreader'), txt(' for .msg.'))),
            li(p(txt('Trigger: post-upload webhook / database trigger / cron-driven pull.'))),
            li(p(txt('Ved fejl: status='), code('parse_failed'), txt(' + fejl-note; bruger ser "kunne ikke parse" badge men kan stadig bruge filen som attachment.'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('99% af upload-formater parses inden for 30s.'))),
            li(p(txt('Unit-tests med eksempel-filer dækker alle 4 formater + corrupted file.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'parsing', 'worker', 'phase-4'],
      },
    ],
  },

  {
    phase: 5,
    name: 'AI generation pipeline',
    tickets: [
      {
        summary: 'Domain: embedding-worker — chunk + embed templates + training + case-docs til domain_embedding',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Bygger vektor-indeks pr. domain. Triggered ved upload/edit af template, training, case-doc. Genanvender text-extraction fra T-717.')),
          h(2, 'Strategi'),
          ul(
            li(p(strong('Chunking: '), txt('800 tokens, 100 token overlap. Semantic splitting hvis muligt (paragraph boundaries).'))),
            li(p(strong('Embedder: '), txt('beslutning i T-701 ADR. Default-antagelse: OpenAI text-embedding-3-small (1536 dim, billig, pålidelig). Fallback til Voyage voyage-3.'))),
            li(p(strong('Namespace: '), code('domain_{uuid}'), txt(' — enforced via RLS på '), code('domain_embedding.domain_id'), txt('.'))),
            li(p(strong('Incremental: '), txt('re-embedder kun ændrede chunks (hash-compare). Delete embeddings for slettede docs.'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Upload af 100-siders træningsdoc → embeddet inden for 60s.'))),
            li(p(txt('pgvector ivfflat-index ram < 5 ms per query for top-10.'))),
            li(p(txt('Cross-domain query-test: namespace-filter forhindrer data-leak.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'ai', 'embedding', 'phase-5'],
      },
      {
        summary: 'Domain: retrieval + prompt builder — template + RAG + BizzAssist-data composer',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Orchestrerer hvad der sendes til Claude: template-body, instruktioner, eksempler, relevant træning (vector search), relevante case-docs (vector search eller alle), og BizzAssist-data (CVR + BBR + ejerskab + salgshistorik) for entities nævnt i case.')),
          h(2, 'Flow'),
          ol(
            li(p(txt('Load template (file + instructions + examples + placeholders).'))),
            li(p(txt('Load case-docs (alle hvis < 20k tokens; ellers vector-top-k).'))),
            li(p(txt('Vector search på træningsdoc-embeddings, k=5-10 chunks.'))),
            li(p(txt('Entity-extraction fra case-docs: CVR-numre, BFE-numre, person-navne. Hit BizzAssist APIs for hver.'))),
            li(p(txt('Composer: strukturér sections i Claude-prompt. Token-budget-aware (Opus ~200k context).'))),
          ),
          h(2, 'Leverance'),
          cb(
`app/lib/domainPromptBuilder.ts
  buildGenerationContext(opts: {
    case_id, template_id, user_instructions?
  }): {
    template: TemplateContext,
    training_chunks: Chunk[],
    case_docs: DocContext[],
    bizzassist_data: EntityData[],
    total_tokens: number
  }`,
            'typescript'
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('For 3 realistiske test-sager: builder leverer relevant kontekst + under 150k tokens total.'))),
            li(p(txt('Unit-tests for entity-extraction (CVR 8-cifret, BFE 5-10-cifret).'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'ai', 'retrieval', 'phase-5'],
      },
      {
        summary: 'Domain: generation API + docx placeholder-fill + preview + download',
        desc: doc(
          h(2, 'Formål'),
          p(txt('End-to-end generation: POST start → Claude call → docx-output → storage + preview UI.')),
          h(2, 'API'),
          cb(
`POST /api/domain/[id]/case/[case_id]/generate
  body: { template_id, user_instructions? }
  response (streaming): progress events + final { generation_id, output_path, preview_url }

GET  /api/domain/[id]/generation/:gen_id  — metadata + preview
GET  /api/domain/[id]/generation/:gen_id/download  — signed URL til docx/pdf`
          ),
          h(2, 'docx-fill'),
          p(txt('Brug '), code('docxtemplater'), txt(' (beslutning i T-701). Claude-output er struktureret JSON: '), code('{ placeholders: { navn: "...", cvr: "...", ... }, sections: [{ heading, body }] }'), txt('. Templater fylder placeholders. Sections vises i UI som rediger-bar tekst inden download.')),
          h(2, 'UI'),
          ul(
            li(p(code('/domain/[id]/case/[case_id]'), txt(' — "Generer dokument"-modal: vælg template + user-instruktion.'))),
            li(p(txt('Progress-bar med streaming status (embedding, retrieval, claude-call, docx-fill).'))),
            li(p(code('/domain/[id]/generation/[gen_id]'), txt(' — preview + rediger + re-generate + download.'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('E2E: upload template + case-doc → generate → docx downloadet med placeholders udfyldt korrekt (manual test-template med 10 placeholders, ≥ 9/10 rigtige).'))),
            li(p(txt('Performance: p50 < 45s, p95 < 90s for 5-siders output.'))),
            li(p(txt('Error handling: Claude timeout, token-cap nået, docx-fill fejl → pæne fejl til UI.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'ai', 'generation', 'docx', 'phase-5'],
      },
    ],
  },

  {
    phase: 6,
    name: 'Governance',
    tickets: [
      {
        summary: 'Domain: audit log UI + export (who uploaded/generated what, when)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Domain Admin surface til at se alle handlinger i Domain\'et (for compliance + forensics).')),
          h(2, 'UI'),
          ul(
            li(p(code('/domain/[id]/admin/audit'), txt(' — filtrerbar tabel (actor, action, dato, target).'))),
            li(p(txt('CSV-export.'))),
          ),
          h(2, 'Actions der logges'),
          cb(
`create_case, delete_case, upload_case_doc, delete_case_doc,
upload_template, edit_template, delete_template, rollback_template,
upload_training, delete_training,
invite_user, remove_user, change_role,
generate_document, download_generation,
change_settings`
          ),
          h(2, 'Acceptance'),
          ul(li(p(txt('Alle phase-1..5 actions findes i audit log 100% dækning (integration-test).'))))
        ),
        priority: 'Medium',
        labels: ['domain', 'audit', 'governance', 'phase-6'],
      },
      {
        summary: 'Domain: GDPR retention + hard delete (cron + admin-tool)',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Automatisk purge af cases og generations der er ældre end domain.retention_months. Plus admin-trigger for on-demand delete-all (GDPR ret til sletning).')),
          h(2, 'Leverance'),
          ul(
            li(p(code('/api/cron/domain-retention'), txt(' — dagligt: slet cases + case_docs + generations + audit_logs ældre end cap.'))),
            li(p(code('DELETE /api/admin/domains/:id'), txt(' — cascade: storage buckets + embeddings + alle rækker.'))),
            li(p(code('POST /api/domain/:id/admin/export-all'), txt(' — zip af alle data for domain (GDPR portabilitet).'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Cron-dry-run test: identificerer korrekt mængde ældre rækker, ingen yngre.'))),
            li(p(txt('Storage cleanup verificeret via '), code('supabase storage list'), txt(' efter delete.'))),
            li(p(txt('Export-zip indeholder templates, cases, generations, audit log — ingen andres data.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'gdpr', 'retention', 'phase-6'],
      },
      {
        summary: 'Domain: Stripe enterprise plan + AI-token-metering + ISO 27001 review',
        desc: doc(
          h(2, 'Formål'),
          p(txt('Wire domain-features bag Stripe enterprise-plan. AI-kald går gennem '), code('aiGate.assertAiAllowed'), txt(' med domain-scope. Final ISO 27001-review før GA.')),
          h(2, 'Leverance'),
          ul(
            li(p(txt('Ny plan: '), code('enterprise_domain'), txt(' (Stripe product + price). Feature-flag '), code('plan.features.domain'), txt('.'))),
            li(p(code('aiGate'), txt(' udvides med '), code('domainId'), txt('-param; per-domain token-counting til '), code('domain_generation.claude_tokens'), txt('.'))),
            li(p(txt('ISO 27001-review: data isolation (A.13), access control (A.9), incident response (A.16), sub-processor DPA-liste i '), code('app/privacy'), txt('.'))),
            li(p(txt('Penetration-test: attacker i Domain A prøver at tilgå Domain B via URL manipulation, header injection, JWT replay.'))),
            li(p(txt('Dokumentation i '), code('docs/security/DOMAIN_SECURITY.md'), txt('.'))),
          ),
          h(2, 'Acceptance'),
          ul(
            li(p(txt('Stripe webhook mod enterprise-plan tester aktivering/deaktivering af domain-features.'))),
            li(p(txt('ISO 27001 review signed af CODE REVIEWER + ARCHITECT (release-gate #1 + #2).'))),
            li(p(txt('E2E-suite grønt. Coverage ≥ 70% linjer på ny domain-kode.'))),
          )
        ),
        priority: 'High',
        labels: ['domain', 'billing', 'iso27001', 'phase-6'],
      },
    ],
  },
];

// ─── 1. Create epic ────────────────────────────────────────────────
console.log('→ Creating Epic...');
const epicRes = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    issuetype: { name: 'Epic' },
    priority: { name: 'High' },
    summary: 'Domain Management — enterprise document automation (templates + AI-fill + case workspace)',
    labels: ['domain', 'enterprise', 'ai', 'epic'],
    description: epicDesc,
  },
});
if (epicRes.status !== 201) {
  console.error('epic fail:', epicRes.status, epicRes.body.slice(0, 500));
  process.exit(1);
}
const EPIC = JSON.parse(epicRes.body).key;
console.log(`✅ Epic created: ${EPIC}`);

// ─── 2. Create child tickets pr. fase + collect keys ─────────────────
const created = []; // [{ phase, key, summary }]

for (const phase of PHASES) {
  console.log(`\n→ Fase ${phase.phase} — ${phase.name}`);
  for (const t of phase.tickets) {
    const res = await req('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: PROJECT },
        issuetype: { name: 'Task' },
        priority: { name: t.priority },
        summary: t.summary,
        labels: t.labels,
        description: t.desc,
        parent: { key: EPIC },
      },
    });
    if (res.status !== 201) {
      console.log(`  ❌ fail: ${res.status} ${res.body.slice(0, 200)}`);
      continue;
    }
    const key = JSON.parse(res.body).key;
    console.log(`  ✅ ${key} — ${t.summary.slice(0, 80)}`);
    created.push({ phase: phase.phase, key, summary: t.summary });
  }
}

// ─── 3. Blocks-kæde: sidste ticket i fase N blokerer første i fase N+1 ──
console.log('\n→ Linking blocks-chain mellem faser...');
for (let ph = 0; ph < PHASES.length - 1; ph++) {
  const thisPhase = created.filter((c) => c.phase === ph);
  const nextPhase = created.filter((c) => c.phase === ph + 1);
  if (!thisPhase.length || !nextPhase.length) continue;
  const blocker = thisPhase[thisPhase.length - 1];
  const blocked = nextPhase[0];
  const lr = await req('POST', '/rest/api/3/issueLink', {
    type: { name: 'Blocks' },
    inwardIssue: { key: blocked.key },
    outwardIssue: { key: blocker.key },
  });
  console.log(
    lr.status === 201
      ? `  🔗 ${blocker.key} blocks ${blocked.key} (Fase ${ph} → ${ph + 1})`
      : `  ⚠️ link ${blocker.key}→${blocked.key} status=${lr.status}`
  );
}

// ─── 4. Summary ────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`Done. Epic: ${EPIC} — https://${HOST}/browse/${EPIC}`);
console.log(`Total child tickets: ${created.length}`);
for (const phase of PHASES) {
  const keys = created.filter((c) => c.phase === phase.phase).map((c) => c.key).join(', ');
  console.log(`  Fase ${phase.phase} — ${phase.name}: ${keys}`);
}
