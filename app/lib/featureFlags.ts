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

/**
 * BIZZ-1517: Check om S2S Anmelder-funktionalitet er aktiveret.
 * ALDRIG true på preview — kun production med eksplicit env var.
 *
 * @returns true hvis S2S anmeldelse er aktiveret
 */
export function isAnmelderEnabled(): boolean {
  if (process.env.VERCEL_ENV === 'preview') return false;
  return process.env.ENABLE_S2S_ANMELDER === 'true';
}

/**
 * BIZZ-1517: Check om S2S forespørgsler (read-only) er aktiveret.
 * Tilladt på alle miljøer med cert-konfiguration.
 *
 * @returns true hvis S2S forespørgsler kan bruges
 */
export function isS2SQueryEnabled(): boolean {
  return !!(process.env.TINGLYSNING_CERT_PATH || process.env.TINGLYSNING_CERT_B64);
}

/**
 * BIZZ-1925: Virksomhedshandler-modul (M&A-radar).
 * Kun synlig på test/dev — ALDRIG i prod før JJR godkender.
 *
 * @returns true hvis virksomhedshandler er aktiveret
 */
export function isVirksomhedshandlerEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VIRKSOMHEDSHANDLER_ENABLED === 'true';
}
