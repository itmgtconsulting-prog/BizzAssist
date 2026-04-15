/**
 * Datafordeler Proxy Helper
 *
 * Rewrites Datafordeler URLs to route through an optional proxy server
 * for cloud deployments (Vercel etc.) where the server IP is dynamic
 * and cannot be whitelisted at selfservice.datafordeler.dk.
 *
 * When DF_PROXY_URL is set, all requests to *.datafordeler.dk are routed
 * through the proxy. When not set, requests go directly (for local dev
 * where the IP is whitelisted).
 *
 * @module app/lib/dfProxy
 */

/**
 * Returns true if the Datafordeler proxy is configured.
 * Reads process.env at call time to avoid Turbopack build-time inlining of module constants.
 */
export function isProxyEnabled(): boolean {
  return (process.env.DF_PROXY_URL ?? '').length > 0;
}

/**
 * Allowlisted hostname suffixes for URLs accepted by proxyUrl().
 *
 * Only hosts matching one of these patterns may be passed through the proxy.
 * Any other URL will cause proxyUrl() to throw, preventing SSRF attacks where
 * a crafted URL could route internal traffic or scan private network ranges.
 *
 * Allowed:
 *   *.datafordeler.dk         — all Datafordeler services
 *   api-fs.vurderingsportalen.dk — Vurderingsportalen (unofficial ES endpoint)
 *   distribution.virk.dk      — CVR OpenData ElasticSearch
 */
const ALLOWED_HOSTNAME_SUFFIXES: readonly string[] = [
  '.datafordeler.dk',
  'api-fs.vurderingsportalen.dk',
  'distribution.virk.dk',
];

/**
 * Returns true if the given hostname is on the proxy allowlist.
 *
 * @param hostname - Hostname extracted from the URL (e.g. "graphql.datafordeler.dk")
 */
function isAllowedHostname(hostname: string): boolean {
  return ALLOWED_HOSTNAME_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(suffix)
  );
}

/**
 * Rewrites a Datafordeler URL to go through the proxy (if configured).
 * Only allowlisted hostnames are accepted — any other URL throws an error
 * to prevent SSRF (Server-Side Request Forgery).
 *
 * @param url - Direct Datafordeler URL (e.g. https://graphql.datafordeler.dk/BBR/v2?apiKey=...)
 * @returns Proxied URL or original URL if proxy is not configured
 * @throws {Error} If the URL's hostname is not on the allowlist
 *
 * @example
 * // With DF_PROXY_URL=https://df-proxy.bizzassist.dk
 * proxyUrl('https://graphql.datafordeler.dk/BBR/v2?apiKey=xxx')
 * // → 'https://df-proxy.bizzassist.dk/proxy/graphql.datafordeler.dk/BBR/v2?apiKey=xxx'
 */
export function proxyUrl(url: string): string {
  // Always validate hostname against the allowlist, regardless of proxy being enabled.
  // This ensures the function can never be used to reach arbitrary hosts.
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`[dfProxy] Ugyldig URL: ${url}`);
  }

  if (!isAllowedHostname(hostname)) {
    throw new Error(`[dfProxy] URL ikke tilladt (SSRF-beskyttelse): ${hostname}`);
  }

  const DF_PROXY_URL = process.env.DF_PROXY_URL ?? '';
  if (!DF_PROXY_URL) return url;
  // BIZZ-203: Support both HTTPS and HTTP URLs (CVR ES only supports HTTP)
  return url
    .replace('https://', `${DF_PROXY_URL}/proxy/`)
    .replace('http://', `${DF_PROXY_URL}/proxy/`);
}

/**
 * Returns extra headers needed for proxied requests.
 * Includes the X-Proxy-Secret header if configured.
 *
 * @returns Record of headers to merge into fetch calls
 */
export function proxyHeaders(): Record<string, string> {
  const DF_PROXY_URL = process.env.DF_PROXY_URL ?? '';
  const DF_PROXY_SECRET = process.env.DF_PROXY_SECRET ?? '';
  if (!DF_PROXY_URL || !DF_PROXY_SECRET) return {};
  return { 'X-Proxy-Secret': DF_PROXY_SECRET };
}

/**
 * Returns an appropriate timeout for Datafordeler requests.
 * Proxied requests get a longer timeout due to the extra hop.
 *
 * @returns Timeout in milliseconds
 */
export function proxyTimeout(): number {
  return (process.env.DF_PROXY_URL ?? '') ? 15000 : 8000;
}
