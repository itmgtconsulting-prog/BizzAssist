/**
 * BIZZ-826 iter 2d — løbende sync af bbr_ejendom_status.
 *
 * Ugentlig cron der genopfrisker stale rows i bbr_ejendom_status så
 * backfilled data ikke driver fra BBR's live-state over tid.
 *
 * Strategi (Option A fra ticket): Cap 5000 rows pr run der ikke er
 * tjekket de sidste 7 dage. Paginér derigennem over 7 søndage → komplet
 * dækning ~hver 2. måned givet typisk ~46k ejendomme.
 *
 * BIZZ-907: Refaktoreret til BBR v2 3-step pipeline via fetchBBRGraphQL
 * (API-key + proxy). Matcher scripts/backfill-bbr-status.mjs (BIZZ-903):
 *   1. BBR_Ejendomsrelation(bfeNummer) → ejendoms-UUID
 *   2. BBR_Grund(bestemtFastEjendom) → grund-UUID + kommunekode
 *   3. BBR_Bygning(grund) → status + areal + aar + anvendelse
 * Konsolidér is_udfaset = alle bygninger har retired-status {4,10,11}.
 *
 * Schedule: søndag 02:00 UTC = '0 2 * * 0' i vercel.json.
 *
 * Security: CRON_SECRET bearer + x-vercel-cron=1 i produktion.
 *
 * @module api/cron/refresh-ejendom-status
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { BBR_STATUS_UDFASET } from '@/app/lib/bbrKoder';
import { fetchBBRGraphQL } from '@/app/lib/fetchBbrData';

const BATCH_SIZE = 50; // BFE'er pr BBR-kald
const PER_RUN_CAP = 5000; // max rows pr cron-tur
const STALE_DAYS = 7;

/**
 * Verificerer CRON_SECRET bearer + x-vercel-cron (i produktion).
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/** BIZZ-907: Resultat-shape fra v2 3-step BBR-lookup */
interface BbrStatusResult {
  is_udfaset: boolean;
  bbr_status_code: number | null;
  adgangsadresse_id: string | null;
  kommune_kode: number | null;
  samlet_boligareal: number | null;
  opfoerelsesaar: number | null;
  byg021_anvendelse: number | null;
}

/**
 * BIZZ-907: BBR v2 3-step lookup for en batch BFE'er.
 *
 * Bruger fetchBBRGraphQL fra fetchBbrData.ts (API-key + proxy) i stedet
 * for direkte Basic auth (BIZZ-903 pattern).
 *
 *   1. BBR_Ejendomsrelation(bfeNummer) → ejendoms-UUID
 *   2. BBR_Grund(bestemtFastEjendom) → grund-UUID + kommunekode + husnummer
 *   3. BBR_Bygning(grund) → status + areal + aar + anvendelse
 *
 * Dedup bygninger (BIZZ-575: v2 returnerer duplikater).
 */
