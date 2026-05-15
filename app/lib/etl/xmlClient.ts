/**
 * Tinglysning S2S XML API lavniveau-klient.
 *
 * Wraps HTTP POST mod `xml-api.tinglysning.dk/<Service>/<Operation>` via
 * Hetzner-proxyen, der udfører mTLS med OCES virksomhedscertifikat. Parser
 * SOAP responses og konverterer SOAP faults til strukturerede {@link EtlFault}.
 *
 * Begge BizzAssist-miljøer (prod + preview) rammer **prod Tinglysning** —
 * test-miljø er ikke i brug. Se ADR 0009 for rationale.
 *
 * Stub-status: kun signatur + factory på plads. Body-implementering kommer i
 * BIZZ-XX1 (Fase 1).
 *
 * @module app/lib/etl/xmlClient
 * Retention: Request/response logges til `tenant.audit_log` (max 12 mdr retention).
 */

import { randomUUID } from 'node:crypto';
import { EtlTransportError } from './errors';
// EtlFault re-importeres når body-impl. lander (BIZZ-XX1) — throw'es ved SOAP-faults

/** Service-katalog i prod XML API. Pt. én service, men XSD'erne er bygget til flere. */
export type EtlServiceName = 'ElektroniskAkt';

/** Alle 33+ operations-navne i ElektroniskAkt — udvides efterhånden. */
export type EtlOperationName =
  | 'EjendomSummariskHent'
  | 'EjendomStamoplysningerHent'
  | 'EjendomAdkomsterHent'
  | 'EjendomServitutterHent'
  | 'EjendomHaeftelserHent'
  | 'EjendomIndskannetAktHent'
  | 'EjendomSoeg'
  | 'VirksomhedSoeg'
  | 'SenesteAendringTinglysningsobjektHent'
  | 'AendredeTinglysningsobjekterHent';
// TODO BIZZ-XX3: tilføj resterende operationer fra ElektroniskAkt.wsdl

export interface EtlCallOptions {
  /** Default 55s (samme som tlFetch.ts). */
  timeoutMs?: number;
  /** Override Message-ID — default genereres som `uuid:<random>`. */
  messageId?: string;
}

export interface EtlCallContext {
  /** Tenant der initierede kaldet. Bruges til audit_log. */
  tenantId: string;
  /** Bruger-ID (optional). */
  userId?: string | null;
}

export interface EtlResult<TResponse> {
  /** HTTP-statuskode fra Tinglysning (typisk 200 ved succes). */
  status: number;
  /** Parset response body (typed pr. operation). */
  data: TResponse;
  /** Message-ID brugt i requestet — gem til audit-trail. */
  messageId: string;
  /** Round-trip-tid i ms. */
  durationMs: number;
}

/** Config læst fra env ved kald-tid (undgå Turbopack build-time inlining). */
function getEtlConfig() {
  return {
    /** Default: prod XML API (begge miljøer peger på prod — jf. ADR 0009). */
    xmlApiBase: process.env.TINGLYSNING_XML_BASE_URL ?? 'https://xml-api.tinglysning.dk',
    proxyUrl: process.env.DF_PROXY_URL ?? '',
    proxySecret: process.env.DF_PROXY_SECRET ?? '',
    certB64: process.env.TINGLYSNING_CERT_B64 ?? '',
    certPassword: process.env.TINGLYSNING_CERT_PASSWORD ?? '',
  };
}

/**
 * Sender en signeret S2S-request og returnerer parsed response.
 *
 * Flow:
 * 1. Generer Message-ID (uuid:...)
 * 2. Sign requestBody med XMLDSig (se {@link signXmlBody} i xmlSigner.ts)
 * 3. POST via Hetzner-proxy → mTLS → xml-api.tinglysning.dk
 * 4. Parse response: hvis SOAP fault, kast {@link EtlFault}; ellers parse via responseParser
 * 5. Log til tenant.audit_log (request-hash, operation, status, durationMs)
 *
 * @param service - Service-navn (pt. kun "ElektroniskAkt")
 * @param operation - Operation-navn (fx "EjendomSummariskHent")
 * @param requestBody - XML-string for request body (uden Envelope; signer wrapper det)
 * @param ctx - Tenant + bruger til audit
 * @param options - Valgfri overrides
 * @returns Typed response
 * @throws {EtlFault} ved SOAP-fault (forretningsfejl)
 * @throws {EtlTransportError} ved netværks-/proxy-/TLS-fejl
 */
export async function callEtl<TResponse>(
  service: EtlServiceName,
  operation: EtlOperationName,
  requestBody: string,
  ctx: EtlCallContext,
  options?: EtlCallOptions
): Promise<EtlResult<TResponse>> {
  const { xmlApiBase, proxyUrl, proxySecret } = getEtlConfig();
  const timeoutMs = options?.timeoutMs ?? 55_000;
  const messageId = options?.messageId ?? `uuid:${randomUUID()}`;

  if (!proxyUrl) {
    throw new EtlTransportError('DF_PROXY_URL ikke konfigureret — S2S kald kræver Hetzner-proxy', {
      httpStatus: null,
    });
  }

  // TODO BIZZ-XX1: implementer body
  // - Konstruer fuld URL: ${proxyUrl}/proxy/<host-fra-xmlApiBase>/<service>/<operation>
  // - Sign requestBody via xmlSigner.signXmlBody()
  // - fetch() med headers: X-Proxy-Secret, Content-Type=application/xml, Tinglysning-Message-ID
  // - Læs response; tjek Content-Type for SOAP fault detection
  // - Parse fault via responseParser.parseFault() → kast EtlFault
  // - Parse success via responseParser.parseResponse() → returner EtlResult
  // - Skriv til tenant.audit_log (operation, durationMs, status, requestHash)

  void service;
  void operation;
  void requestBody;
  void ctx;
  void timeoutMs;
  void messageId;
  void xmlApiBase;
  void proxySecret;

  throw new Error('callEtl: not implemented — see BIZZ-XX1 (Fase 1, ADR 0009)');
}

/**
 * Validerer at S2S-konfigurationen er komplet. Bruges af startup-health-check
 * og `daily-status` cron til at alerte tidligt hvis env-vars mangler.
 *
 * @returns null hvis OK, ellers liste over manglende env-vars
 */
export function validateEtlConfig(): string[] | null {
  const cfg = getEtlConfig();
  const missing: string[] = [];
  if (!cfg.proxyUrl) missing.push('DF_PROXY_URL');
  if (!cfg.proxySecret) missing.push('DF_PROXY_SECRET');
  if (!cfg.certB64) missing.push('TINGLYSNING_CERT_B64');
  if (!cfg.certPassword) missing.push('TINGLYSNING_CERT_PASSWORD');
  return missing.length > 0 ? missing : null;
}
