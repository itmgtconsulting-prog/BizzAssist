/**
 * Shared EJF ingestion helpers — extracted from /api/cron/ingest-ejf-bulk.
 *
 * BIZZ-650: Tinglysning delta-sync cron (/api/cron/pull-tinglysning-aendringer)
 * reuses these functions to upsert ejf_ejerskab rows without duplicating
 * mapping/validation logic across routes.
 *
 * Exports:
 *   - `EjfRow` type — matches public.ejf_ejerskab columns
 *   - `RawEjfNode` type — GraphQL response shape for EJFCustom_EjerskabBegraenset
 *   - `mapNodeToRow()` — EJF node → EjfRow (skip invalid)
 *   - `upsertEjfBatch()` — dedup + batch upsert with composite PK
 *   - `fetchEjerskabForBFE()` — GraphQL lookup of all ejerskab for a single BFE
 *   - `getEjfToken()` — OAuth token (shared-secret → cert fallback)
 *
 * @module app/lib/ejfIngest
 */

import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { EJF_GQL_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { logger } from '@/app/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Rå EJF-node fra GraphQL (EJFCustom_EjerskabBegraenset) */
export interface RawEjfNode {
  bestemtFastEjendomBFENr: number | null;
  ejerforholdskode: string | null;
  faktiskEjerandel_taeller: number | null;
  faktiskEjerandel_naevner: number | null;
  virkningFra: string | null;
  virkningTil: string | null;
  status: string | null;
  ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref: {
    CVRNummer: number | null;
  } | null;
  ejendePersonBegraenset: {
    id: string | null;
    navn: { navn: string | null } | null;
    foedselsdato: string | null;
  } | null;
}

/** Row shape for ejf_ejerskab upsert — matches migration 046 schema */
export interface EjfRow {
  bfe_nummer: number;
  ejer_ejf_id: string;
  virkning_fra: string;
  ejer_navn: string;
  ejer_foedselsdato: string | null;
  ejer_cvr: string | null;
  ejer_type: 'person' | 'virksomhed';
  ejerandel_taeller: number | null;
  ejerandel_naevner: number | null;
  status: string;
  virkning_til: string | null;
  sidst_opdateret: string;
}

// ─── OAuth token ──────────────────────────────────────────────────────────────

/**
 * Henter OAuth-token via shared secret (primær) eller certifikat (fallback).
 * Returnerer null hvis begge metoder fejler.
 */
export async function getEjfToken(): Promise<string | null> {
  const token = await getSharedOAuthToken().catch(() => null);
  if (token) return token;
  if (isCertAuthConfigured()) {
    return getCertOAuthToken().catch(() => null);
  }
  return null;
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

/**
 * Mapper en rå EJF GraphQL-node til en ejf_ejerskab row.
 * Returnerer null hvis noden mangler kritiske felter (bfe, ejer-identifikation).
 *
 * Identifikation:
 *   - Person: ejer_ejf_id = person.id (UUID fra EJF), ejer_cvr = null
 *   - Virksomhed: ejer_ejf_id = `virk-<CVR>` (stable), ejer_foedselsdato = null
 */
export function mapNodeToRow(node: RawEjfNode): EjfRow | null {
  const bfe = node.bestemtFastEjendomBFENr;
  if (bfe == null) return null;

  const person = node.ejendePersonBegraenset;
  const virksomhedRef = node.ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref;
  const cvr = virksomhedRef?.CVRNummer ? String(virksomhedRef.CVRNummer) : null;
  const personNavn = person?.navn?.navn ?? null;
  const personId = person?.id ?? null;
  const foedselsdato = person?.foedselsdato ?? null;

  let ejerType: 'person' | 'virksomhed';
  let ejfId: string;
  let navn: string;

  if (personId && personNavn) {
    ejerType = 'person';
    ejfId = personId;
    navn = personNavn;
  } else if (cvr) {
    ejerType = 'virksomhed';
    ejfId = `virk-${cvr}`;
    navn = `CVR ${cvr}`;
  } else {
    return null;
  }

  const virkningFra = node.virkningFra ?? new Date(0).toISOString();
  const rawStatus = (node.status ?? '').toLowerCase();
  const status = rawStatus.includes('historisk') ? 'historisk' : 'gældende';

  return {
    bfe_nummer: bfe,
    ejer_ejf_id: ejfId,
    virkning_fra: virkningFra,
    ejer_navn: navn,
    ejer_foedselsdato: ejerType === 'person' ? foedselsdato : null,
    ejer_cvr: ejerType === 'virksomhed' ? cvr : null,
    ejer_type: ejerType,
    ejerandel_taeller: node.faktiskEjerandel_taeller ?? null,
    ejerandel_naevner: node.faktiskEjerandel_naevner ?? null,
    status,
    virkning_til: node.virkningTil ?? null,
    sidst_opdateret: new Date().toISOString(),
  };
}

// ─── Batch upsert ─────────────────────────────────────────────────────────────

/**
 * Dedupliker på composite PK + batch upsert til ejf_ejerskab.
 *
 * Postgres ON CONFLICT kan ikke håndtere samme key to gange i én statement.
 * Vi dedupliker først in-memory — sidste forekomst vinder (EJF kan returnere
 * samme record flere gange ved historiske virkning_til-ændringer).
 *
 * @param table - Supabase table-handle (admin.from('ejf_ejerskab'))
 * @param batch - Rows to upsert
 * @returns { upserted, failed } — upserted tæller dupes for statistik-konsistens
 */
export async function upsertEjfBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  batch: EjfRow[]
): Promise<{ upserted: number; failed: number }> {
  if (batch.length === 0) return { upserted: 0, failed: 0 };

  const seen = new Map<string, EjfRow>();
  for (const row of batch) {
    const key = `${row.bfe_nummer}|${row.ejer_ejf_id}|${row.virkning_fra}`;
    seen.set(key, row);
  }
  const deduped = Array.from(seen.values());
  const dupesRemoved = batch.length - deduped.length;

  const { error } = await table.upsert(deduped, {
    onConflict: 'bfe_nummer,ejer_ejf_id,virkning_fra',
    ignoreDuplicates: false,
  });
  if (error) {
    logger.error('[ejfIngest] Batch upsert fejl:', error.message);
    return { upserted: 0, failed: batch.length };
  }
  return { upserted: deduped.length + dupesRemoved, failed: 0 };
}

// ─── Per-BFE lookup ───────────────────────────────────────────────────────────

interface EjerskabGqlResponse {
  data?: {
    EJFCustom_EjerskabBegraenset?: { nodes: RawEjfNode[] };
  };
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * Henter alle ejerskab-records for en specifik BFE fra EJFCustom_EjerskabBegraenset.
 *
 * BIZZ-650: Bruges af delta-sync cron efter Tinglysning aendringer har listet
 * de BFE'er der er ændret i et givet interval. Vi slår derfor kun op på
 * BFE'er der faktisk har aktivitet — meget billigere end fuld bulk-scan.
 *
 * @param bfe - BFE-nummer
 * @param token - OAuth bearer token (fra getEjfToken)
 * @returns Array af RawEjfNode, eller null ved fetch-fejl
 */
export async function fetchEjerskabForBFE(
  bfe: number,
  token: string
): Promise<RawEjfNode[] | null> {
  const vt = new Date().toISOString();
  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${vt}"
      where: { bestemtFastEjendomBFENr: { eq: ${bfe} } }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        virkningFra
        virkningTil
        status
        ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref {
          CVRNummer
        }
        ejendePersonBegraenset {
          id
          navn { navn }
          foedselsdato
        }
      }
    }
  }`;

  try {
    const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    if (!res.ok) {
      logger.warn(`[ejfIngest] fetchEjerskabForBFE(${bfe}) HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as EjerskabGqlResponse;
    if (json.errors?.length) {
      logger.warn(`[ejfIngest] fetchEjerskabForBFE(${bfe}) GraphQL fejl:`, json.errors[0].message);
      return null;
    }
    return json.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];
  } catch (err) {
    logger.error(
      `[ejfIngest] fetchEjerskabForBFE(${bfe}) exception:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
