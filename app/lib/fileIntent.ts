/**
 * fileIntent — detects whether a user message is explicitly asking for a
 * downloadable file (Excel/CSV/Word/PowerPoint export).
 *
 * Used by the AI chat route (BIZZ-2290) to provide an honest fallback: when the
 * user asked for a file but the turn ended without generate_document actually
 * producing one (e.g. the dataset was too large for a single tool call), we tell
 * the user instead of silently streaming the model's empty "here's your file"
 * promise.
 *
 * Intentionally format-word based (not the bare word "fil") to avoid false
 * positives on words like "profil" or "filtrering".
 *
 * @module app/lib/fileIntent
 */

/** Matches explicit file/export requests in Danish or English. */
const FILE_INTENT_RE =
  /(excel|xlsx|\bcsv\b|word-?dokument|\bdocx\b|pptx|powerpoint|regneark|\bdownload\b|eksport(?:er|ér|ere)?)/i;

/**
 * Returns true if the text explicitly requests a downloadable file.
 *
 * @param text - The user message text
 * @returns Whether a file/export was explicitly requested
 */
export function detectFileIntent(text: string): boolean {
  if (!text) return false;
  return FILE_INTENT_RE.test(text);
}
