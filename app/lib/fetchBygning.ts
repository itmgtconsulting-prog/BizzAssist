/**
 * BIZZ-796: Hent enkelt BBR_Bygning via id_lokalId.
 *
 * Bruges af /dashboard/ejendomme/bygning/[bygningId]-siden. Query'en er
 * minimal — henter kun felter nødvendige til detalje-header. Komplet
 * enheds-liste fetches separat via eksisterende BBR_Enhed-query.
 *
 * Null ved fejl/not-found. Caller viser 404-side.
 */

import { fetchBBRGraphQL } from './fetchBbrData';
import { logger } from './logger';

/** Formatted virkningstid-stamp matcher darQuery-konventionen. */
function nowTs(): string {
  return new Date().toISOString();
}

export interface BygningDetail {
  id: string;
  /** BBR byg021BygningensAnvendelse — fx "120 Parcelhus" */
  anvendelse: string | null;
  /** Opførelsesår (byg026) */
  opfoerelsesaar: number | null;
  /** Om/tilbygningsår (byg027) */
  ombygningsaar: number | null;
  /** Samlet bygningsareal m² (byg038) */
  samletBygningsareal: number | null;
  /** Samlet boligareal m² (byg039) */
  samletBoligAreal: number | null;
  /** Samlet erhvervsareal m² (byg040) */
  samletErhvervsAreal: number | null;
  /** Bebygget areal m² (byg041) */
  bebyggetAreal: number | null;
  /** Antal etager (byg054) */
  antalEtager: number | null;
  /** BBR-status streng (fx "Bygning opført", "Nedrevet/slettet") */
  status: string | null;
  /** Husnummer-UUID (DAR adgangsadresse_id) — bruges til drill-down til adresse */
  husnummerId: string | null;
}

/**
 * Henter BBR_Bygning fra Datafordeler GraphQL på id_lokalId. Returnerer
 * null hvis bygningen ikke findes eller ved netværks-fejl.
 *
 * @param id - BBR bygning id_lokalId (UUID)
 */
export async function fetchBygningById(id: string): Promise<BygningDetail | null> {
  const vt = nowTs();
  const query = `query($vt: DafDateTime!, $id: String!) {
    BBR_Bygning(first: 1, virkningstid: $vt, where: { id_lokalId: { eq: $id } }) {
      nodes {
        id_lokalId
        byg021BygningensAnvendelse
        byg026Opfoerelsesaar
        byg027OmTilbygningsaar
        byg038SamletBygningsareal
        byg039BygningensSamledeBoligAreal
        byg040BygningensSamledeErhvervsAreal
        byg041BebyggetAreal
        byg054AntalEtager
        status
        husnummer
      }
    }
  }`;
  try {
    const nodes = await fetchBBRGraphQL(query, { vt, id });
    if (!Array.isArray(nodes) || nodes.length === 0) return null;
    const row = nodes[0] as Record<string, unknown>;
    return {
      id: String(row.id_lokalId ?? id),
      anvendelse: (row.byg021BygningensAnvendelse as string) ?? null,
      opfoerelsesaar: (row.byg026Opfoerelsesaar as number) ?? null,
      ombygningsaar: (row.byg027OmTilbygningsaar as number) ?? null,
      samletBygningsareal: (row.byg038SamletBygningsareal as number) ?? null,
      samletBoligAreal: (row.byg039BygningensSamledeBoligAreal as number) ?? null,
      samletErhvervsAreal: (row.byg040BygningensSamledeErhvervsAreal as number) ?? null,
      bebyggetAreal: (row.byg041BebyggetAreal as number) ?? null,
      antalEtager: (row.byg054AntalEtager as number) ?? null,
      status: (row.status as string) ?? null,
      husnummerId: (row.husnummer as string) ?? null,
    };
  } catch (err) {
    logger.error('[fetchBygningById] fejl:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * BIZZ-834: Enheder i en bygning. Returnerer alle BBR_Enhed-rows hvor
 * bygning_lokalId === bygningId. Cappet til 100 for safety.
 */
export interface EnhedSummary {
  id: string;
  etage: string | null;
  doer: string | null;
  anvendelse: string | null;
  areal: number | null;
  status: string | null;
}

export async function fetchEnhederForBygning(bygningId: string): Promise<EnhedSummary[]> {
  const vt = nowTs();
  const query = `query($vt: DafDateTime!, $id: String!) {
    BBR_Enhed(first: 100, virkningstid: $vt, where: { bygning: { eq: $id } }) {
      nodes {
        id_lokalId
        etage
        doer
        enh020EnhedensAnvendelse
        enh026EnhedensSamledeAreal
        status
      }
    }
  }`;
  try {
    const nodes = await fetchBBRGraphQL(query, { vt, id: bygningId });
    if (!Array.isArray(nodes)) return [];
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return (nodes as Array<Record<string, unknown>>).map((n) => ({
      id: String(n.id_lokalId ?? ''),
      // etage/doer-felterne fra BBR er ofte UUIDs der peger på et kodesæt
      // — filtrér så vi kun viser menneske-læsbare strings (fx "1", "tv").
      etage: typeof n.etage === 'string' && !UUID_RE.test(n.etage) ? n.etage : null,
      doer: typeof n.doer === 'string' && !UUID_RE.test(n.doer) ? n.doer : null,
      anvendelse: (n.enh020EnhedensAnvendelse as string | null) ?? null,
      areal: (n.enh026EnhedensSamledeAreal as number | null) ?? null,
      status: (n.status as string | null) ?? null,
    }));
  } catch (err) {
    logger.error('[fetchEnhederForBygning] fejl:', err instanceof Error ? err.message : err);
    return [];
  }
}
