/**
 * Direct EJF ejere lookup — bypasses HTTP self-call overhead.
 *
 * BIZZ-1582: Extracted from /api/ejerskab/route.ts so that
 * /api/ejerskab/chain can call this directly instead of making an
 * internal HTTP request (which adds 100-300ms of Vercel-edge + auth
 * overhead per call).
 *
 * The logic mirrors the route handler: cache-first from ejf_ejerskab
 * table → live EJF GraphQL → filter historisk → enrich with CVR status.
 *
 * @module app/lib/ejerskab/fetchEjfEjereDirekt
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { hentCvrStatusBatch } from '@/app/lib/cvrStatus';
import type { EjerData } from '@/app/api/ejerskab/route';

// ─── EJF GraphQL ────────────────────────────────────────────────────────────

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';

/** Raw node from EJFCustom_EjerskabBegraenset */
interface RawEJFEjerskab {
  bestemtFastEjendomBFENr: number | null;
  ejendeVirksomhedCVRNr: number | null;
  ejendePersonBegraenset: { navn: { navn: string } | null } | null;
  ejerforholdskode: string | null;
  faktiskEjerandel_taeller: number | null;
  faktiskEjerandel_naevner: number | null;
  status: string | null;
  virkningFra: string | null;
  oplysningerEjesAfEjerskab?: {
    fiktivtPVnummer?: string | null;
    navn?: string | null;
    landeKodeNumerisk?: string | null;
    adresselinje1?: string | null;
    adresselinje2?: string | null;
    adresselinje3?: string | null;
    adresselinje4?: string | null;
    adresselinje5?: string | null;
  } | null;
  ejerskabAdministreresAfPersonEllerVirksomhedsoplysninger?: {
    navn?: string | null;
  } | null;
}

type EJFQueryResult =
  | { ok: true; nodes: RawEJFEjerskab[] }
  | { ok: false; manglerAdgang: boolean; fejl: string | null };

/**
 * Sends EJF GraphQL query with a given Bearer token.
 */
