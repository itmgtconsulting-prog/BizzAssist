/**
 * Feature flags — runtime-gated features.
 *
 * BIZZ-699: Domain feature hidden in production until launch.
 * Flag controlled via NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED env var.
 *
 * @module app/lib/featureFlags
 */

/**
 * Returns true if the Domain feature is enabled in the current environment.
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
