#!/usr/bin/env node
/**
 * Create follow-up tickets identified during BIZZ-641 implementation.
 *
 * Creates 3 tickets:
 *  1. UI-handling af 402 trial_ai_blocked + købs-knap i AIChatPanel
 *  2. Token dekrement-rækkefølge + balance-visning (plan→bonus→topUp)
 *  3. Tenant-scoped migrations (040 ai_feedback_log + 043 notification_preferences) apply til eksisterende tenants
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
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

// ADF builders
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const tickets = [
  {
    summary: 'AI Chat UI: surface 402 trial_ai_blocked med CTA til token-pakke-køb',
    priority: 'High',
    labels: ['ai-tokens', 'billing', 'ui', 'frontend'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          txt('BIZZ-641 indførte backend-gate i '),
          code('/api/ai/chat'),
          txt(
            ' (commit 3855ac8) der returnerer 402 Payment Required med en custom payload når bruger er i trial uden token-pakke:'
          )
        ),
        ul(
          li(p(code("code: 'trial_ai_blocked'"))),
          li(p(code("cta: 'buy_token_pack'"))),
          li(
            p(
              code(
                "error: 'AI-tokens er låst indtil dit abonnement starter. Køb en token-pakke for at bruge AI nu.'"
              )
            )
          )
        ),
        p(
          txt('AIChatPanel-komponenten håndterer ikke specielt denne 402 i dag — den viser kun den generiske error-besked som almindelig fejlmarkering.')
        ),
        h(2, 'Mål'),
        p(
          txt(
            'Når AI-chat får 402 med code=trial_ai_blocked, skal UI vise en tydelig "Køb token-pakke"-CTA der fører til eksisterende token-pakke-checkout.'
          )
        ),
        h(2, 'Leverancer'),
        ul(
          li(
            p(
              strong('Response-håndtering i AIChatPanel.tsx: '),
              txt('parse '),
              code('response.body'),
              txt(' når status=402. Hvis '),
              code('body.code === "trial_ai_blocked"'),
              txt(' → render en dedikeret banner i stedet for error-toast')
            )
          ),
          li(
            p(
              strong('Banner UI: '),
              txt(
                'Tydelig amber/blue advarsel øverst i chat-panelet med besked + primary-button "Køb token-pakke" + secondary-link "Opgrader til betalt plan"'
              )
            )
          ),
          li(
            p(
              strong('CTA-flow: '),
              txt('Primary-knap linker til '),
              code('/dashboard/settings/billing'),
              txt(' → token-pakke-sektion (eller direkte Stripe checkout for den billigste pakke via '),
              code('/api/stripe/create-topup-checkout'),
              txt(')')
            )
          ),
          li(
            p(
              strong('Balance-display: '),
              txt('Når bruger har topUpTokens > 0 vises de i chat-UI'),
              txt(' ("Du har '),
              code('X'),
              txt(' tokens tilbage fra din token-pakke") så brugeren ved hvor mange de har')
            )
          ),
          li(
            p(
              strong('i18n: '),
              txt('Begge sprog DA + EN via '),
              code('app/lib/translations.ts')
            )
          )
        ),
        h(2, 'Acceptkriterier'),
        ul(
          li(p(txt('Bruger på trial uden token-pakke ser banner med Køb-knap — ikke en generisk fejl-toast'))),
          li(p(txt('Klik på Køb-knap åbner Stripe Checkout for token-pakke (eller billing-side)'))),
          li(p(txt('Bruger med topUpTokens > 0 ser balancen i chat-UI'))),
          li(p(txt('Bilingual DA + EN'))),
          li(p(txt('Banner forsvinder når brugeren har købt pakken og resten af token-flowet fungerer'))),
        ),
        h(2, 'Relateret'),
        ul(
          li(p(txt('BIZZ-641 — backend-gate (Done)'))),
          li(
            p(
              code('app/components/AIChatPanel.tsx'),
              txt(' — skal opdateres')
            )
          ),
          li(
            p(
              code('app/api/stripe/create-topup-checkout/route.ts'),
              txt(' — eksisterende Stripe checkout-endpoint til token-pakker')
            )
          ),
          li(p(code('app/dashboard/settings/billing'), txt(' — billing-side hvor token-pakker listes'))),
        ),
      ],
    },
  },
  {
    summary:
      'AI token-dekrement: implementér prioritets-rækkefølge plan→bonus→topUp og vis balance pr. kilde',
    priority: 'Medium',
    labels: ['ai-tokens', 'billing', 'backend'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          txt(
            'BIZZ-641 tilføjede topUpTokens til effectiveTokenLimit, men selve dekrementerings-rækkefølgen når AI forbruger tokens er ikke eksplicit defineret:'
          )
        ),
        ul(
          li(p(strong('Plan-tokens'), txt(' — månedlig quota fra subscription (nulstilles hver måned)'))),
          li(p(strong('bonusTokens'), txt(' — manuelt tildelt af admin (fx som kompensation)'))),
          li(p(strong('topUpTokens'), txt(' — selvstændigt købt via token-pakke (carry over, udløber ikke)'))),
        ),
        p(
          txt(
            'I dag summeres alle tre i effectiveTokenLimit og tokensUsedThisMonth sammenlignes mod total. Men vi tracker ikke hvilken kilde der dekrementeres først. Det matters for:'
          )
        ),
        ul(
          li(p(txt('Brugerens forståelse af "hvor mange tokens har jeg tilbage pr. kilde"'))),
          li(p(txt('Månedsskift: plan-tokens nulstilles, men købte topUpTokens skal overleve'))),
          li(p(txt('Refund-scenarier hvor en token-pakke annulleres — vi skal vide hvor mange af pakkens tokens der faktisk er brugt'))),
        ),
        h(2, 'Foreslået prioritets-rækkefølge'),
        ul(
          li(p(strong('1. Plan-tokens først'), txt(' — "use it or lose it" fordi de nulstilles månedligt'))),
          li(p(strong('2. bonusTokens'), txt(' — manuelt givet, ingen udløb, men admin-granted så bør bruges næst'))),
          li(p(strong('3. topUpTokens sidst'), txt(' — bruger har betalt direkte, skal have mest værdi per krone'))),
        ),
        h(2, 'Teknisk plan'),
        ul(
          li(
            p(
              strong('Dekrement-logik: '),
              txt('Efter AI-kald, træk '),
              code('totalUsed'),
              txt(' fra app_metadata.subscription i rækkefølge: planRemaining → bonusRemaining → topUpRemaining. Gem de 3 felter separat.')
            )
          ),
          li(
            p(
              strong('Schema-ændring: '),
              txt(
                'Behold tokensUsedThisMonth som aggregate, men track også '
              ),
              code('planTokensUsed, bonusTokensUsed, topUpTokensUsed'),
              txt(' separat i app_metadata.subscription')
            )
          ),
          li(
            p(
              strong('Månedsskift: '),
              txt('Cron/webhook der nulstiller '),
              code('planTokensUsed = 0'),
              txt(' den 1. i måneden — påvirker ikke bonus/topUp')
            )
          ),
          li(
            p(
              strong('API-response: '),
              txt('Inkluder '),
              code('{ planRemaining, bonusRemaining, topUpRemaining }'),
              txt(' i AI-chat response så UI kan vise balance pr. kilde')
            )
          ),
        ),
        h(2, 'Acceptkriterier'),
        ul(
          li(p(txt('Tokens trækkes i rækkefølge plan → bonus → topUp, verificeret via test med alle 3 kilder'))),
          li(p(txt('Månedsskift nulstiller kun plan-quota, bevarer bonus + topUp'))),
          li(p(txt('UI viser balance pr. kilde ("Plan: X, Bonus: Y, Købt: Z")'))),
          li(p(txt('Unit-tests for hver dekrement-sti'))),
          li(p(txt('Backwards-compat med eksisterende subscriptions der kun har tokensUsedThisMonth'))),
        ),
        h(2, 'Relateret'),
        ul(
          li(p(code('app/api/ai/chat/route.ts'), txt(' — recordTenantTokenUsage + effectiveTokenLimit-beregning'))),
          li(p(code('app/api/stripe/webhook/route.ts'), txt(' — handleTokenTopUp der skriver topUpTokens'))),
          li(p(code('app/lib/subscriptions.ts'), txt(' — Subscription type + helpers'))),
          li(p(txt('BIZZ-641 — backend-gate der etablerede topUpTokens-læsningen'))),
        ),
      ],
    },
  },
  {
    summary:
      'Migrations 040 + 043: apply tenant-scoped schemas til eksisterende tenants på test + prod',
    priority: 'Medium',
    labels: ['database', 'migration', 'tenant-schema'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Baggrund'),
        p(
          txt(
            'Migrations 040 (ai_feedback_log) og 043 (notification_preferences) definerer tenant-scoped tabeller — én per tenant i deres eget '
          ),
          code('tenant_<id>'),
          txt('-schema. Fra 2026-04-20 migration-sweep blev disse springet over på test + prod fordi de bruger '),
          code('tenant.'),
          txt('-prefix der ikke matcher vores per-tenant pattern.')
        ),
        h(2, 'Konkret situation (2026-04-20)'),
        ul(
          li(p(strong('Dev: '), txt('Har literal '), code('tenant'), txt('-schema, så begge migrations kørt som-er ✅'))),
          li(p(strong('Test: '), txt('~10 tenants i tenant_<id>-schemaer. Migration 040/043 ikke applied på nogen.'))),
          li(p(strong('Prod: '), txt('~10 tenants i tenant_<id>-schemaer. Migration 040/043 ikke applied på nogen.'))),
        ),
        h(2, 'Løsning'),
        p(
          txt('Opdatér '),
          code('provision_tenant_schema'),
          txt('-funktionen til at oprette '),
          code('ai_feedback_log'),
          txt(' + '),
          code('notification_preferences'),
          txt(' som del af tenant-provisioning, OG kør backfill-script der opretter tabellerne i alle eksisterende tenant-skemaer.')
        ),
        h(2, 'Tasks'),
        ul(
          li(
            p(
              strong('1. Udvid provision_tenant_schema'),
              txt(' (SQL-funktion) med CREATE TABLE IF NOT EXISTS for de to tabeller — idempotent')
            )
          ),
          li(
            p(
              strong('2. Backfill-script: '),
              txt('Iterér '),
              code("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_%'"),
              txt(' og kør CREATE TABLE-DDL for hver')
            )
          ),
          li(
            p(
              strong('3. RLS-policies: '),
              txt('Anvend samme pattern som eksisterende tenant-tabeller ('),
              code('is_tenant_member + can_tenant_write + is_tenant_admin'),
              txt(')')
            )
          ),
          li(
            p(
              strong('4. Kør på test + prod'),
              txt(' via Management API (Supabase access token + /v1/projects/{ref}/database/query)')
            )
          ),
          li(
            p(
              strong('5. Verificér: '),
              txt('Probe '),
              code("SELECT to_regclass('tenant_<id>.ai_feedback_log')"),
              txt(' for hver tenant — skal returnere ikke-null')
            )
          ),
          li(
            p(
              strong('6. Opdatér '),
              code('scripts/run-migrations.mjs'),
              txt(' så 040/043 ikke længere er skipped på test/prod')
            )
          ),
        ),
        h(2, 'Acceptkriterier'),
        ul(
          li(p(txt('Alle tenant-schemaer på test + prod har ai_feedback_log + notification_preferences'))),
          li(p(txt('RLS-policies er aktive og verified via insert-test med forkert tenant_id → afvises'))),
          li(p(txt('Nye tenants får tabellerne automatisk via updated provision_tenant_schema'))),
          li(p(txt('Backfill-script er committed så det kan genbruges ved fremtidige tenant-scoped migrations'))),
        ),
        h(2, 'Relateret'),
        ul(
          li(
            p(
              code('supabase/migrations/040_ai_feedback_log.sql'),
              txt(' — template med '),
              code('tenant.'),
              txt('-prefix')
            )
          ),
          li(
            p(
              code('supabase/migrations/043_notification_preferences.sql'),
              txt(' — dokumentations-migration (CREATE TABLE-block er commented ud)')
            )
          ),
          li(p(code('scripts/run-migrations.mjs'), txt(' — migration-runner med 040/043 skipped på test/prod'))),
          li(p(txt('BIZZ-237 (AI feedback log) — oprindelig ticket for migration 040'))),
          li(p(txt('BIZZ-273 (Notification preferences) — oprindelig ticket for migration 043'))),
        ),
      ],
    },
  },
];

for (const t of tickets) {
  const payload = {
    fields: {
      project: { key: 'BIZZ' },
      summary: t.summary,
      issuetype: { id: '10003' },
      priority: { name: t.priority },
      labels: t.labels,
      description: t.description,
    },
  };
  const r = await req('POST', '/rest/api/3/issue', payload);
  if (r.status === 201) {
    const key = JSON.parse(r.body).key;
    console.log(`✅ Oprettet: ${key} — ${t.summary}`);
  } else {
    console.log(`❌ HTTP ${r.status}`);
    console.log(r.body.slice(0, 400));
  }
}