async function fetchBbrStatusForBfeBatch(
  bfeNumre: number[]
): Promise<Map<number, BbrStatusResult>> {
  if (bfeNumre.length === 0) return new Map();
  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

  // Step 1: BFE → Ejendomsrelation
  const bfeList = bfeNumre.join(',');
  const ejNodes = (await fetchBBRGraphQL(
    `{ BBR_Ejendomsrelation(first: 500, virkningstid: "${vt}", where: { bfeNummer: { in: [${bfeList}] } }) {
        nodes { bfeNummer ejendomstype id_lokalId }
    } }`,
    {}
  )) as Array<{ bfeNummer: number; ejendomstype: string; id_lokalId: string }> | null;

  if (!ejNodes || ejNodes.length === 0) return new Map();

  const bfeToEjd = new Map<number, string>();
  for (const e of ejNodes) {
    const bfe = Number(e.bfeNummer);
    if (Number.isFinite(bfe) && !bfeToEjd.has(bfe)) bfeToEjd.set(bfe, e.id_lokalId);
  }

  // Step 2: Ejendoms-UUID → Grund
  const ejdIds = [...new Set(bfeToEjd.values())];
  const idList = ejdIds.map((id) => `"${id}"`).join(',');
  const grundNodes = (await fetchBBRGraphQL(
    `{ BBR_Grund(first: 500, virkningstid: "${vt}", where: { bestemtFastEjendom: { in: [${idList}] } }) {
        nodes { id_lokalId kommunekode bestemtFastEjendom husnummer }
    } }`,
    {}
  )) as Array<{
    id_lokalId: string;
    kommunekode: string | null;
    bestemtFastEjendom: string;
    husnummer: string | null;
  }> | null;

  const ejdToGrund = new Map<
    string,
    { grundIds: string[]; kommune_kode: number | null; adgangsadresse_id: string | null }
  >();
  for (const g of grundNodes ?? []) {
    const ejdId = g.bestemtFastEjendom;
    if (!ejdId) continue;
    if (!ejdToGrund.has(ejdId)) {
      ejdToGrund.set(ejdId, { grundIds: [], kommune_kode: null, adgangsadresse_id: null });
    }
    const entry = ejdToGrund.get(ejdId)!;
    if (g.id_lokalId && !entry.grundIds.includes(g.id_lokalId)) entry.grundIds.push(g.id_lokalId);
    if (!entry.kommune_kode && g.kommunekode != null) {
      entry.kommune_kode = parseInt(String(g.kommunekode), 10) || null;
    }
    if (!entry.adgangsadresse_id && g.husnummer) entry.adgangsadresse_id = g.husnummer;
  }

  // Step 3: Grund-UUID → Bygninger
  const allGrundIds = [...new Set([...ejdToGrund.values()].flatMap((e) => e.grundIds))];
  const bygNodes: Array<{
    id_lokalId: string;
    status: string;
    grund: string;
    byg038SamletBygningsareal: number | null;
    byg039BygningensSamledeBoligAreal: number | null;
    byg026Opfoerelsesaar: number | null;
    byg021BygningensAnvendelse: string | null;
  }> = [];

  if (allGrundIds.length > 0) {
    const gidList = allGrundIds.map((id) => `"${id}"`).join(',');
    const raw = (await fetchBBRGraphQL(
      `{ BBR_Bygning(first: 500, virkningstid: "${vt}", where: { grund: { in: [${gidList}] } }) {
          nodes {
            id_lokalId status grund
            byg038SamletBygningsareal byg039BygningensSamledeBoligAreal
            byg026Opfoerelsesaar byg021BygningensAnvendelse
          }
      } }`,
      {}
    )) as typeof bygNodes | null;
    // Dedup (BIZZ-575)
    const seen = new Set<string>();
    for (const b of raw ?? []) {
      if (b.id_lokalId && seen.has(b.id_lokalId)) continue;
      if (b.id_lokalId) seen.add(b.id_lokalId);
      bygNodes.push(b);
    }
  }

  // Grupper bygninger per grund
  const grundToByg = new Map<string, typeof bygNodes>();
  for (const b of bygNodes) {
    if (!b.grund) continue;
    if (!grundToByg.has(b.grund)) grundToByg.set(b.grund, []);
    grundToByg.get(b.grund)!.push(b);
  }

  // Konsolider per BFE
  const result = new Map<number, BbrStatusResult>();
  for (const [bfe, ejdId] of bfeToEjd) {
    const grundInfo = ejdToGrund.get(ejdId);
    const bygninger = (grundInfo?.grundIds ?? []).flatMap((gid) => grundToByg.get(gid) ?? []);

    if (bygninger.length === 0) {
      result.set(bfe, {
        is_udfaset: false,
        bbr_status_code: null,
        adgangsadresse_id: grundInfo?.adgangsadresse_id ?? null,
        kommune_kode: grundInfo?.kommune_kode ?? null,
        samlet_boligareal: null,
        opfoerelsesaar: null,
        byg021_anvendelse: null,
      });
      continue;
    }

    const allRetired = bygninger.every((b) => BBR_STATUS_UDFASET.has(Number(b.status)));

    let primaryStatus: number | null = null;
    let primaryAnvendelse: number | null = null;
    let maxArea = -1;
    let sumBoligareal = 0;
    let hasBoligareal = false;
    let minOpfoerelsesaar = Infinity;
    let hasOpfoerelsesaar = false;

    for (const b of bygninger) {
      const area = Number(b.byg038SamletBygningsareal) || 0;
      const s = Number(b.status);
      if (Number.isFinite(s) && area > maxArea) {
        maxArea = area;
        primaryStatus = s;
        const anv =
          b.byg021BygningensAnvendelse != null
            ? parseInt(String(b.byg021BygningensAnvendelse), 10)
            : null;
        if (anv != null && Number.isFinite(anv)) primaryAnvendelse = anv;
      }
      const bolig = Number(b.byg039BygningensSamledeBoligAreal);
      if (Number.isFinite(bolig) && bolig > 0) {
        sumBoligareal += bolig;
        hasBoligareal = true;
      }
      const aar = Number(b.byg026Opfoerelsesaar);
      if (Number.isFinite(aar) && aar > 1000 && aar < minOpfoerelsesaar) {
        minOpfoerelsesaar = aar;
        hasOpfoerelsesaar = true;
      }
    }

    result.set(bfe, {
      is_udfaset: allRetired,
      bbr_status_code: primaryStatus,
      adgangsadresse_id: grundInfo?.adgangsadresse_id ?? null,
      kommune_kode: grundInfo?.kommune_kode ?? null,
      samlet_boligareal: hasBoligareal ? sumBoligareal : null,
      opfoerelsesaar: hasOpfoerelsesaar ? minOpfoerelsesaar : null,
      byg021_anvendelse: primaryAnvendelse,
    });
  }

  return result;
}

