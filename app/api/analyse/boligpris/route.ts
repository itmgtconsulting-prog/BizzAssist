/**
 * GET /api/analyse/boligpris
 *
 * BIZZ-2031: Boligpris-dashboard API — aggregeret prisdata pr. kommune/boligtype/måned.
 * Læser fra materialized view mv_boligpris_maaned (BIZZ-2030).
 *
 * Query-parametre:
 *   - kommuner: kommasepareret liste af kommune-koder (e.g. "101,147")
 *   - boligtyper: kommasepareret BBR-koder (e.g. "120,130,140")
 *   - fra: startdato YYYY-MM-DD (default: 12 mdr siden)
 *   - til: slutdato YYYY-MM-DD (default: i dag)
 *   - postnumre: kommasepareret postnumre (e.g. "2100,2200") — BIZZ-2046
 *   - handler: "true" for at inkludere individuelle handler
 *   - limit: antal handler (default 50, max 500)
 *   - offset: handler offset (default 0)
 *
 * @returns { tidsserier, noegletal, kommuneBreakdown, handler? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { requireModuleAccess } from '@/app/lib/serverModuleAccess';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

/** Boligtype-koder til danske labels */
const BOLIGTYPE_LABELS: Record<string, string> = {
  '110': 'Stuehus',
  '120': 'Enfamiliehus',
  '130': 'Rækkehus',
  '131': 'Dobbelthus',
  '132': 'Kædehus',
  '140': 'Etagebolig / Lejlighed',
  '210': 'Kontor',
  '220': 'Detailhandel',
  '230': 'Lager',
  '290': 'Erhverv',
  '310': 'Transport',
  '320': 'Industri',
  '323': 'Kraftværk',
  '330': 'Landbrug',
  '410': 'Sommerhus',
  '510': 'Fritidshus',
  '520': 'Feriecenter',
  '530': 'Campinghytte',
  '540': 'Kolonihavehus',
  '585': 'Idræt',
  '590': 'Fritid',
};

/**
 * Parser kommasepareret liste af numeriske værdier.
 *
 * @param raw - Rå querystring-værdi
 * @returns Array af tal, eller undefined
 */
