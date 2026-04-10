/**
 * Constant-time string comparison utility.
 *
 * Provides a timing-attack-safe alternative to `===` for comparing
 * secrets (e.g. bearer tokens, HMAC signatures, API keys).
 * Using `===` for secret comparisons leaks information about where
 * the strings first differ via measurable execution-time differences.
 * `crypto.timingSafeEqual` always takes the same amount of time
 * regardless of whether (and where) the strings differ.
 *
 * @module lib/safeCompare
 */
import { timingSafeEqual } from 'crypto';

/**
 * Performs a constant-time string comparison to prevent timing attacks.
 *
 * Returns `true` if both strings are byte-for-byte identical.
 * Strings of different lengths are handled safely (always `false`) —
 * the early-return for length mismatch does **not** reveal which string
 * is shorter, only that they are unequal.
 *
 * @param a - First string to compare (typically the value received from the caller)
 * @param b - Second string to compare (typically the expected/configured secret)
 * @returns `true` if the strings are identical, `false` otherwise
 *
 * @example
 * ```ts
 * import { safeCompare } from '@/lib/safeCompare';
 *
 * const auth = request.headers.get('authorization') ?? '';
 * const expected = `Bearer ${process.env.CRON_SECRET}`;
 * if (!safeCompare(auth, expected)) {
 *   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 * }
 * ```
 */
export function safeCompare(a: string, b: string): boolean {
  // Encode to UTF-8 buffers first so that the byte-length comparison is
  // accurate for multi-byte characters (e.g. Danish æøå, emoji).
  // `String.prototype.length` counts UTF-16 code units, not bytes, which
  // would cause timingSafeEqual to throw a RangeError on mismatched buffer
  // sizes if the strings contain multi-byte characters.
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Different byte lengths → never equal; no timing information is leaked
  // beyond the fact that they differ, which an attacker already knows.
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}