/**
 * GET endpoint (Vercel cron). Refresher bbr_ejendom_status-rows
 * ældre end 7 dage, cap 5000 pr run.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stale, error: fetchErr } = await (admin as any)
    .from('bbr_ejendom_status')
    .select('bfe_nummer, is_udfaset, bbr_status_code')
    .lt('status_last_checked_at', cutoff)
    .order('status_last_checked_at', { ascending: true })
    .limit(PER_RUN_CAP);

  if (fetchErr) {
    logger.error('[refresh-ejendom-status] fetch fejlede:', fetchErr.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  const rows = (stale ?? []) as Array<{
    bfe_nummer: number;
    is_udfaset: boolean;
    bbr_status_code: number | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, changed: 0, note: 'no stale rows' });
  }

  // Current-state lookup så vi kan tælle changed-count
  const currentByBfe = new Map<number, { is_udfaset: boolean; bbr_status_code: number | null }>();
  for (const r of rows) {
    currentByBfe.set(r.bfe_nummer, {
      is_udfaset: r.is_udfaset,
      bbr_status_code: r.bbr_status_code,
    });
  }

  let checked = 0;
  let changed = 0;
  let upserted = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE).map((r) => r.bfe_nummer);

    let statusMap: Map<number, BbrStatusResult>;
    try {
      statusMap = await fetchBbrStatusForBfeBatch(chunk);
    } catch (err) {
      failed += chunk.length;
      logger.warn('[refresh-ejendom-status] batch fejl:', (err as Error)?.message ?? 'unknown');
      continue;
    }

    const upsertRows = [];
    for (const bfe of chunk) {
      const entry = statusMap.get(bfe);
      if (!entry) continue;
      checked++;
      const current = currentByBfe.get(bfe);
      if (
        current &&
        (current.is_udfaset !== entry.is_udfaset ||
          current.bbr_status_code !== entry.bbr_status_code)
      ) {
        changed++;
      }
      upsertRows.push({
        bfe_nummer: bfe,
        adgangsadresse_id: entry.adgangsadresse_id,
        is_udfaset: entry.is_udfaset,
        bbr_status_code: entry.bbr_status_code,
        kommune_kode: entry.kommune_kode,
        status_last_checked_at: nowIso,
        // BIZZ-907: berigelse-felter (BIZZ-821 phase-2)
        samlet_boligareal: entry.samlet_boligareal,
        opfoerelsesaar: entry.opfoerelsesaar,
        byg021_anvendelse: entry.byg021_anvendelse,
        berigelse_sidst: nowIso,
      });
    }

    if (upsertRows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upsertErr } = await (admin as any)
        .from('bbr_ejendom_status')
        .upsert(upsertRows, { onConflict: 'bfe_nummer' });
      if (upsertErr) {
        logger.error('[refresh-ejendom-status] upsert fejl:', upsertErr.message);
      } else {
        upserted += upsertRows.length;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    checked,
    changed,
    upserted,
    failed,
    capReached: rows.length >= PER_RUN_CAP,
  });
}
