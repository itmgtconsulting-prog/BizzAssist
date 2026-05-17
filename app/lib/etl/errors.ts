/**
 * Tinglysning S2S XML API fault-typer.
 *
 * Tinglysningsrettens HTTP XML API returnerer SOAP-faults med struktureret
 * fejlinformation. Denne fil definerer typed errors og kendte fejlkoder så
 * call-sites kan branche på `error.fejlkode` i stedet for at parse strings.
 *
 * Fejlkoder er dokumenteret i `docs/tinglysning/system-systemmanual-v1.53.txt`.
 *
 * @module app/lib/etl/errors
 * Retention: N/A (in-memory error class — log entries håndteres af kald-sites
 * via `tenant.audit_log` med max 12 mdr retention).
 */

/**
 * Kendte fejlkoder fra Tinglysningsretten's XML API.
 * Listen er ikke udtømmende — udvides efterhånden som vi rammer dem.
 */
export const EtlFejlkode = {
  /** Cert RID er ikke registreret som S2S-aktør. */
  IKKE_FINDE_S2S_AKTOER_SSL_CERT: 'ikkeFindeS2SAktoerSSLCert',
  /** Request body matchede ikke XSD-schema. */
  XML_IKKE_VALID: 'xmlIkkeValid',
  /** Manglende eller ugyldig XMLDSig-signatur. */
  SIGNATUR_UGYLDIG: 'signaturUgyldig',
  /** Tinglysning-Message-ID header manglede eller havde forkert format. */
  MESSAGE_ID_UGYLDIG: 'messageIdUgyldig',
  /** Det forespurgte objekt (BFE, CVR, andelsbolig) findes ikke. */
  OBJEKT_IKKE_FUNDET: 'objektIkkeFundet',
  /** Generic server-side fejl — typisk indikerer config-problem i e-TL. */
  INTERN_FEJL: 'internFejl',
} as const;

export type EtlFejlkodeType = (typeof EtlFejlkode)[keyof typeof EtlFejlkode];

/**
 * En SOAP fault returneret af Tinglysningsretten's XML API.
 *
 * Kald-sites kan branche på `fejlkode` for specifik fejl-håndtering:
 * ```ts
 * try {
 *   await client.ejendomSummariskHent({ bfe: 100165718 });
 * } catch (e) {
 *   if (e instanceof EtlFault && e.fejlkode === EtlFejlkode.OBJEKT_IKKE_FUNDET) {
 *     return null; // graceful — ejendom findes bare ikke
 *   }
 *   throw e;
 * }
 * ```
 */
export class EtlFault extends Error {
  /** Den specifikke fejlkode fra `<Fejlinformation><Fejlkode>`. */
  public readonly fejlkode: string;

  /** Frie tekst-parametre fra `<FejlparameterSamling>`. */
  public readonly fejlparametre: string[];

  /** Fejl-UUID fra Tinglysning til support-opslag. */
  public readonly fejlUuid: string | null;

  /** HTTP-statuskode fra Tinglysning-svaret. */
  public readonly httpStatus: number;

  /** SOAP fault-code (`soapenv:Client` eller `soapenv:Server`). */
  public readonly faultCode: 'soapenv:Client' | 'soapenv:Server' | string;

  /**
   * @param message - Human-readable besked (typisk `<faultstring>`)
   * @param meta - Strukturerede metadata fra SOAP fault
   */
  constructor(
    message: string,
    meta: {
      fejlkode: string;
      fejlparametre?: string[];
      fejlUuid?: string | null;
      httpStatus: number;
      faultCode: string;
    }
  ) {
    super(message);
    this.name = 'EtlFault';
    this.fejlkode = meta.fejlkode;
    this.fejlparametre = meta.fejlparametre ?? [];
    this.fejlUuid = meta.fejlUuid ?? null;
    this.httpStatus = meta.httpStatus;
    this.faultCode = meta.faultCode;
  }
}

/**
 * En transport-niveau fejl (network, proxy, TLS) der opstod før vi nåede SOAP-laget.
 * Bruges når proxy svarer 403, TLS handshake fejler, eller timeout udløber.
 */
export class EtlTransportError extends Error {
  public readonly httpStatus: number | null;
  public readonly cause?: unknown;

  constructor(message: string, meta: { httpStatus?: number | null; cause?: unknown }) {
    super(message);
    this.name = 'EtlTransportError';
    this.httpStatus = meta.httpStatus ?? null;
    this.cause = meta.cause;
  }
}
