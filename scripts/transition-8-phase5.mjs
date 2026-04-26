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

const plainBody = (text) => ({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function postAndTransition(key, text, target) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: plainBody(text) });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => new RegExp(`^${target}$`, 'i').test(x.name));
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → ${target}` : `  ⚠️ ${r.status}`);
  }
}

// PASS → Done
await postAndTransition('BIZZ-715',
  'Code-review PASS. Commit c8def44. app/lib/domainEmbeddingWorker.ts:47-140 med chunk-hash sammenligning + incremental logic. REAL HTTP calls: OpenAI text-embedding-3-small (domainEmbed.ts:58) + Voyage voyage-3-lite (linje 84). NoEmbeddingProviderError graceful skip hvis API keys mangler. Ikke mocked. Transitioned til Done.',
  'Done');

await postAndTransition('BIZZ-717',
  'Code-review PASS. Commit aae613e. Generation API: REAL Anthropic SDK call (route.ts:170,195) med claude-opus-4-6. docxtemplater integration (pizzip + docxtemplater imports linje 56-66, mustache {{}} delimiters, doc.render call). Download route eksisterer. Prompt-injection guard wired in (parseGenerationOutput linje 212, scanSuspiciousContent 154, audit-log 157-164). Token gate kaldes 329. SSE streaming deferred til follow-up — synchronous POST acceptabel for MVP. Transitioned til Done.',
  'Done');

await postAndTransition('BIZZ-733',
  'Code-review PASS. Commit 8a709c7. isolation.integration.test.ts:179-345 — describe.skip er FJERNET, alle 6 A-tests (A1-A6) er nu real auth tests: A1 SELECT 9 tabeller (282-302), A2 INSERT reject (305-311), A3 UPDATE 0 rows (314-321), A4 DELETE 0 rows (323-329), A5 inherited RLS via case (331-337), A6 admin no escalation (340-344). beforeAll opretter 2 real users via admin API, signer ind med password, authenticated JWT bruges. Gated bag INTEGRATION=1 env. Transitioned til Done.',
  'Done');

await postAndTransition('BIZZ-734',
  'Code-review PASS. BIZZ-717 shipment aktiverede guard end-to-end: PROMPT_INJECTION_GUARD_SUFFIX appendes i system-prompt via domainPromptBuilder.ts:253-254, Claude-kaldet inkluderer context.system_prompt (route.ts:198). scanSuspiciousContent kaldes 154 + audit-log 157-164. parseGenerationOutput med strict Zod-schema 212 før docx-fill. Alle 3 lag (suffix + scan + validation) aktive. Transitioned til Done.',
  'Done');

// PARTIAL → To Do
await postAndTransition('BIZZ-685',
  'Code-review PARTIAL. Commit c32d82f. Kun owner-name enrichment implementeret (via lokal ejf_ejerskab lookup i salgshistorik/route.ts:430-477). Priser (kontantKoebesum, samletKoebesum) er STADIG null. Commit-besked noterer eksplicit: "Price rows remain null until Tinglysning enrichment ticket". CVR→Tinglysning dokument-opslag + reverse-inference (fra min udvidede plan) IKKE implementeret. MANGLER: /soegvirksomhed/cvr opslag pr. historisk CVR + /dokaktuel/uuid/{uuid} XML-parse for KontantKoebesum + reverse-inference person-exit-pris = successor-CVR-entry-pris. Transitioned til To Do.',
  'To Do');

await postAndTransition('BIZZ-693',
  'Code-review PARTIAL. Samme commit c32d82f som BIZZ-685 — kun owner-name enrichment. Priser stadig null på Kaffevej 31 1.tv. Se BIZZ-685 for fuld mangelliste. Transitioned til To Do.',
  'To Do');

await postAndTransition('BIZZ-716',
  'Code-review PARTIAL. Commit 9449ab8. buildGenerationContext implementeret med vector search via match_domain_embeddings RPC + entity extraction (CVR/BFE regex) + token budgeting + PROMPT_INJECTION_GUARD_SUFFIX. MEN: BizzAssist entity-data enrichment (kald til /api/cvr-public, /api/bbr, /api/ejerskab for hver entity) er eksplicit deferred via docstring "caller may decide whether to hit CVR/BBR APIs". Det betyder bizzassist_data-array returneres tomt — generation-pipelinen får ikke CVR/BBR/ejerskab-data ind i prompten. Ticket krævede denne enrichment. MANGLER: implementer enrichWithBizzData() helper + kald den i buildGenerationContext. Transitioned til To Do.',
  'To Do');

await postAndTransition('BIZZ-720',
  'Code-review PARTIAL. Commit cc892e4. Domain AI-gate komplet (domainAiGate.ts:32-84 tjekker ai_tokens_used vs limits.max_tokens_per_month, wired i generation route 329). ISO 27001 doc reel i docs/security/DOMAIN_SECURITY.md med A.9, A.13, A.16 dækning + sub-processor DPA-liste. MEN: Stripe webhook-integration IKKE wired. Commit-besked noterer "Stripe wiring remains manual" — ny enterprise_domain plan + webhook til at sync limits ind i domain.limits er ikke implementeret. MANGLER: Stripe product/price oprettelse + stripe/webhook route update til at matche enterprise_domain plan → set domain.limits ved subscription-ændring. Transitioned til To Do.',
  'To Do');

console.log('\nDone.');
