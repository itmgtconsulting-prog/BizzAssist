/**
 * AI akt-ekstraktion → ejerskifte_historik backfill (BIZZ-1598).
 *
 * Når Claude Vision har extracted handelsoplysninger fra en scannet
 * tinglysningsakt-PDF, persisteres det resultat i den fælles
 * `public.ejerskifte_historik`-tabel så ALLE brugere ser dataen
 * fremadrettet (ikke kun den der initierede scanningen).
 *
 * Dedupe-strategi (jf ticket):
 *   - Match på samme bfe_nummer + ejer_navn + overtagelsesdato inden for
 *     ±30 dage. Hvis match: skip insert (data findes allerede).
 *   - Composite unique constraint på (bfe_nummer, overtagelsesdato, ejer_navn)
 *     fanger eksakt dato-match som race-protection (23505 → 200 idempotent).
 *
 * Kilde-mærkning: kilde='ai_extraction' så salgshistorik-visning (BIZZ-1599)
 * kan vise korrekt badge.
 *
 * @module app/lib/aktExtractionBackfill
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** ±30 dage dedupe-tolerance — anbefalet pr ticket */
const DEDUPE_WINDOW_DAYS = 30;

/** Strukturen Claude Vision returnerer per handel udtrukket fra en akt */
export interface ExtractedHandel {
  /** BFE-nummer for ejendommen akten vedrører */
  bfe_nummer: number;
  /** Overtagelsesdato (ISO YYYY-MM-DD) — påkrævet til dedupe */
  overtagelsesdato: string;
  /** Køber-navn — påkrævet til dedupe (composite-unique på (bfe, dato, navn)) */
  ejer_navn: string;
  /** Køber-CVR hvis virksomhed */
  ejer_cvr?: string | null;
  /** 'person' eller 'virksomhed' */
  ejer_type?: 'person' | 'virksomhed' | null;
  /** Kontant købesum i DKK */
  kontant_koebesum?: number | null;
  /** Samlet købesum inkl. løsøre etc */
  i_alt_koebesum?: number | null;
  /** Tinglysning dokument-id (kan være null for pre-digital akt) */
  dokument_id?: string | null;
  /** Dokumenttype fra akt (Skoede, Skifteretsattest osv) */
  dokument_type?: string | null;
}

/** Resultat af én backfill-kørsel */
export interface BackfillResult {
  /** Antal handler indsendt i kald */
  total: number;
  /** Antal nye rows inserted i ejerskifte_historik */
  inserted: number;
  /** Antal skipped fordi de allerede fandtes inden for dedupe-vinduet */
  deduped: number;
  /** Antal der fejlede ved insert (kun ikke-dup fejl tæller her) */
  failed: number;
  /** Begrundelse hvis hele kaldet fejlede (DB unreachable osv.) */
  fatalError?: string;
}

/**
 * Backfill AI-extracted handler til ejerskifte_historik.
 *
 * @param handler - Array af extracted handler fra én akt
 * @returns Backfill-resultat med per-row stats
 */
export async function backfillExtractedHandler(
  handler: ExtractedHandel[]
): Promise<BackfillResult> {
  const result: BackfillResult = {
    total: handler.length,
    inserted: 0,
    deduped: 0,
    failed: 0,
  };
  if (handler.length === 0) return result;

  const admin = createAdminClient();

  for (const h of handler) {
    if (!h.bfe_nummer || !h.overtagelsesdato || !h.ejer_navn) {
      result.failed++;
      logger.warn('[aktBackfill] handel mangler påkrævede felter — skipper', {
        bfe: h.bfe_nummer,
        dato: h.overtagelsesdato,
        navn: h.ejer_navn,
      });
      continue;
    }

    // ─── Dedupe-tjek: findes der allerede en handel inden for ±30 dage? ──
    try {
      const baseDate = new Date(h.overtagelsesdato);
      const windowStart = new Date(baseDate);
      windowStart.setDate(windowStart.getDate() - DEDUPE_WINDOW_DAYS);
      const windowEnd = new Date(baseDate);
      windowEnd.setDate(windowEnd.getDate() + DEDUPE_WINDOW_DAYS);

      const { data: existing } = await admin
        .from('ejerskifte_historik')
        .select('id')
        .eq('bfe_nummer', h.bfe_nummer)
        .eq('ejer_navn', h.ejer_navn)
        .gte('overtagelsesdato', windowStart.toISOString().slice(0, 10))
        .lte('overtagelsesdato', windowEnd.toISOString().slice(0, 10))
        .limit(1);

      if (existing && existing.length > 0) {
        result.deduped++;
        continue;
      }
    } catch (err) {
      logger.warn('[aktBackfill] dedupe-lookup fejlede — fortsætter med insert', {
        bfe: h.bfe_nummer,
        err,
      });
      // Fortsæt — insert vil fail på unique constraint hvis det er duplikat
    }

    // ─── Insert med kilde='ai_extraction' ───────────────────────────────
    try {
      const row = {
        bfe_nummer: h.bfe_nummer,
        overtagelsesdato: h.overtagelsesdato,
        ejer_navn: h.ejer_navn,
        ejer_cvr: h.ejer_cvr ?? null,
        ejer_type: h.ejer_type ?? null,
        kontant_koebesum: h.kontant_koebesum ?? null,
        i_alt_koebesum: h.i_alt_koebesum ?? null,
        dokument_id: h.dokument_id ?? null,
        kilde: 'ai_extraction',
        historisk_kilde: h.dokument_type ?? 'akt',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any).from('ejerskifte_historik').insert(row);

      if (error) {
        // 23505 = unique_violation — same dato + navn allerede inserted (race-condition).
        // Behandl som dedupe i stedet for fejl.
        const code = (error as { code?: string }).code;
        if (code === '23505') {
          result.deduped++;
          continue;
        }
        result.failed++;
        logger.warn('[aktBackfill] insert fejl', {
          bfe: h.bfe_nummer,
          dato: h.overtagelsesdato,
          err: error.message,
        });
        continue;
      }
      result.inserted++;
    } catch (err) {
      result.failed++;
      logger.warn('[aktBackfill] insert uventet fejl', {
        bfe: h.bfe_nummer,
        err,
      });
    }
  }

  return result;
}
