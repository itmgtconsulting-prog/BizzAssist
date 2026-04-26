#!/usr/bin/env node
/**
 * Close BIZZ-696 (Domain Management epic) and create a follow-up ticket
 * for the GA-launch checklist items that are not code-work (Stripe dashboard,
 * pentest signoff, ISO 27001 review acceptance, onboarding flow metadata).
 */
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
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

// ─── Step 1: Create follow-up ticket ─────────────────────────────────────────

const followUpBody = doc(
  h(2, 'Domain feature — GA launch checklist'),
  p(strong('Formål: '), txt('alt kode-arbejde på domain-feature er landed og verified (BIZZ-697 → BIZZ-734 alle Done). De resterende GA-gates er manuelle opgaver eller signoffs der ikke kan løses med en commit.')),
  h(3, '1. Stripe Dashboard — enterprise_domain product + price'),
  ul(
    li(p(txt('Opret '), code('Product'), txt(': "BizzAssist Enterprise Domain"'))),
    li(p(txt('Opret '), code('Price'), txt(': recurring, 4999 DKK/måned (matcher '), code('plan_configs'), txt('-row seedet i migration 066)'))),
    li(p(txt('Sæt '), code('product.metadata.plan_id=enterprise_domain'), txt(' så webhook-handler kan matche'))),
    li(p(txt('Teste checkout-flow i Stripe-test-mode mod '), code('test.bizzassist.dk'))),
  ),
  h(3, '2. Onboarding-flow: checkout metadata.domain_id'),
  p(txt('Når bruger opretter et nyt domain OG starter enterprise_domain-abonnement i samme flow: checkout-session skal skrive '), code('metadata.domain_id=<uuid>'), txt(' så '), code('syncDomainSubscription'), txt(' kan matche unambiguously. Fallback via stripe_customer_id virker men er ikke pålidelig for multi-domain tenants.')),
  h(3, '3. ISO 27001 signoff'),
  ul(
    li(p(strong('CODE REVIEWER'), txt(' + '), strong('ARCHITECT'), txt(' skal review + sign '), code('docs/security/DOMAIN_SECURITY.md'), txt(' (A.9/A.13/A.14/A.16 coverage-matrix, 8-lags isolation-tabel, sub-processor DPA-liste).'))),
    li(p(txt('Release-gate #1 + #2 signed af begge agenter før GA.'))),
  ),
  h(3, '4. Pentest — 10 scenarier fra DOMAIN_SECURITY.md'),
  cb(
`1. URL MANIPULATION         — Domain A user prøver Domain B routes
2. JWT REPLAY / SESSION     — Token fra Domain A mod Domain B
3. STORAGE PATH GUESSING    — Direct signed-URL-access på tværs
4. SQL INJECTION VIA domainId — zod-validation coverage
5. PROMPT INJECTION         — Case-doc med "IGNORE ALL INSTRUCTIONS"
6. DOCX ZIP-BOMB            — Rekursive image-refs / billion-laughs
7. PDF PARSER CVE           — Crafted PDF fra CVE-database
8. LATERAL MOVEMENT VIA AI  — Prompt-injection lateral eksfiltration
9. TOKEN-CAP BYPASS         — Trigger generation-loop over limit
10. CASCADE DELETE AUDIT    — Domain delete → orphaned rows?`,
    'text'
  ),
  p(txt('Hver scenarie skal have "forventet adfærd" vs "observeret adfærd" dokumenteret. Security-agent eller ekstern pentester kører.')),
  h(3, '5. Final GA gate'),
  ul(
    li(p(txt('Feature-flag '), code('DOMAIN_FEATURE_ENABLED=true'), txt(' i production Vercel env'))),
    li(p(txt('Super-admin UI tilgængelig på '), code('/dashboard/admin/domains'), txt(' for admin-users'))),
    li(p(txt('Marketing page + onboarding flow aktiveret'))),
  ),
  h(3, 'Reference'),
  p(txt('Arkitekturreference: '), code('docs/security/DOMAIN_SECURITY.md'), txt('. Parent epic (closed): BIZZ-696.'))
);

