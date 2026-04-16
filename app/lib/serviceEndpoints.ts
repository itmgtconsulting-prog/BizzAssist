/**
 * Centraliserede eksterne API-endpoints.
 *
 * Alle endpoints bruger env var med hardcoded fallback til production-URL.
 * Dette gør det muligt at override endpoints via miljøvariabler uden kodeændring,
 * f.eks. ved test mod staging-miljøer.
 *
 * BIZZ-413: Extracted from 15+ filer der tidligere havde duplikerede hardcoded URLs.
 */

// ─── Datafordeler ──────────────────────────────────────────────────────────

/** Datafordeler OAuth token endpoint */
export const DATAFORDELER_TOKEN_URL =
  process.env.DATAFORDELER_TOKEN_URL ??
  'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

/** Datafordeler DAR GraphQL endpoint */
export const DAR_ENDPOINT = process.env.DAR_ENDPOINT ?? 'https://graphql.datafordeler.dk/DAR/v1';

/** Datafordeler BBR GraphQL endpoint */
export const BBR_GQL_ENDPOINT =
  process.env.BBR_GQL_ENDPOINT ?? 'https://graphql.datafordeler.dk/BBR/v2';

/** Datafordeler BBR WFS endpoint */
export const BBR_WFS_ENDPOINT =
  process.env.BBR_WFS_ENDPOINT ?? 'https://wfs.datafordeler.dk/BBR/BBR_WFS/1.0.0/WFS';

/** Datafordeler EJF (Ejerfortegnelse) GraphQL endpoint */
export const EJF_GQL_ENDPOINT =
  process.env.EJF_GQL_ENDPOINT ?? 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';

// ─── Dataforsyningen (DAWA) ────────────────────────────────────────────────

/** DAWA / Dataforsyningen base URL */
export const DAWA_BASE_URL = process.env.DAWA_BASE_URL ?? 'https://api.dataforsyningen.dk';

// ─── CVR ───────────────────────────────────────────────────────────────────

/** CVR Erhvervsstyrelsen ElasticSearch endpoint */
export const CVR_ES_ENDPOINT = process.env.CVR_ES_ENDPOINT ?? 'http://distribution.virk.dk';

// ─── Brave Search ──────────────────────────────────────────────────────────

/** Brave Search API base URL */
export const BRAVE_SEARCH_ENDPOINT =
  process.env.BRAVE_SEARCH_ENDPOINT ?? 'https://api.search.brave.com/res/v1/web/search';

// ─── Resend ────────────────────────────────────────────────────────────────

/** Resend email API endpoint */
export const RESEND_ENDPOINT = process.env.RESEND_ENDPOINT ?? 'https://api.resend.com/emails';

// ─── Miljøportalen ─────────────────────────────────────────────────────────

/** Miljøportalen jordforurening endpoint */
export const MILJOEPORTALEN_ENDPOINT =
  process.env.MILJOEPORTALEN_ENDPOINT ?? 'https://jord.miljoeportal.dk';
