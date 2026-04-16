/**
 * Returns the canonical application base URL without trailing slash.
 *
 * Priority: NEXT_PUBLIC_APP_URL env var → hardcoded production fallback.
 *
 * @returns Base URL string (e.g. "https://bizzassist.dk")
 */
export function getAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk';
  return url.replace(/\/$/, '');
}