async function queryEJF(bfeNummer: number, token: string): Promise<EJFQueryResult> {
  const virkningstid = new Date().toISOString();

  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${virkningstid}"
      where: {
        bestemtFastEjendomBFENr: { eq: ${bfeNummer} }
      }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejendeVirksomhedCVRNr
        ejendePersonBegraenset { navn { navn } }
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        status
        virkningFra
      }
    }
  }`;

  const res = await fetch(proxyUrl(EJF_GQL_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...proxyHeaders(),
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(proxyTimeout()),
    next: { revalidate: 3600 },
  });

  if (res.status === 403) return { ok: false, manglerAdgang: true, fejl: null };

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(`[ejerskab/direkt] Datafordeler EJF HTTP ${res.status}: ${text.slice(0, 400)}`);
    return { ok: false, manglerAdgang: false, fejl: 'Ekstern API fejl' };
  }

  const json = (await res.json()) as {
    data?: { EJFCustom_EjerskabBegraenset?: { nodes: RawEJFEjerskab[] } };
    errors?: { message: string; extensions?: { code?: string } }[];
  };

  const authError = json.errors?.find((e) => e.extensions?.code === 'DAF-AUTH-0001');
  if (authError) return { ok: false, manglerAdgang: true, fejl: null };

  return { ok: true, nodes: json.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [] };
}

/**
 * Determine ejertype from a raw EJF node.
 */
function parseEjertypeFraNode(raw: RawEJFEjerskab): 'selskab' | 'person' | 'pvoplys' | 'ukendt' {
  if (raw.ejendeVirksomhedCVRNr != null) return 'selskab';
  if (raw.ejendePersonBegraenset != null) return 'person';
  if (raw.oplysningerEjesAfEjerskab?.fiktivtPVnummer) return 'pvoplys';
  // Fallback via ejerforholdskode
  const kode = raw.ejerforholdskode;
  if (!kode) return 'ukendt';
  const k = kode.toUpperCase().trim();
  const num = parseInt(k, 10);
  if (!isNaN(num)) {
    if (num >= 10 && num < 20) return 'person';
    if (num >= 20 && num < 40) return 'selskab';
  }
  if (k === 'S' || k === 'SELSKAB' || k === 'K') return 'selskab';
  if (k === 'P' || k === 'PERSON' || k === 'F') return 'person';
  return 'ukendt';
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface EjfEjereResult {
  ejere: EjerData[];
  fejl: string | null;
}

/**
 * Henter EJF ejere direkte (uden HTTP self-call).
 *
 * 1. Cache-first: tjekker ejf_ejerskab tabel (7.6M rows)
 * 2. Live: OAuth → EJF GraphQL → parse → filter ophørte CVR'er
 *
 * @param bfeNummer - BFE-nummer at slå op
 * @returns Ejere-array + eventuel fejlbesked
 */
export async function fetchEjfEjereDirekt(bfeNummer: number): Promise<EjfEjereResult> {
  // ── Cache-first: ejf_ejerskab tabel ──
  try {
    const admin = createAdminClient();
    const EJF_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dage — ejerskab ændres sjældent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached, error: cacheErr } = await (admin as any)
      .from('ejf_ejerskab')
      .select(
        'ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, virkning_fra, status, sidst_opdateret'
      )
      .eq('bfe_nummer', bfeNummer)
      .eq('status', 'gældende');

    if (!cacheErr && cached && cached.length > 0) {
      const freshest = cached[0]?.sidst_opdateret
        ? new Date(cached[0].sidst_opdateret).getTime()
        : 0;
      if (Date.now() - freshest < EJF_STALE_MS) {
        const ejere: EjerData[] = (
          cached as Array<{
            ejer_navn: string | null;
            ejer_cvr: string | null;
            ejer_type: string | null;
            ejerandel_taeller: number | null;
            ejerandel_naevner: number | null;
            virkning_fra: string | null;
          }>
        ).map((row) => ({
          cvr: row.ejer_cvr,
          personNavn: row.ejer_type === 'person' ? row.ejer_navn : null,
          ejerandel_taeller: row.ejerandel_taeller,
          ejerandel_naevner: row.ejerandel_naevner,
          ejerforholdskode: null,
          ejertype: (row.ejer_type === 'selskab'
            ? 'selskab'
            : row.ejer_type === 'person'
              ? 'person'
              : 'ukendt') as EjerData['ejertype'],
          virkningFra: row.virkning_fra,
          virksomhedsnavn: row.ejer_type === 'selskab' ? row.ejer_navn : null,
        }));
        logger.log(`[ejerskab/direkt] Cache hit: ${ejere.length} ejere for BFE ${bfeNummer}`);
        return { ejere, fejl: null };
      }
    }
  } catch (err) {
    logger.warn('[ejerskab/direkt] Cache lookup fejl:', err instanceof Error ? err.message : err);
  }

  // ── Live EJF query ──
  const hasSharedSecret = !!(
    process.env.DATAFORDELER_OAUTH_CLIENT_ID && process.env.DATAFORDELER_OAUTH_CLIENT_SECRET
  );
  const hasCert = isCertAuthConfigured();

  if (!hasSharedSecret && !hasCert) {
    return { ejere: [], fejl: null };
  }

  let result: EJFQueryResult | null = null;

  if (hasSharedSecret) {
    const token = await getSharedOAuthToken();
    if (token) {
      try {
        result = await queryEJF(bfeNummer, token);
      } catch (err) {
        logger.error(
          '[ejerskab/direkt] Shared Secret fejl:',
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  if ((!result || (!result.ok && result.manglerAdgang)) && hasCert) {
    const certToken = await getCertOAuthToken();
    if (certToken) {
      try {
        result = await queryEJF(bfeNummer, certToken);
      } catch (err) {
        logger.error(
          '[ejerskab/direkt] Certifikat fejl:',
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  if (!result || !result.ok) {
    return { ejere: [], fejl: result && !result.ok ? result.fejl : null };
  }

  const nodes = result.nodes;
  if (!nodes.length) return { ejere: [], fejl: null };

  // Filter historisk
  const gaeldendeNodes = nodes.filter((n) => !n.status || n.status.toLowerCase() !== 'historisk');

  const raaEjere: EjerData[] = gaeldendeNodes.map((n) => {
    const ejertype = parseEjertypeFraNode(n);
    const pv = n.oplysningerEjesAfEjerskab ?? null;
    const adresseLinjer = pv
      ? [pv.adresselinje1, pv.adresselinje2, pv.adresselinje3, pv.adresselinje4, pv.adresselinje5]
          .map((l) => (typeof l === 'string' ? l.trim() : ''))
          .filter((l) => l.length > 0)
      : [];
    const pvNavn = ejertype === 'pvoplys' ? (pv?.navn ?? null) : null;
    return {
      cvr: n.ejendeVirksomhedCVRNr != null ? String(n.ejendeVirksomhedCVRNr) : null,
      personNavn: n.ejendePersonBegraenset?.navn?.navn ?? pvNavn,
      ejerandel_taeller: n.faktiskEjerandel_taeller ?? null,
      ejerandel_naevner: n.faktiskEjerandel_naevner ?? null,
      ejerforholdskode: n.ejerforholdskode ?? null,
      ejertype,
      virkningFra: n.virkningFra ?? null,
      fiktivtPVnummer: pv?.fiktivtPVnummer ?? null,
      landekode: pv?.landeKodeNumerisk ?? null,
      udlandsadresse: adresseLinjer.length > 0 ? adresseLinjer.join(', ') : null,
      administrator: n.ejerskabAdministreresAfPersonEllerVirksomhedsoplysninger?.navn ?? null,
    };
  });

  // Filter ophørte CVR'er + berig med virksomhedsnavn
  const cvrIds = raaEjere
    .map((e) => e.cvr)
    .filter((c): c is string => !!c)
    .map((c) => parseInt(c, 10))
    .filter((n) => Number.isFinite(n));

  const statusMap = cvrIds.length > 0 ? await hentCvrStatusBatch(cvrIds) : new Map();

  const ejere: EjerData[] = raaEjere
    .filter((e) => {
      if (!e.cvr) return true;
      const status = statusMap.get(parseInt(e.cvr, 10));
      return !status?.isCeased;
    })
    .map((e) => {
      if (!e.cvr) return e;
      const status = statusMap.get(parseInt(e.cvr, 10));
      return { ...e, virksomhedsnavn: status?.navn ?? null };
    });

  return { ejere, fejl: null };
}