function parseNumList(raw: string | null): number[] | undefined {
  if (!raw) return undefined;
  const nums = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length > 0 ? nums : undefined;
}

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  // 1. Modul-adgang
  const blocked = await requireModuleAccess('boligpris');
  if (blocked) return blocked;

  // 2. Auth
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const sp = req.nextUrl.searchParams;
    let kommuner = parseNumList(sp.get('kommuner'));
    const boligtyper = parseNumList(sp.get('boligtyper'));
    const postnumre = parseNumList(sp.get('postnumre'));
    const now = new Date();
    const defaultFra = new Date(now.getFullYear() - 1, now.getMonth(), 1)
      .toISOString()
      .slice(0, 10);
    const fra = sp.get('fra') || defaultFra;
    const til = sp.get('til') || now.toISOString().slice(0, 10);
    const wantHandler = sp.get('handler') === 'true';
    const limit = Math.min(Math.max(Number(sp.get('limit')) || 50, 1), 500);
    const offset = Math.max(Number(sp.get('offset')) || 0, 0);
    // BIZZ-2051: BBR-filtre
    const arealMin = Number(sp.get('areal_min')) || 0;
    const arealMax = Number(sp.get('areal_max')) || 0;
    const byggearMin = Number(sp.get('byggear_min')) || 0;
    const byggearMax = Number(sp.get('byggear_max')) || 0;
    const hasBbrFilter = arealMin > 0 || arealMax > 0 || byggearMin > 0 || byggearMax > 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any;

    // BIZZ-2046: Postnr-filter — oversæt postnumre til kommune_koder via bfe_adresse_cache
    if (postnumre && postnumre.length > 0) {
      const postnrStrings = postnumre.map((p) => String(p).padStart(4, '0'));
      const { data: postnrRows } = await admin
        .from('bfe_adresse_cache')
        .select('kommune_kode')
        .in('postnr', postnrStrings)
        .limit(1000);
      if (postnrRows && postnrRows.length > 0) {
        const postnrKommuneSet = new Set<number>();
        for (const r of postnrRows) {
          const kk = Number((r as Record<string, unknown>).kommune_kode);
          if (Number.isFinite(kk) && kk > 0) postnrKommuneSet.add(kk);
        }
        const postnrKommuner = Array.from(postnrKommuneSet);
        // Merge med eventuelle eksisterende kommune-filtre
        kommuner = kommuner ? kommuner.filter((k) => postnrKommuner.includes(k)) : postnrKommuner;
      }
    }

    // --- Tidsserier fra MV (pagineret — PostgREST capper ved 1000 rows) ---
    const PAGE_SIZE = 1000;
    const mvData: Array<Record<string, unknown>> = [];
    let mvOffset = 0;

    while (true) {
      let mvQuery = admin
        .from('mv_boligpris_maaned')
        .select(
          'kommune_kode, boligtype_kode, maaned, antal_handler, avg_pris, median_pris, avg_m2_pris'
        )
        .gte('maaned', fra)
        .lte('maaned', til)
        .order('maaned', { ascending: true })
        .range(mvOffset, mvOffset + PAGE_SIZE - 1);

      if (kommuner) mvQuery = mvQuery.in('kommune_kode', kommuner);
      if (boligtyper) mvQuery = mvQuery.in('boligtype_kode', boligtyper);

      const { data: page, error: mvErr } = await mvQuery;
      if (mvErr) {
        logger.error('[boligpris] MV query fejl:', mvErr.message);
        return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
      }
      if (!page || page.length === 0) break;
      mvData.push(...page);
      if (page.length < PAGE_SIZE) break;
      mvOffset += PAGE_SIZE;
    }

    // --- Aggregér tidsserier ---
    const tidsserieMap = new Map<
      string,
      {
        maaned: string;
        antal_handler: number;
        sum_pris: number;
        sum_m2_pris: number;
        count_m2: number;
      }
    >();
    const kommuneMap = new Map<
      number,
      {
        kommune_kode: number;
        antal_handler: number;
        sum_pris: number;
        sum_m2_pris: number;
        count_m2: number;
      }
    >();

    let totalHandler = 0;
    let totalPrisSum = 0;
    let totalM2Sum = 0;
    let totalM2Count = 0;

    for (const row of mvData) {
      const m = String(row.maaned);
      const ah = Number(row.antal_handler) || 0;
      const ap = Number(row.avg_pris) || 0;
      let am = Number(row.avg_m2_pris) || 0;
      const kk = Number(row.kommune_kode);

      // Cap urealistiske m²-priser (outliers fra korrupt kilde-data)
      if (am > 200000) am = 0;

      // Tidsserie
      const existing = tidsserieMap.get(m);
      if (existing) {
        existing.antal_handler += ah;
        existing.sum_pris += ap * ah;
        if (am > 0) {
          existing.sum_m2_pris += am * ah;
          existing.count_m2 += ah;
        }
      } else {
        tidsserieMap.set(m, {
          maaned: m,
          antal_handler: ah,
          sum_pris: ap * ah,
          sum_m2_pris: am > 0 ? am * ah : 0,
          count_m2: am > 0 ? ah : 0,
        });
      }

      // Kommune-breakdown
      const ke = kommuneMap.get(kk);
      if (ke) {
        ke.antal_handler += ah;
        ke.sum_pris += ap * ah;
        if (am > 0) {
          ke.sum_m2_pris += am * ah;
          ke.count_m2 += ah;
        }
      } else {
        kommuneMap.set(kk, {
          kommune_kode: kk,
          antal_handler: ah,
          sum_pris: ap * ah,
          sum_m2_pris: am > 0 ? am * ah : 0,
          count_m2: am > 0 ? ah : 0,
        });
      }

      totalHandler += ah;
      totalPrisSum += ap * ah;
      if (am > 0) {
        totalM2Sum += am * ah;
        totalM2Count += ah;
      }
    }

    const tidsserier = Array.from(tidsserieMap.values())
      .map((t) => ({
        maaned: t.maaned,
        antal_handler: t.antal_handler,
        avg_pris: t.antal_handler > 0 ? Math.round(t.sum_pris / t.antal_handler) : 0,
        avg_m2_pris: t.count_m2 > 0 ? Math.round(t.sum_m2_pris / t.count_m2) : 0,
      }))
      .sort((a, b) => a.maaned.localeCompare(b.maaned));

    const kommuneBreakdown = Array.from(kommuneMap.values())
      .map((k) => ({
        kommune_kode: k.kommune_kode,
        antal_handler: k.antal_handler,
        avg_pris: k.antal_handler > 0 ? Math.round(k.sum_pris / k.antal_handler) : 0,
        avg_m2_pris: k.count_m2 > 0 ? Math.round(k.sum_m2_pris / k.count_m2) : 0,
      }))
      .sort((a, b) => b.antal_handler - a.antal_handler);

    // --- YoY beregning ---
    const nowYear = now.getFullYear();
    const curYearStart = `${nowYear}-01-01`;
    const prevYearStart = `${nowYear - 1}-01-01`;
    const prevYearEnd = `${nowYear - 1}-12-31`;
    const curYearRows = mvData.filter(
      (r: Record<string, unknown>) => String(r.maaned) >= curYearStart && String(r.maaned) <= til
    );
    const prevYearRows = mvData.filter(
      (r: Record<string, unknown>) =>
        String(r.maaned) >= prevYearStart && String(r.maaned) <= prevYearEnd
    );
    const calcAvg = (rows: Array<Record<string, unknown>>) => {
      let sum = 0;
      let count = 0;
      for (const r of rows) {
        const ah = Number(r.antal_handler) || 0;
        const ap = Number(r.avg_pris) || 0;
        sum += ap * ah;
        count += ah;
      }
      return count > 0 ? sum / count : 0;
    };
    const curAvg = calcAvg(curYearRows);
    const prevAvg = calcAvg(prevYearRows);
    const yoyPct = prevAvg > 0 ? ((curAvg - prevAvg) / prevAvg) * 100 : null;

    const noegletal = {
      antal_handler: totalHandler,
      avg_pris: totalHandler > 0 ? Math.round(totalPrisSum / totalHandler) : 0,
      avg_m2_pris: totalM2Count > 0 ? Math.round(totalM2Sum / totalM2Count) : 0,
      yoy_pct: yoyPct !== null ? Math.round(yoyPct * 10) / 10 : null,
    };

    // --- Individuelle handler (valgfrit) ---
    // BIZZ-2045: Bruger ejerskifte_historik i stedet for v_ejerskifte_handel
    // (viewet timeout'er ved dato-range + sortering).
    let handler = undefined;
    let handlerTotal = undefined;
    if (wantHandler) {
      let hQuery = admin
        .from('ejerskifte_historik')
        .select(
          'bfe_nummer, i_alt_koebesum, overtagelsesdato, kommune_kode, m2_pris, boligareal_m2',
          { count: 'exact' }
        )
        .gt('i_alt_koebesum', 0)
        .gte('overtagelsesdato', fra)
        .lte('overtagelsesdato', til)
        .order('overtagelsesdato', { ascending: false })
        .range(offset, offset + limit - 1);

      if (kommuner) hQuery = hQuery.in('kommune_kode', kommuner);

      // Boligtype-filtrering sker via MV (KPI/chart). Handler-tabellen viser
      // alle handler for valgt kommune — BBR-type beriges i Type-kolonnen.
      // Tidligere BBR BFE-lookup fjernet da PostgREST .in() limit (1000) fejlede
      // for multi-kode chips (erhverv = 8 koder × hundredevis af BFE'er).

      const { data: hData, error: hErr } = await hQuery;
      if (hErr) {
        logger.warn('[boligpris] handler query fejl:', hErr.message);
      } else {
        // Berig med adresse + BBR-areal
        const bfeNums = (hData ?? []).map((h: { bfe_nummer: number }) => h.bfe_nummer);
        const [adresseRes, bbrRes] = await Promise.all([
          bfeNums.length > 0
            ? admin
                .from('bfe_adresse_cache')
                .select('bfe_nummer, adresse, postnr, postnrnavn, kommune')
                .in('bfe_nummer', bfeNums)
            : { data: [] },
          bfeNums.length > 0
            ? admin
                .from('bbr_ejendom_status')
                .select('bfe_nummer, samlet_boligareal, samlet_erhvervsareal, byg021_anvendelse')
                .in('bfe_nummer', bfeNums)
            : { data: [] },
        ]);

        const adresseMap = new Map<number, Record<string, unknown>>();
        for (const a of adresseRes.data ?? []) adresseMap.set(a.bfe_nummer, a);
        const bbrMap = new Map<number, Record<string, unknown>>();
        for (const b of bbrRes.data ?? []) bbrMap.set(b.bfe_nummer, b);

        handler = (hData ?? []).map((h: Record<string, unknown>) => {
          const bfe = h.bfe_nummer as number;
          const adr = adresseMap.get(bfe);
          const bbr = bbrMap.get(bfe);
          const pris = Number(h.i_alt_koebesum) || 0;
          // Areal: ejerskifte_historik → BBR boligareal → BBR erhvervsareal
          const areal =
            Number(h.boligareal_m2) ||
            Number(bbr?.samlet_boligareal) ||
            Number(bbr?.samlet_erhvervsareal) ||
            0;
          const typeKode = String(bbr?.byg021_anvendelse ?? '');
          return {
            bfe_nummer: bfe,
            dato: h.overtagelsesdato,
            pris,
            m2_pris: Number(h.m2_pris) || (areal > 0 ? Math.round(pris / areal) : null),
            areal: areal || null,
            boligtype: BOLIGTYPE_LABELS[typeKode] ?? (typeKode || null),
            kommune_kode: h.kommune_kode ?? null,
            adresse: adr ? `${adr.adresse}, ${adr.postnr} ${adr.postnrnavn}` : null,
            kommune: (adr as Record<string, unknown>)?.kommune ?? null,
          };
        });

        // Dedupliker: samme BFE + dato + pris = samme handel (EJF + TL dobbelt-entries)
        const seen = new Set<string>();
        handler = handler.filter((h: Record<string, unknown>) => {
          const key = `${h.bfe_nummer}-${h.dato}-${h.pris}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        handlerTotal = handler.length;
      }
    }

    // BIZZ-2051: BBR-filtre på handler (areal + byggeår)
    if (handler && hasBbrFilter) {
      // Hent BBR-data for handler BFE'er
      const handlerBfes = handler.map((h: Record<string, unknown>) => h.bfe_nummer as number);
      if (handlerBfes.length > 0) {
        const { data: bbrFilter } = await admin
          .from('bbr_ejendom_status')
          .select('bfe_nummer, samlet_boligareal, opfoerelsesaar')
          .in('bfe_nummer', handlerBfes.slice(0, 1000));
        const bbrLookup = new Map<number, { areal: number; aar: number }>();
        for (const b of (bbrFilter ?? []) as Array<{
          bfe_nummer: number;
          samlet_boligareal: number | null;
          opfoerelsesaar: number | null;
        }>) {
          bbrLookup.set(b.bfe_nummer, {
            areal: b.samlet_boligareal ?? 0,
            aar: b.opfoerelsesaar ?? 0,
          });
        }
        handler = handler.filter((h: Record<string, unknown>) => {
          const bbr = bbrLookup.get(h.bfe_nummer as number);
          if (!bbr) return true; // Vis handler uden BBR-data
          if (arealMin > 0 && bbr.areal < arealMin) return false;
          if (arealMax > 0 && bbr.areal > arealMax) return false;
          if (byggearMin > 0 && bbr.aar < byggearMin) return false;
          if (byggearMax > 0 && bbr.aar > byggearMax) return false;
          return true;
        });
        handlerTotal = handler.length;
      }
    }

    return NextResponse.json({
      tidsserier,
      noegletal,
      kommuneBreakdown,
      boligtypeLabels: BOLIGTYPE_LABELS,
      ...(handler !== undefined && { handler, handlerTotal }),
    });
  } catch (err) {
    logger.error('[boligpris] uventet fejl:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