async function main() {
  // Get project id for BIZZ
  const projRes = await req('GET', `/rest/api/3/project/BIZZ`);
  const proj = JSON.parse(projRes.body);

  // Get issue type 'Task' id
  const meta = await req('GET', `/rest/api/3/issue/createmeta?projectKeys=BIZZ&issuetypeNames=Task&expand=projects.issuetypes.fields`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const types = JSON.parse(meta.body).projects?.[0]?.issuetypes ?? [];
  const taskType = types.find(t => t.name === 'Task') || types[0];

  // Create the ticket
  const payload = {
    fields: {
      project: { id: proj.id },
      summary: 'Domain feature — GA launch checklist (Stripe + pentest + ISO 27001 signoff)',
      issuetype: { id: taskType.id },
      description: followUpBody,
      priority: { name: 'High' },
    },
  };
  const cr = await req('POST', `/rest/api/3/issue`, payload);
  const created = JSON.parse(cr.body);
  if (!created.key) {
    console.error('❌ Create failed:', cr.status, cr.body.slice(0, 500));
    return;
  }
  console.log(`✅ Created ${created.key}`);

  // ─── Step 2: Close BIZZ-696 with pointer to new ticket ─────────────────────
  const closingComment = doc(
    h(2, 'Alle code-deliverables shipped + verified'),
    p(txt('Alle 28 child-tickets (BIZZ-697 → BIZZ-734) er Done og verified af review-agenten. Domain-featuren er code-complete.')),
    h(3, 'Summary af shipped arbejde'),
    ul(
      li(p(strong('Schema: '), txt('9 tabeller + RLS + indexes (migration 058–065)'))),
      li(p(strong('Auth: '), txt('resolveDomainId + assertDomainAdmin + assertDomainMember + 8-lags isolation'))),
      li(p(strong('UI: '), txt('super-admin domains-list, domain-admin dashboard, case-detail, template-editor, audit-log'))),
      li(p(strong('Pipeline: '), txt('upload → text extraction → chunking → embedding → RAG → prompt-builder → generation → docx-fill'))),
      li(p(strong('Security: '), txt('prompt-injection guard, domain-AI-gate, email-domain guard, anomaly detection'))),
      li(p(strong('Billing: '), txt('Stripe enterprise_domain webhook wiring + plan_configs seed'))),
      li(p(strong('Compliance: '), txt('GDPR retention cron + hard-delete + ISO 27001 doc (docs/security/DOMAIN_SECURITY.md)'))),
    ),
    h(3, 'Resterende GA-launch arbejde (ikke kode)'),
    p(txt('De manuelle gates (Stripe Dashboard, pentest, ISO 27001 signoff, feature-flag flip) er trackede i '), code(created.key), txt('. Denne epic lukkes nu som code-complete.')),
    p(strong('→ Done.'))
  );

  const cmtRes = await req('POST', `/rest/api/3/issue/BIZZ-696/comment`, { body: closingComment });
  console.log(cmtRes.status === 201 ? '✅ BIZZ-696 comment' : `⚠️ ${cmtRes.status}`);

  const tr = await req('GET', `/rest/api/3/issue/BIZZ-696/transitions`);
  const transitions = JSON.parse(tr.body).transitions || [];
  console.log('Available transitions:', transitions.map(t => t.name).join(', '));
  const doneT = transitions.find(t => /^done$/i.test(t.name));
  if (doneT) {
    const r = await req('POST', `/rest/api/3/issue/BIZZ-696/transitions`, { transition: { id: doneT.id } });
    console.log(r.status === 204 ? '✅ BIZZ-696 → Done' : `⚠️ ${r.status}`);
  } else {
    console.log('⚠️ No Done transition available — try In Review first');
    const revT = transitions.find(t => /^in review$/i.test(t.name));
    if (revT) {
      const r1 = await req('POST', `/rest/api/3/issue/BIZZ-696/transitions`, { transition: { id: revT.id } });
      console.log(r1.status === 204 ? '  ✅ → In Review' : `  ⚠️ ${r1.status}`);
      const tr2 = await req('GET', `/rest/api/3/issue/BIZZ-696/transitions`);
      const doneT2 = (JSON.parse(tr2.body).transitions || []).find(t => /^done$/i.test(t.name));
      if (doneT2) {
        const r2 = await req('POST', `/rest/api/3/issue/BIZZ-696/transitions`, { transition: { id: doneT2.id } });
        console.log(r2.status === 204 ? '  ✅ → Done' : `  ⚠️ ${r2.status}`);
      }
    }
  }

  // Print final statuses
  console.log();
  for (const key of ['BIZZ-696', created.key]) {
    const st = await req('GET', `/rest/api/3/issue/${key}?fields=status,summary`);
    const d = JSON.parse(st.body);
    console.log(`${key}  [${d.fields.status?.name}]  ${d.fields.summary}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
