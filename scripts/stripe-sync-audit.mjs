/**
 * Stripe ⇄ Supabase sync audit (BIZZ-543).
 *
 * Cross-checks every Supabase auth user that has a `stripe_subscription_id`
 * against Stripe's authoritative subscription state. Reports mismatches —
 * cases where Stripe says past_due / unpaid / canceled but our app_metadata
 * still says active (or vice versa).
 *
 * Motivation:
 *   Webhooks can be missed (endpoint misconfigured events, transient 500s,
 *   stale supabase_user_id references). This script is the belt-and-braces
 *   that catches drift before a paying customer loses access or a non-paying
 *   one retains it.
 *
 * Modes:
 *   (default, dry-run)  Reports mismatches only. No writes.
 *   --fix               Applies corrections to Supabase app_metadata + writes
 *                       an audit_log entry per fix.
 *
 * Usage:
 *   node scripts/stripe-sync-audit.mjs
 *   node scripts/stripe-sync-audit.mjs --fix
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY
 */

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ──────────────────────────────────────────────────────────
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
const STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
  console.error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / STRIPE_SECRET_KEY'
  );
  process.exit(1);
}

const FIX = process.argv.includes('--fix');

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

/**
 * Map a Stripe subscription status to our internal SubStatus string.
 * Mirrors handleSubscriptionUpdated in app/api/stripe/webhook/route.ts.
 */
function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      return 'payment_failed';
    case 'canceled':
      return 'cancelled';
    case 'incomplete':
    case 'incomplete_expired':
      return 'pending';
    default:
      return stripeStatus;
  }
}

async function main() {
  console.log(`\nStripe ⇄ Supabase audit${FIX ? ' [FIX MODE]' : ' [dry-run]'}\n`);

  // ── 1. Pull all Supabase users ────────────────────────────────────────────
  const { data: page, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    console.error('listUsers error:', error.message);
    process.exit(1);
  }

  const users = page?.users ?? [];
  const withStripe = users.filter(
    (u) => u.app_metadata?.stripe_subscription_id || u.app_metadata?.stripe_customer_id
  );

  console.log(`Users with Stripe linkage: ${withStripe.length} / ${users.length}\n`);

  const mismatches = [];
  const orphans = [];
  const ok = [];

  // ── 2. For each user, fetch Stripe subscription and compare ──────────────
  for (const user of withStripe) {
    const meta = user.app_metadata ?? {};
    const localStatus = meta.subscription?.status ?? '(none)';
    const subId = meta.stripe_subscription_id;
    const customerId = meta.stripe_customer_id;

    if (!subId) {
      // Customer ID but no subscription ID — skip (e.g. free plan or cancelled long ago).
      continue;
    }

    let stripeSub = null;
    try {
      stripeSub = await stripe.subscriptions.retrieve(subId);
    } catch (err) {
      if (err?.code === 'resource_missing') {
        orphans.push({ user, reason: 'stripe_subscription_deleted', subId });
        continue;
      }
      console.error(`  [!] ${user.email}: retrieve(${subId}) failed:`, err?.message ?? err);
      continue;
    }

    const expected = mapStripeStatus(stripeSub.status);

    if (expected === localStatus) {
      ok.push({ email: user.email, status: localStatus });
      continue;
    }

    mismatches.push({
      user,
      localStatus,
      stripeStatus: stripeSub.status,
      expectedStatus: expected,
      subId,
      customerId,
    });
  }

  // ── 3. Report ────────────────────────────────────────────────────────────
  console.log('── In sync ──────────────────────────────────');
  console.log(`  ${ok.length} users match Stripe state.\n`);

  if (orphans.length) {
    console.log('── Orphaned stripe_subscription_id (deleted in Stripe) ──');
    for (const o of orphans) {
      console.log(`  ${o.user.email}  id=${o.user.id}  sub=${o.subId}`);
    }
    console.log('');
  }

  if (!mismatches.length) {
    console.log('── No status mismatches detected. ✅\n');
    return;
  }

  console.log('── Status mismatches ────────────────────────');
  for (const m of mismatches) {
    console.log(
      `  ${m.user.email}\n    local:    ${m.localStatus}\n    stripe:   ${m.stripeStatus} → ${m.expectedStatus}\n    sub:      ${m.subId}`
    );
  }
  console.log('');

  // ── 4. Fix mode ──────────────────────────────────────────────────────────
  if (!FIX) {
    console.log(`Dry-run. Re-run with --fix to apply ${mismatches.length} corrections.\n`);
    return;
  }

  console.log(`Applying ${mismatches.length} corrections…\n`);
  let applied = 0;
  let failed = 0;

  for (const m of mismatches) {
    const existingMeta = m.user.app_metadata ?? {};
    const existingSub = existingMeta.subscription ?? {};

    const { error: updErr } = await admin.auth.admin.updateUserById(m.user.id, {
      app_metadata: {
        ...existingMeta,
        subscription: {
          ...existingSub,
          status: m.expectedStatus,
        },
      },
    });

    if (updErr) {
      console.log(`  ✗ ${m.user.email}: ${updErr.message}`);
      failed++;
      continue;
    }

    await admin.from('audit_log').insert({
      action: 'stripe.sync_audit.applied',
      resource_type: 'user',
      resource_id: m.user.id,
      metadata: JSON.stringify({
        from: m.localStatus,
        to: m.expectedStatus,
        stripeStatus: m.stripeStatus,
        subId: m.subId,
      }),
    });

    console.log(`  ✓ ${m.user.email}: ${m.localStatus} → ${m.expectedStatus}`);
    applied++;
  }

  console.log(`\nDone. Applied ${applied}, failed ${failed}, total ${mismatches.length}.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
