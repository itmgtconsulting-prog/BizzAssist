/**
 * BIZZ-785 iter 2a: read-path helper til `public.bbr_ejendom_status`.
 *
 * Eksporterer `fetchBbrStatusForAdresser()` der i én batch-query ser op
 * is_udfaset for en liste af DAR adgangsadresse-UUID'er. Returnerer Map
 * hvor missing row betyder "status ukendt" (null → behandl som aktiv).
 *
 * Skrive-path (upsert fra backfill/cron) ligger i `scripts/backfill-
 * bbr-status.mjs` + `app/api/cron/refresh-bbr-status/route.ts` og deler
 * ikke kode med denne fil for at holde read-path let.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from './logger';

/**
 * Lookup-resultat pr. adgangsadresse. Null-felter = ukendt (ikke i DB).
 */
export interface BbrStatusEntry {
  bfeNummer: number | null;
  isUdfaset: boolean;
  bbrStatusCode: number | null;
  statusLastCheckedAt: string | null;
}

/**
 * Batch-lookup af BBR-status for en liste af adgangsadresse-UUID'er.
 * Kaldes fra `/api/adresse/autocomplete` efter DAR-queryen for at
 * berige resultater med en verificeret `is_udfaset` flag.
 *
 * Tom input returnerer tom map uden DB-query.
 *
 * @param adgangsadresseIds - Array af DAR adgangsadresse-UUID'er
 * @returns Map keyed på UUID (lowercase) → BbrStatusEntry. Missing
 *   keys betyder ingen row i DB (status ukendt).
 */
export async function fetchBbrStatusForAdresser(
  adgangsadresseIds: string[]
): Promise<Map<string, BbrStatusEntry>> {
  const result = new Map<string, BbrStatusEntry>();
  if (adgangsadresseIds.length === 0) return result;

  const unique = Array.from(new Set(adgangsadresseIds.map((s) => s.toLowerCase())));
  if (unique.length === 0) return result;

  try {
    // Bemærk: bbr_ejendom_status er en ny tabel (migration 069) der endnu
    // ikke er i de genererede Database types. Cast til ukendt for at
    // skippe type-check; column-navne valideres runtime af PostgREST.
    const client = createAdminClient() as unknown as {
      from: (table: string) => {
        select: (cols: string) => {
          in: (
            col: string,
            values: string[]
          ) => Promise<{
            data: Array<Record<string, unknown>> | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    const { data, error } = await client
      .from('bbr_ejendom_status')
      .select('bfe_nummer, adgangsadresse_id, is_udfaset, bbr_status_code, status_last_checked_at')
      .in('adgangsadresse_id', unique);
    if (error) {
      logger.warn('[bbr_ejendom_status] lookup fejlede:', error.message);
      return result;
    }
    for (const row of data ?? []) {
      const key = String(row.adgangsadresse_id ?? '').toLowerCase();
      if (!key) continue;
      result.set(key, {
        bfeNummer: row.bfe_nummer != null ? Number(row.bfe_nummer) : null,
        isUdfaset: !!row.is_udfaset,
        bbrStatusCode: row.bbr_status_code != null ? Number(row.bbr_status_code) : null,
        statusLastCheckedAt: (row.status_last_checked_at as string | null) ?? null,
      });
    }
  } catch (err) {
    // DB-unavailability blokerer ikke autocomplete — vi falder tilbage
    // til "status ukendt" som UI viser som aktiv.
    logger.warn('[bbr_ejendom_status] lookup exception:', err instanceof Error ? err.message : err);
  }
  return result;
}

/**
 * Upsert-helper for backfill-script + cron. Tager et array af
 * status-rækker og upserter pr. bfe_nummer. Fejler stille per række
 * så én bad record ikke stopper hele batchen.
 *
 * @param rows - Array af rækker der skal upsertes
 */
export async function upsertBbrStatus(
  rows: Array<{
    bfe_nummer: number;
    adgangsadresse_id?: string | null;
    is_udfaset: boolean;
    bbr_status_code?: number | null;
    kommune_kode?: number | null;
  }>
): Promise<{ upserted: number; errors: number }> {
  if (rows.length === 0) return { upserted: 0, errors: 0 };
  // Bemærk: se note ovenfor om manglende generede types for ny tabel.
  const client = createAdminClient() as unknown as {
    from: (table: string) => {
      upsert: (
        values: unknown[],
        options: { onConflict: string; count?: 'exact' }
      ) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
  const payload = rows.map((r) => ({
    bfe_nummer: r.bfe_nummer,
    adgangsadresse_id: r.adgangsadresse_id ?? null,
    is_udfaset: r.is_udfaset,
    bbr_status_code: r.bbr_status_code ?? null,
    kommune_kode: r.kommune_kode ?? null,
    status_last_checked_at: new Date().toISOString(),
  }));
  const { error, count } = await client
    .from('bbr_ejendom_status')
    .upsert(payload, { onConflict: 'bfe_nummer', count: 'exact' });
  if (error) {
    logger.error('[bbr_ejendom_status] upsert fejlede:', error.message);
    return { upserted: 0, errors: rows.length };
  }
  return { upserted: count ?? rows.length, errors: 0 };
}
