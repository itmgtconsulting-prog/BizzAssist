/**
 * Feature flags — runtime-gated features.
 *
 * BIZZ-699: Domain feature hidden in production until launch.
 * Flag controlled via NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED env var.
 * Server-side kill-switch via DOMAIN_FEATURE_KILL_SWITCH env var.
 *
 * @module app/lib/featureFlags
 */

/**
 * Returns true if the Domain feature is enabled in the current environment.
 * Safe for both server and client components (reads NEXT_PUBLIC_ var).
 *
 * - production: disabled (NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED unset or 'false')
 * - preview (test.bizzassist.dk): enabled
 * - development: enabled
 *
 * @returns boolean
 */
export function isDomainFeatureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED === 'true';
}

/**
 * Server-only variant that also checks a build-time kill-switch.
 * Use this in server components, API routes, and proxy.ts.
 * DOMAIN_FEATURE_KILL_SWITCH=1 overrides the public flag — instant off-switch
 * without a Vercel redeploy (just update the env var).
 *
 * @returns boolean — true only if enabled AND not kill-switched
 */
export function isDomainFeatureEnabledServer(): boolean {
  if (process.env.DOMAIN_FEATURE_KILL_SWITCH === '1') return false;
  return isDomainFeatureEnabled();
}

/**
 * Returns true if Diagram v2 is enabled in the current environment.
 * Safe for both server and client components (reads NEXT_PUBLIC_ var).
 *
 * - production: disabled (NEXT_PUBLIC_DIAGRAM2_ENABLED unset or 'false')
 * - preview (test.bizzassist.dk): enabled
 * - development: enabled
 *
 * @returns boolean
 */
export function isDiagram2Enabled(): boolean {
  return process.env.NEXT_PUBLIC_DIAGRAM2_ENABLED === 'true';
}
