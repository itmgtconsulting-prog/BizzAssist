/**
 * PII redaction utilities — BIZZ-1706 + BIZZ-1703.
 *
 * Bruges til at fjerne/maskere CPR-numre og andre PII fra:
 *   - Logger output
 *   - Sentry events (beforeSend)
 *   - AI-output (Claude tool-results)
 *   - PDF/dokument-cache
 *   - Eksport-pipelines
 *
 * @module app/lib/piiRedact
 */

/**
 * Validér om en 6-cifret dato er en gyldig CPR-dato (DDMMYY).
 *
 * @param datePart - De første 6 cifre af et potentielt CPR
 * @returns true hvis datoen er valid
 */
function isValidCprDate(datePart: string): boolean {
  const day = parseInt(datePart.slice(0, 2), 10);
  const month = parseInt(datePart.slice(2, 4), 10);
  // CPR bruger dag 1-31 (+ 60+ for midlertidige) og måned 1-12
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 71) return false; // 60+ = erstatnings-CPR
  return true;
}

/**
 * Redact CPR-numre fra tekst.
 * Matcher DDMMYY-XXXX og DDMMYYXXXX (med og uden bindestreg).
 * Validerer at dato-delen er en gyldig CPR-dato.
 *
 * @param text - Input-tekst der kan indeholde CPR-numre
 * @returns Tekst med CPR-numre erstattet af "[CPR REDACTED]"
 */
export function redactCpr(text: string): string {
  // Match 10-cifret sekvens med optional bindestreg efter 6. ciffer
  return text.replace(/\b(\d{6})-?(\d{4})\b/g, (match, datePart: string, _last4: string) => {
    if (isValidCprDate(datePart)) {
      return '[CPR REDACTED]';
    }
    return match; // Ikke en valid CPR-dato — behold
  });
}

/**
 * Respektér adressebeskyttelse for en person.
 * Returnerer anonymiseret visning hvis personen har adressebeskyttelse.
 *
 * @param person - Person-record med adressebeskyttelse-flag
 * @returns Anonymiseret display-data
 */
export function respectAddressProtection(person: {
  navn?: string | null;
  adresse?: string | null;
  adresseBeskyttelse?: boolean;
}): { displayName: string; displayAddress: string | null } {
  if (person.adresseBeskyttelse) {
    return { displayName: 'Privat ejer', displayAddress: null };
  }
  return {
    displayName: person.navn ?? 'Ukendt',
    displayAddress: person.adresse ?? null,
  };
}

/**
 * Filtrer events ældre end N år.
 * Bruges til person-historik UI for at begrænse eksponering.
 *
 * @param events - Array af events med dato-felt
 * @param years - Max alder i år (default 10)
 * @param dateField - Navn på dato-feltet (default 'dato')
 * @returns Filtreret array
 */
export function truncateHistory<T extends Record<string, unknown>>(
  events: T[],
  years = 10,
  dateField = 'dato'
): T[] {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  const cutoffIso = cutoff.toISOString();

  return events.filter((e) => {
    const val = e[dateField];
    if (typeof val !== 'string') return true; // Behold events uden dato
    return val >= cutoffIso;
  });
}

/**
 * Redact PII fra et Sentry-event (beforeSend pre-processor).
 *
 * @param event - Sentry event object
 * @returns Renset event
 */
export function redactPiiFromSentryEvent(event: Record<string, unknown>): Record<string, unknown> {
  const str = JSON.stringify(event);
  const redacted = redactCpr(str);
  if (redacted !== str) {
    return JSON.parse(redacted) as Record<string, unknown>;
  }
  return event;
}
