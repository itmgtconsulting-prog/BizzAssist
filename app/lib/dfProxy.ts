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

/** Proxy base URL — e.g. https://df-proxy.bizzassist.dk */
const DF_PROXY_URL = process.env.DF_PROXY_URL ?? '';

/** Shared secret for proxy authentication */
const DF_PROXY_SECRET = process.env.DF_PROXY_SECRET ?? '';

/**
 * Returns true if the Datafordeler proxy is configured.
 */
export function isProxyEnabled(): boolean {
  return DF_PROXY_URL.length > 0;
}

/**
 * Rewrites a Datafordeler URL to go through the proxy (if configured).
 *
 * @param url - Direct Datafordeler URL (e.g. https://graphql.datafordeler.dk/BBR/v2?apiKey=...)
 * @returns Proxied URL or original URL if proxy is not configured
 *
 * @example
 * // With DF_PROXY_URL=https://df-proxy.bizzassist.dk
 * proxyUrl('https://graphql.datafordeler.dk/BBR/v2?apiKey=xxx')
 * // → 'https://df-proxy.bizzassist.dk/proxy/graphql.datafordeler.dk/BBR/v2?apiKey=xxx'
 */
export function proxyUrl(url: string): string {
  if (!DF_PROXY_URL) return url;
  return url.replace('https://', `${DF_PROXY_URL}/proxy/`);
}

/**
 * Returns extra headers needed for proxied requests.
 * Includes the X-Proxy-Secret header if configured.
 *
 * @returns Record of headers to merge into fetch calls
 */
export function proxyHeaders(): Record<string, string> {
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
  return DF_PROXY_URL ? 15000 : 8000;
}
