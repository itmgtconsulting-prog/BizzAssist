/**
 * Login brute-force protection — Upstash Redis
 *
 * Progressive lockout strategy:
 *   - Attempts 1–3: normal error, no warning
 *   - Attempt 4:    warning "1 forsøg tilbage"
 *   - Attempt 5+:   15-minute lockout + auto-send password reset email
 *
 * Keys used in Redis:
 *   login_attempts:{normalised_email}  — INCR counter, TTL 30 min (reset on each fail)
 *   login_locked:{normalised_email}    — set on lockout, TTL 15 min (auto-unlock)
 *   login_reset_sent:{normalised_email} — prevents duplicate reset mails, TTL 15 min
 *
 * ISO 27001 A.9.4 — System and application access control.
 *
 * @module app/lib/loginThrottle
 */

import { Redis } from '@upstash/redis';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Number of failed attempts before lockout is triggered */
const MAX_ATTEMPTS = 5;

/** Lockout duration in seconds (15 minutes) */
const LOCKOUT_SECONDS = 15 * 60;

/** Attempt counter TTL in seconds — resets window after 30 min of no activity */
const COUNTER_TTL = 30 * 60;

// ─── Redis client ─────────────────────────────────────────────────────────────

let _redis: Redis | null = null;

/**
 * Returns the shared Upstash Redis client.
 * Lazy-initialised so build-time static generation doesn't fail.
 */
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

/**
 * Normalises an email address for use as a Redis key component.
 * Lowercases and strips leading/trailing whitespace.
 *
 * @param email - Raw email from login form
 * @returns Normalised lowercase email
 */
function normalise(email: string): string {
  return email.trim().toLowerCase();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ThrottleStatus {
  /** True if the account is currently locked out */
  locked: boolean;
  /** Seconds remaining until auto-unlock (0 when not locked) */
  lockedForSeconds: number;
  /** How many failed attempts have been recorded in the current window */
  attempts: number;
  /** How many attempts remain before lockout (0 when locked) */
  attemptsLeft: number;
  /** True if this is the 4th attempt (one warning before lockout) */
  warningShown: boolean;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks whether a login attempt should be allowed for the given email.
 * Call this BEFORE authenticating the user.
 *
 * @param email - The email address being used for login
 * @returns ThrottleStatus describing current lockout state
 */
export async function checkLoginThrottle(email: string): Promise<ThrottleStatus> {
  const key = normalise(email);

  try {
    const redis = getRedis();
    const lockKey = `login_locked:${key}`;
    const attKey = `login_attempts:${key}`;

    const [lockTtl, attempts] = await Promise.all([
      redis.ttl(lockKey),
      redis.get<number>(attKey).then((v) => v ?? 0),
    ]);

    const locked = lockTtl > 0;
    const lockedForSeconds = locked ? lockTtl : 0;
    const attemptsLeft = locked ? 0 : Math.max(0, MAX_ATTEMPTS - attempts);
    const warningShown = !locked && attempts === MAX_ATTEMPTS - 1;

    return { locked, lockedForSeconds, attempts, attemptsLeft, warningShown };
  } catch {
    // Redis unavailable — fail open (don't block login on infra issues)
    return {
      locked: false,
      lockedForSeconds: 0,
      attempts: 0,
      attemptsLeft: MAX_ATTEMPTS,
      warningShown: false,
    };
  }
}

/**
 * Records a failed login attempt for the given email.
 * Triggers lockout after MAX_ATTEMPTS failures.
 *
 * @param email      - The email address that failed login
 * @param appBaseUrl - Used to construct the password reset link in the email
 * @returns Updated ThrottleStatus after recording the failure
 */
export async function recordFailedLogin(
  email: string,
  appBaseUrl: string
): Promise<ThrottleStatus> {
  const key = normalise(email);

  try {
    const redis = getRedis();
    const attKey = `login_attempts:${key}`;
    const lockKey = `login_locked:${key}`;
    const resetSentKey = `login_reset_sent:${key}`;

    // Increment counter and refresh its TTL
    const attempts = await redis.incr(attKey);
    await redis.expire(attKey, COUNTER_TTL);

    if (attempts >= MAX_ATTEMPTS) {
      // Set lockout key — auto-expires after LOCKOUT_SECONDS
      await redis.set(lockKey, '1', { ex: LOCKOUT_SECONDS });

      // Send password reset email exactly once per lockout window
      const alreadySent = await redis.exists(resetSentKey);
      if (!alreadySent) {
        await redis.set(resetSentKey, '1', { ex: LOCKOUT_SECONDS });
        // Fire-and-forget — non-critical, lockout is enforced regardless
        sendLockoutResetEmail(email, appBaseUrl).catch(() => {});
      }

      return {
        locked: true,
        lockedForSeconds: LOCKOUT_SECONDS,
        attempts,
        attemptsLeft: 0,
        warningShown: false,
      };
    }

    const attemptsLeft = MAX_ATTEMPTS - attempts;
    return {
      locked: false,
      lockedForSeconds: 0,
      attempts,
      attemptsLeft,
      warningShown: attemptsLeft === 1,
    };
  } catch {
    // Redis unavailable — return non-blocking status
    return {
      locked: false,
      lockedForSeconds: 0,
      attempts: 0,
      attemptsLeft: MAX_ATTEMPTS,
      warningShown: false,
    };
  }
}

/**
 * Clears the failed-login counter for the given email.
 * Call this after a successful login.
 *
 * @param email - The email address that successfully logged in
 */
export async function clearLoginThrottle(email: string): Promise<void> {
  const key = normalise(email);
  try {
    const redis = getRedis();
    await Promise.all([
      redis.del(`login_attempts:${key}`),
      redis.del(`login_locked:${key}`),
      redis.del(`login_reset_sent:${key}`),
    ]);
  } catch {
    // Non-critical — counter will expire naturally
  }
}

// ─── Internal: lockout reset email ───────────────────────────────────────────

/**
 * Sends a password reset email via Supabase Auth when an account is locked.
 * Uses the same flow as "glemt adgangskode" — a secure reset link.
 *
 * @param email      - The locked account's email
 * @param appBaseUrl - Base URL for the redirect (e.g. https://bizzassist.dk)
 */
async function sendLockoutResetEmail(email: string, appBaseUrl: string): Promise<void> {
  // Lazy import — server-only, not bundled for client
  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();

  // Check if user actually exists before sending (anti-enumeration is handled
  // at the response level — we never tell the client whether the account exists)
  const {
    data: { users },
  } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const exists = users.some((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!exists) return;

  // Use Supabase's built-in reset flow — generates a secure signed link
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${appBaseUrl}/login/update-password`,
  });
}
