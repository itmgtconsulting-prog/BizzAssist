/**
 * Property-poll datakilder — app/lib/propertyPollData.ts
 *
 * Service-role datafunktioner som poll-properties-cronen bruger til at hente de
 * overvågede felter for en fulgt ejendom UDEN at gå gennem de auth-beskyttede
 * HTTP-routes (/api/ejendom, /api/ejerskab). Cronen kører uden brugersession, så
 * den læser i stedet:
 *   - BBR + BFE-nummer direkte via fetchBbrForAddress() (env-baseret DAF-adgang)
 *   - Gældende ejerskab direkte fra backfill-tabellen public.ejf_ejerskab
 *     (samme kilde som /api/ejerskab's cache-first-sti, BIZZ-1013)
 *
 * BIZZ-2194: tidligere kaldte poll-properties de authede routes server-to-server
 * med forkerte query-params (?id= i stedet for ?bfeNummer=) → 401/null, så
 * change-detektering virkede aldrig. Disse funktioner retter det.
 *
 * RESTRICTED — SERVER-SIDE ONLY (service_role).
 *
 * @module app/lib/propertyPollData
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { logger } from '@/app/lib/logger';

/** Overvåget BBR-snapshot + det opløste BFE-nummer for ejendommen */
export interface BbrPollSnapshot {
  /** BFE-nummer opløst fra ejendomsrelationer (null hvis ikke fundet) */
  bfe: number | null;
  /** Stabil delmængde af BBR-felter der overvåges for ændringer */
  monitored: Record<string, unknown>;
}

/**
 * Henter de overvågede BBR-felter + BFE-nummer for en DAWA-adresse via den
 * eksisterende service-role-funktion fetchBbrForAddress().
 *
 * @param dawaId - DAWA adresse-UUID (entity_id i saved_entities)
 * @returns BBR-snapshot + BFE, eller null ved fejl
 */
export async function fetchBbrPollSnapshot(dawaId: string): Promise<BbrPollSnapshot | null> {
  try {
    const data = await fetchBbrForAddress(dawaId);
    const bfe =
      data.ejendomsrelationer?.find((r) => r.bfeNummer != null)?.bfeNummer ??
      data.ejerlejlighedBfe ??
      data.moderBfe ??
      null;

    // Stabil projektion: kun felter der reelt ændrer sig ved en BBR-opdatering.
    // Sorteret på bygnings-id så hash er deterministisk uafhængigt af rækkefølge.
    const bygninger = (data.bbr ?? [])
      .map((b) => ({
        id: b.id,
        opfoerelsesaar: b.opfoerelsesaar,
        ombygningsaar: b.ombygningsaar,
        samletBygningsareal: b.samletBygningsareal,
        samletBoligareal: b.samletBoligareal,
        antalEtager: b.antalEtager,
        anvendelse: b.anvendelse,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    return { bfe, monitored: { bygninger } };
  } catch (err) {
    logger.warn('[propertyPollData] fetchBbrPollSnapshot fejl:', err);
    return null;
  }
}

/** Et overvåget ejerskab-snapshot: de gældende ejere for et BFE */
export interface OwnershipPollSnapshot {
  ejere: Array<{
    navn: string | null;
    cvr: string | null;
    type: string | null;
    taeller: number | null;
    naevner: number | null;
  }>;
}

/**
 * Henter gældende ejerskab for et BFE direkte fra backfill-tabellen
 * public.ejf_ejerskab (service-role). Samme kilde som /api/ejerskab's
 * cache-first-sti, men uden HTTP/auth.
 *
 * @param bfe - BFE-nummer
 * @returns Sorteret liste af gældende ejere, eller null ved fejl
 */
export async function fetchOwnershipPollSnapshot(
  bfe: number
): Promise<OwnershipPollSnapshot | null> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from('ejf_ejerskab')
      .select('ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner')
      .eq('bfe_nummer', bfe)
      .eq('status', 'gældende');

    if (error) {
      logger.warn('[propertyPollData] ejf_ejerskab opslag fejl:', error.message);
      return null;
    }

    const ejere = (
      (data ?? []) as Array<{
        ejer_navn: string | null;
        ejer_cvr: string | null;
        ejer_type: string | null;
        ejerandel_taeller: number | null;
        ejerandel_naevner: number | null;
      }>
    )
      .map((r) => ({
        navn: r.ejer_navn,
        cvr: r.ejer_cvr,
        type: r.ejer_type,
        taeller: r.ejerandel_taeller,
        naevner: r.ejerandel_naevner,
      }))
      // Deterministisk rækkefølge → stabil hash uafhængigt af DB-rækkefølge
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    return { ejere };
  } catch (err) {
    logger.warn('[propertyPollData] fetchOwnershipPollSnapshot fejl:', err);
    return null;
  }
}
