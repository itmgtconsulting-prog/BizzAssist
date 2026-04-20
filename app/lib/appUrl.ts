/**
 * Returns the canonical application base URL without trailing slash.
 *
 * Priority: NEXT_PUBLIC_APP_URL env var → hardcoded production fallback.
 *
 * @returns Base URL string (e.g. "https://bizzassist.dk")
 */
export function getAppUrl(): string {
  // BIZZ-645: trim() fjerner trailing newline/whitespace fra env-var.
  // Vercel-env kan levere værdier med CR/LF hvis de er copy-pasted, hvilket
  // brød robots.txt Sitemap-header på bizzassist.dk (tog to linjer i stedet
  // for én). Trim før slash-strip så baseUrl altid er ren.
  const url = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk').trim();
  return url.replace(/\/$/, '');
}
