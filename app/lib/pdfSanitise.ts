/**
 * Sanitisation helpers for pdfkit string inputs.
 *
 * External API data may contain control characters, replacement characters,
 * or extremely long strings that crash or corrupt pdfkit output.
 * All text originating from untrusted sources must pass through `sanitise()`
 * before being handed to any pdfkit method (.text(), info.Title, etc.).
 *
 * @module pdfSanitise
 */

/**
 * Default maximum length for regular text fields (labels, short values).
 */
const DEFAULT_MAX_LENGTH = 500;

/**
 * Regex matching Unicode control characters (U+0000–U+001F) except
 * TAB (U+0009) and NEWLINE (U+000A), plus the Unicode replacement
 * character (U+FFFD).
 */
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\uFFFD]/g;

/**
 * Sanitise a string for safe use in pdfkit.
 *
 * - Strips control characters (U+0000–U+001F except tab and newline)
 * - Strips the Unicode replacement character (U+FFFD)
 * - Truncates to `maxLength` characters
 * - Returns `fallback` if the result is empty or the input is nullish
 *
 * @param value - The raw string (or nullish) to sanitise
 * @param maxLength - Maximum allowed character count (default 500)
 * @param fallback - Replacement when the sanitised result is empty (default '–')
 * @returns A safe, bounded string suitable for pdfkit
 */
export function sanitise(
  value: string | null | undefined,
  maxLength: number = DEFAULT_MAX_LENGTH,
  fallback: string = '–'
): string {
  if (value == null) return fallback;

  const cleaned = value.replace(UNSAFE_CHARS, '').trim();

  if (cleaned.length === 0) return fallback;

  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + '…' : cleaned;
}

/**
 * Sanitise a long text field (descriptions, notes) with a 2 000-character limit.
 *
 * Convenience wrapper around {@link sanitise} with a higher default max length.
 *
 * @param value - The raw string to sanitise
 * @param fallback - Replacement when the sanitised result is empty (default '–')
 * @returns A safe, bounded string suitable for pdfkit
 */
export function sanitiseLong(value: string | null | undefined, fallback: string = '–'): string {
  return sanitise(value, 2000, fallback);
}
