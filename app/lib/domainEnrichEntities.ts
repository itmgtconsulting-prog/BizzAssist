/**
 * BIZZ-716: Enrich entities extracted from case docs with BizzAssist's own
 * data sources. Used by `buildGenerationContext` to include CVR + BBR +
 * ejerskab context in the Claude prompt so the generator can reference
 * actual company names, property areas, and owner chains.
 *
 * Runs only against local data (cvr_virksomhed, ejf_ejerskab) plus the
 * existing BBR-area helper. No internal HTTP fetch — keeps latency low
 * and avoids the auth-cookie dance required for in-process API calls.
 *
 * @module app/lib/domainEnrichEntities
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchBbrAreasByBfe } from '@/app/lib/fetchBbrData';
import { logger } from '@/app/lib/logger';
import type { BizzAssistEntity } from '@/app/lib/domainPromptBuilder';

/** Soft cap on how many identifiers of each type we enrich. Shields the
 *  Claude prompt from ballooning when case docs mention dozens of CVRs. */
export const MAX_ENTITIES_PER_TYPE = 8;

/** Per-entity JSON cap (characters). Trims verbose BBR/CVR payloads so a
 *  single entity can't starve the rest of the context window. */
export const PER_ENTITY_CHAR_CAP = 2_000;

export interface EnrichEntitiesInput {
  cvrs: string[];
  bfes: string[];
}

/**
 * Look up CVR + BFE identifiers in local tables and return the trimmed
 * payload for each. Never throws — per-entity failures are swallowed and
 * logged as warnings. Callers receive only the entities we successfully
 * enriched.
 */
export async function enrichEntities(input: EnrichEntitiesInput): Promise<BizzAssistEntity[]> {
  const admin = createAdminClient();
  const out: BizzAssistEntity[] = [];

  const cvrs = Array.from(new Set(input.cvrs)).slice(0, MAX_ENTITIES_PER_TYPE);
  const bfes = Array.from(new Set(input.bfes)).slice(0, MAX_ENTITIES_PER_TYPE);

  // ─── CVR enrichment (local cvr_virksomhed) ───────────────────────────────
  if (cvrs.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = (await (admin as any)
        .from('cvr_virksomhed')
        .select(
          'cvr, navn, adresse_json, branche_kode, branche_tekst, stiftet, ophoert, status, virksomhedsform, ansatte_aar'
        )
        .in('cvr', cvrs)) as {
        data: Array<Record<string, unknown>> | null;
        error: { message: string } | null;
      };
      if (error) {
        logger.warn('[enrichEntities] cvr fetch failed:', error.message);
      } else {
        for (const row of data ?? []) {
          const cvr = String(row.cvr);
          const payload = {
            cvr,
            navn: row.navn,
            adresse: row.adresse_json,
            branche_kode: row.branche_kode,
            branche_tekst: row.branche_tekst,
            stiftet: row.stiftet,
            ophoert: row.ophoert,
            status: row.status,
            virksomhedsform: row.virksomhedsform,
            ansatte_aar: row.ansatte_aar,
          };
          out.push({
            kind: 'cvr',
            id: cvr,
            data: trimJsonChars(payload),
          });
        }
      }
    } catch (err) {
      logger.warn('[enrichEntities] cvr block threw:', err);
    }
  }

  // ─── BFE enrichment: current owner chain + BBR areas ─────────────────────
  if (bfes.length > 0) {
    const numericBfes = bfes.map((b) => parseInt(b, 10)).filter((n) => Number.isFinite(n));

    // Local ejf_ejerskab for current owners (status=gældende) in one batch
    let ownerMap = new Map<number, Array<Record<string, unknown>>>();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = (await (admin as any)
        .from('ejf_ejerskab')
        .select('bfe_nummer, ejer_navn, ejer_cvr, ejer_type, andel, virkning_fra, status')
        .in('bfe_nummer', numericBfes)
        .eq('status', 'gældende')) as { data: Array<Record<string, unknown>> | null };
      for (const row of data ?? []) {
        const bfeKey = Number(row.bfe_nummer);
        const arr = ownerMap.get(bfeKey) ?? [];
        arr.push(row);
        ownerMap.set(bfeKey, arr);
      }
    } catch (err) {
      logger.warn('[enrichEntities] ejf_ejerskab batch failed:', err);
      ownerMap = new Map();
    }

    // BBR areas per BFE — kept serial to avoid hammering Datafordeler with
    // a burst, but capped by MAX_ENTITIES_PER_TYPE so worst-case = 8 calls.
    for (const bfeStr of bfes) {
      const bfe = parseInt(bfeStr, 10);
      if (!Number.isFinite(bfe)) continue;
      let areas: Awaited<ReturnType<typeof fetchBbrAreasByBfe>> = null;
      try {
        areas = await fetchBbrAreasByBfe(bfe);
      } catch (err) {
        logger.warn('[enrichEntities] bbr areas failed:', bfe, err);
      }
      const owners = ownerMap.get(bfe) ?? [];
      const payload = {
        bfe,
        areas: areas ?? null,
        current_owners: owners.map((o) => ({
          navn: o.ejer_navn,
          cvr: o.ejer_cvr,
          type: o.ejer_type,
          andel: o.andel,
          siden: o.virkning_fra,
        })),
      };
      out.push({
        kind: 'bfe',
        id: bfeStr,
        data: trimJsonChars(payload),
      });
    }
  }

  return out;
}

/**
 * Trim a payload by JSON-stringifying and slicing to PER_ENTITY_CHAR_CAP.
 * Keeps the shape a parseable string so the prompt-builder can embed the
 * JSON verbatim without worrying about deep-nested length surprises.
 */
function trimJsonChars(payload: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    return '{}';
  }
  if (json.length <= PER_ENTITY_CHAR_CAP) return json;
  return json.slice(0, PER_ENTITY_CHAR_CAP - 12) + '…[truncated]';
}
