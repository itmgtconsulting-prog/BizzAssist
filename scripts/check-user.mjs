/**
 * Diagnostic script — check a specific user's Supabase auth state.
 * Usage: node scripts/check-user.mjs jajr@hpproperties.dk
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local manually
const envPath = join(__dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [
        l.slice(0, idx).trim(),
        l
          .slice(idx + 1)
          .trim()
          .replace(/^["']|["']$/g, ''),
      ];
    })
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const email = process.argv[2] || 'jajr@hpproperties.dk';
console.log(`\nChecking user: ${email}\n`);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// List users and find by email
const { data: usersData, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });

if (listErr) {
  console.error('listUsers error:', listErr.message);
  process.exit(1);
}

const user = usersData?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());

if (!user) {
  console.log('❌  User NOT found in auth.users');
  process.exit(0);
}

console.log('✅  User found in auth.users');
console.log('   id:              ', user.id);
console.log('   email:           ', user.email);
console.log('   email_confirmed: ', user.email_confirmed_at ?? 'NOT confirmed');
console.log('   created_at:      ', user.created_at);
console.log('   last_sign_in:    ', user.last_sign_in_at ?? 'never');
console.log('   role:            ', user.role);

console.log('\n── app_metadata ──────────────────────────────────');
console.log(JSON.stringify(user.app_metadata, null, 2));

console.log('\n── user_metadata ─────────────────────────────────');
console.log(JSON.stringify(user.user_metadata, null, 2));

console.log('\n── identities (login providers) ──────────────────');
if (!user.identities?.length) {
  console.log('   (none — no linked OAuth providers)');
} else {
  user.identities.forEach((id) => {
    console.log(`   provider: ${id.provider}  |  created: ${id.created_at}`);
  });
}

// Check tenant memberships in DB
console.log('\n── tenant memberships ────────────────────────────');
const { data: memberships, error: memErr } = await admin
  .from('tenant_memberships')
  .select('tenant_id, role, created_at')
  .eq('user_id', user.id);

if (memErr) {
  console.log('   (could not fetch — table may not exist or RLS blocked):', memErr.message);
} else if (!memberships?.length) {
  console.log('   ❌  No tenant memberships found');
} else {
  memberships.forEach((m) => {
    console.log(`   tenant_id: ${m.tenant_id}  role: ${m.role}  created: ${m.created_at}`);
  });
}

const sub = user.app_metadata?.subscription;
console.log('\n── subscription summary ──────────────────────────');
if (!sub) {
  console.log('   ❌  No subscription in app_metadata');
} else {
  console.log('   planId: ', sub.planId ?? '(none)');
  console.log('   status: ', sub.status ?? '(none)');
  console.log('   approvedAt:', sub.approvedAt ?? 'not approved');
}

console.log('\nDone.\n');
