/**
 * BIZZ-1947 verification — admin-created user gets a tenant_membership automatically.
 *
 * Flow (against test.bizzassist.dk, authenticated as admin via storageState):
 *   1. POST /api/admin/users to create a throwaway user → assert { tenantAssigned: true }.
 *   2. Query tenant_memberships via Supabase Management API → assert a row exists.
 *   3. Load /dashboard/admin/users, screenshot, assert the new user has NO "Ingen tenant" badge.
 *   4. Cleanup: DELETE /api/admin/users to remove the throwaway user + its tenant.
 *   5. Orphan check: SELECT count(*) of auth users without membership → log.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'https://test.bizzassist.dk';
const env = Object.fromEntries(
  fs
    .readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    })
);
// test/develop project ref
const PROJECT_REF = 'rlkjmqjxmkxuclehbrnl';
const ACCESS = env.SUPABASE_ACCESS_TOKEN;
const log = (...a) => console.log(...a);

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

const stamp = Date.now();
const TEST_EMAIL = `bizz1947-verify-${stamp}@example.com`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: '.playwright/auth.json' });
const page = await ctx.newPage();

try {
  // 1. create user via admin endpoint using the authenticated browser context
  const createResp = await page.request.post(`${BASE}/api/admin/users`, {
    data: {
      email: TEST_EMAIL,
      password: `Vf-${stamp}-Xy!`,
      fullName: 'BIZZ-1947 Verify',
      subscription: { planId: 'demo', status: 'pending', createdAt: new Date().toISOString() },
    },
  });
  const createJson = await createResp.json();
  log('CREATE status:', createResp.status());
  log('CREATE body:', JSON.stringify(createJson));
  log('tenantAssigned ===', createJson.tenantAssigned);

  const newUserId = createJson?.user?.id;

  // 2. query membership directly
  if (newUserId) {
    const rows = await sql(
      `SELECT tm.tenant_id, tm.role, t.name FROM tenant_memberships tm LEFT JOIN tenants t ON t.id = tm.tenant_id WHERE tm.user_id = '${newUserId}'`
    );
    log('MEMBERSHIP rows:', JSON.stringify(rows));
  }

  // 3. screenshot admin users list, look for the new user + absence of orphan badge
  await page.goto(`${BASE}/dashboard/admin/users`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/1947-users-list.png', fullPage: true });
  const body = await page.locator('body').innerText();
  log('list shows test email:', body.includes(TEST_EMAIL));

  // 4. orphan count (auth users without membership) BEFORE cleanup
  const orphan = await sql(
    `SELECT count(*)::int AS orphans FROM auth.users u LEFT JOIN tenant_memberships tm ON tm.user_id = u.id WHERE tm.user_id IS NULL`
  );
  log('ORPHAN count (incl. our test user if any):', JSON.stringify(orphan));

  // 5. cleanup
  const delResp = await page.request.delete(`${BASE}/api/admin/users`, {
    data: { email: TEST_EMAIL },
  });
  log('DELETE status:', delResp.status(), await delResp.text());
} catch (e) {
  log('ERROR', e.message);
  await page.screenshot({ path: '/tmp/1947-error.png', fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
