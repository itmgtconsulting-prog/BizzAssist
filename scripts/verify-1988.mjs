/**
 * BIZZ-1988 verifikation — server-side modul-håndhævelse (ServerModuleGate).
 *
 * Beviser at modul-adgang nu håndhæves SERVER-side og er koblet til
 * plan/addon-entitlement, generisk for alle moduler/planer:
 *   1. DENY  — non-admin, aktiv, tom plan + tomme addons → redirect ?locked
 *   2. ALLOW (addon) — samme bruger + addon → siden loader
 *   3. ALLOW (plan)  — addon fjernet, modul lagt i plan.modules → siden loader
 *   4. ADMIN — admin-bruger bypasser → siden loader
 *   5. API   — kandidater-API returnerer 403 i deny-state, 200 i allow-state
 *
 * Opretter en midlertidig non-admin testbruger i test-env (rlkjmqjxmkxuclehbrnl)
 * og rydder op til sidst (slet bruger + membership + nulstil testplan3.modules).
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '/tmp/_v1988.env' });
config({ path: '/root/BizzAssist/.env.local' });

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE;
const BASE = 'https://test.bizzassist.dk';
const MODULE_URL = `${BASE}/dashboard/analyse/virksomhedshandler`;
const TENANT_ID = '77ecf1fb-33a7-4372-9c7d-9ebe0b76169a'; // eksisterende tenant (kun for membership)
const TEST_PLAN = 'testplan3';
const EMAIL = `verify-1988-${Date.now()}@bizztest.local`;
const PASS = `Vf!${Math.random().toString(36).slice(2)}Aa9`;

const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

const results = [];
let userId = null;

/**
 * Sæt subscription-state på testbrugeren (frisk app_metadata læses server-side).
 * `isPaid: true` gør abonnementet funktionelt, så den klient-side SubscriptionGate
 * (betalings-overlay) IKKE skjuler siden — vi isolerer dermed modul-entitlement.
 */
async function setSub({ addons = [], planId = TEST_PLAN }) {
  await sb.auth.admin.updateUserById(userId, {
    app_metadata: {
      isAdmin: false,
      subscription: { planId, status: 'active', isPaid: true, addons },
    },
  });
}

/** Sæt testplan3.modules (plan-coupling). */
async function setPlanModules(mods) {
  const { error } = await sb.from('plan_configs').update({ modules: mods }).eq('plan_id', TEST_PLAN);
  if (error) console.log('  plan_configs update fejl:', error.message);
}

// Distinktive markører for hvad siden faktisk renderer (server-gated children).
const MODULE_MARKER = 'AI-drevet detektion af ejerskabsændringer'; // M&A-radar undertitel
const UPSELL_MARKER = 'er ikke inkluderet i dit abonnement'; // ServerModuleGate upsell

/**
 * Login (frisk context) + naviger til modul-siden. Returnér hvilken UI der
 * renderede (modul-indhold vs. upsell) + API-status med brugerens cookies.
 */
async function gotoModule(browser, email, pass) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', pass);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 30000 });
  await page.goto(MODULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Vent på at SubscriptionGate har tjekket + ServerModuleGate-children er hydreret.
  await page
    .waitForFunction(
      (m) => document.body.innerText.includes(m.module) || document.body.innerText.includes(m.upsell),
      { module: MODULE_MARKER, upsell: UPSELL_MARKER },
      { timeout: 15000 }
    )
    .catch(() => {});
  await page.waitForTimeout(1000);
  const finalUrl = page.url();
  const body = await page.evaluate(() => document.body.innerText);
  const rendersModule = body.includes(MODULE_MARKER);
  const rendersUpsell = body.includes(UPSELL_MARKER);
  // API-check med brugerens session-cookies.
  let apiStatus = null;
  try {
    const r = await page.request.get(`${BASE}/api/virksomhedshandler/kandidater?limit=1`);
    apiStatus = r.status();
  } catch (e) {
    apiStatus = `err:${e.message}`;
  }
  return { ctx, page, finalUrl, apiStatus, rendersModule, rendersUpsell };
}

try {
  // ── Opret testbruger + membership ────────────────────────────────────────
  const { data: created, error: ce } = await sb.auth.admin.createUser({
    email: EMAIL,
    password: PASS,
    email_confirm: true,
    user_metadata: { onboarding_complete: true },
    app_metadata: { isAdmin: false, subscription: { planId: TEST_PLAN, status: 'active', addons: [] } },
  });
  if (ce) throw new Error('createUser: ' + ce.message);
  userId = created.user.id;
  const { error: me } = await sb
    .from('tenant_memberships')
    .insert({ tenant_id: TENANT_ID, user_id: userId, role: 'tenant_member' });
  if (me) throw new Error('membership insert: ' + me.message);
  await setPlanModules([]);
  console.log('temp user:', EMAIL, userId);

  const browser = await chromium.launch({ headless: true });

  // ── 1. DENY (tom plan + tomme addons) ────────────────────────────────────
  {
    await setSub({ addons: [] });
    const { ctx, page, apiStatus, rendersModule, rendersUpsell } = await gotoModule(
      browser,
      EMAIL,
      PASS
    );
    await page.screenshot({ path: '/root/BizzAssist/scripts/verify-1988-1-deny.png' });
    console.log('1 DENY     upsell:', rendersUpsell, '| module:', rendersModule, '| api:', apiStatus);
    results.push(['DENY viser upsell (server-gated)', rendersUpsell]);
    results.push(['DENY skjuler modul-indhold', !rendersModule]);
    results.push(['DENY api 403', apiStatus === 403]);
    await ctx.close();
  }

  // ── 2. ALLOW via addon ───────────────────────────────────────────────────
  {
    await setSub({ addons: ['virksomhedshandler'] });
    const { ctx, page, apiStatus, rendersModule, rendersUpsell } = await gotoModule(
      browser,
      EMAIL,
      PASS
    );
    await page.screenshot({ path: '/root/BizzAssist/scripts/verify-1988-2-addon.png' });
    console.log('2 ADDON    module:', rendersModule, '| upsell:', rendersUpsell, '| api:', apiStatus);
    results.push(['ADDON viser modul-indhold', rendersModule]);
    results.push(['ADDON api 200', apiStatus === 200]);
    await ctx.close();
  }

  // ── 3. ALLOW via plan.modules ────────────────────────────────────────────
  {
    await setSub({ addons: [] });
    await setPlanModules(['virksomhedshandler']);
    const { ctx, page, apiStatus, rendersModule, rendersUpsell } = await gotoModule(
      browser,
      EMAIL,
      PASS
    );
    await page.screenshot({ path: '/root/BizzAssist/scripts/verify-1988-3-plan.png' });
    console.log('3 PLAN     module:', rendersModule, '| upsell:', rendersUpsell, '| api:', apiStatus);
    results.push(['PLAN.modules viser modul-indhold', rendersModule]);
    results.push(['PLAN api 200', apiStatus === 200]);
    await ctx.close();
  }

  // ── 4. ADMIN bypass ──────────────────────────────────────────────────────
  {
    const { ctx, page, apiStatus, rendersModule } = await gotoModule(
      browser,
      process.env.E2E_TEST_EMAIL,
      process.env.E2E_TEST_PASS
    );
    await page.screenshot({ path: '/root/BizzAssist/scripts/verify-1988-4-admin.png' });
    console.log('4 ADMIN    module:', rendersModule, '| api:', apiStatus);
    results.push(['ADMIN viser modul-indhold (bypass)', rendersModule]);
    await ctx.close();
  }

  await browser.close();
} catch (e) {
  console.error('FEJL:', e.message);
  results.push(['exception', false]);
} finally {
  // ── Oprydning ────────────────────────────────────────────────────────────
  try {
    await setPlanModules([]);
    if (userId) {
      await sb.from('tenant_memberships').delete().eq('user_id', userId);
      await sb.auth.admin.deleteUser(userId);
      console.log('oprydning: bruger + membership slettet, testplan3 nulstillet');
    }
  } catch (e) {
    console.log('oprydnings-fejl:', e.message);
  }
}

console.log('\n── RESULTAT ──');
let ok = true;
for (const [name, pass] of results) {
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name);
  if (!pass) ok = false;
}
console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
process.exit(ok ? 0 : 1);
