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
 *   - areal_min/areal_max, byggear_min/byggear_max: BBR-filtre (BIZZ-2051)
 *   - etager_min/etager_max, vaerelser_min/vaerelser_max: BBR-filtre (BIZZ-2070)
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
    // BIZZ-2055: Normalisér dato-vinduet til HELE måneder, så KPI (fra den
    // måneds-bucketede mv_boligpris_maaned) og handler-listen (fra den
    // dag-eksakte mv_boligpris_handler via RPC) dækker præcis samme periode.
    // KPI'ens MV grupperer på date_trunc('month', overtagelsesdato): et
    // 'til' midt i måneden inkluderer derfor HELE indeværende måneds handler
    // (inkl. fremtidigt daterede overtagelser), mens RPC'en med dag-eksakt
    // p_til udelod dem → KPI > antal viste handler. Ved at snappe 'fra' til
    // månedens første dag og 'til' til månedens sidste dag i BEGGE queries
    // bliver antal_handler i KPI = antal rækker i listen på alle granulariteter.
    const fraD = new Date(`${fra}T00:00:00Z`);
    const tilD = new Date(`${til}T00:00:00Z`);
    const fraMaaned = new Date(Date.UTC(fraD.getUTCFullYear(), fraD.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const tilMaanedSlut = new Date(Date.UTC(tilD.getUTCFullYear(), tilD.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    const wantHandler = sp.get('handler') === 'true';
    // Export-mode: hent alle matchende rækker (op til 20000) så Excel-eksport
    // matcher KPI-antal handler. Normal paginering capper ved 500.
    const wantExport = sp.get('export') === 'true';
    const maxLimit = wantExport ? 20000 : 500;
    const defaultLimit = wantExport ? 20000 : 50;
    const limit = Math.min(Math.max(Number(sp.get('limit')) || defaultLimit, 1), maxLimit);
    const offset = wantExport ? 0 : Math.max(Number(sp.get('offset')) || 0, 0);
    // BIZZ-2051: BBR-filtre
    const arealMin = Number(sp.get('areal_min')) || 0;
    const arealMax = Number(sp.get('areal_max')) || 0;
    const byggearMin = Number(sp.get('byggear_min')) || 0;
    const byggearMax = Number(sp.get('byggear_max')) || 0;
    // BIZZ-2070: etager/værelser-filtre (backfillet via BBR v2-pipeline)
    const etagerMin = Number(sp.get('etager_min')) || 0;
    const etagerMax = Number(sp.get('etager_max')) || 0;
    const vaerelserMin = Number(sp.get('vaerelser_min')) || 0;
    const vaerelserMax = Number(sp.get('vaerelser_max')) || 0;
    // BBR-filtre sendes til RPC-funktionen

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any;

    // BIZZ-2046/BIZZ-2112: Postnr-filter — oversæt postnumre til kommune_koder via
    // bfe_adresse_cache (kommune-prefilter afgrænser MV-index-scanningen), og send
    // derudover selve postnumrene til RPC'en som eksakt efterfiltrering.
    let postnrStrings: string[] | null = null;
    if (postnumre && postnumre.length > 0) {
      postnrStrings = postnumre.map((p) => String(p).padStart(4, '0'));
      // VIGTIGT: filtrér rækker med NULL kommune_kode fra i selve query'en.
      // bfe_adresse_cache har mange rækker uden kommune_kode (fx ~65% for postnr 2500),
      // og uden dette filter kunne .limit(1000) fyldes udelukkende med NULL-rækker →
      // tom kommune-liste → .in('kommune_kode', []) matcher intet → 0 handler (bug).
      const { data: postnrRows } = await admin
        .from('bfe_adresse_cache')
        .select('kommune_kode')
        .in('postnr', postnrStrings)
        .not('kommune_kode', 'is', null)
        .limit(1000);
      if (postnrRows && postnrRows.length > 0) {
        // BIZZ-2112: enkelte korrupte cache-rækker (forkert kommune_kode for et
        // postnr) må ikke kunne trække en hel fremmed kommune ind i resultatet.
        // Tæl forekomster pr. kommune og behold kun kommuner med ≥10 rækker —
        // eller, hvis ingen når 10 (små samples), kun den hyppigste kommune.
        const kommuneCounts = new Map<number, number>();
        for (const r of postnrRows) {
          const kk = Number((r as Record<string, unknown>).kommune_kode);
          if (Number.isFinite(kk) && kk > 0) {
            kommuneCounts.set(kk, (kommuneCounts.get(kk) ?? 0) + 1);
          }
        }
        let postnrKommuner = Array.from(kommuneCounts.entries())
          .filter(([, n]) => n >= 10)
          .map(([kk]) => kk);
        if (postnrKommuner.length === 0 && kommuneCounts.size > 0) {
          const [topKommune] = Array.from(kommuneCounts.entries()).sort((a, b) => b[1] - a[1])[0];
          postnrKommuner = [topKommune];
        }
        // Merge med eventuelle eksisterende kommune-filtre
        kommuner = kommuner ? kommuner.filter((k) => postnrKommuner.includes(k)) : postnrKommuner;
      }
    }

    // BIZZ-2171: når et BBR-filter (areal/byggeår/etager/værelser) eller det
    // eksakte postnr-filter er aktivt, KAN KPI/graf/kommune-breakdown ikke komme
    // fra mv_boligpris_maaned — den er kun aggregeret på (maaned, kommune_kode,
    // byg021_anvendelse) og kender hverken BBR-dimensioner eller postnr. Brugte vi
    // den, ville KPI'erne ignorere filtrene og divergere fra "Seneste handler"-
    // listen (fx "Antal handler 347" mens listen var tom for værelser=2). Når et
    // sådant filter er aktivt henter vi i stedet aggregeret fra PRÆCIS samme
    // filtrerede handler-population som listen via boligpris_aggregat-RPC'en.
    const bbrFilterActive =
      arealMin !== 0 ||
      arealMax !== 0 ||
      byggearMin !== 0 ||
      byggearMax !== 0 ||
      etagerMin !== 0 ||
      etagerMax !== 0 ||
      vaerelserMin !== 0 ||
      vaerelserMax !== 0;
    const useAggregat = bbrFilterActive || (postnrStrings !== null && postnrStrings.length > 0);

    // --- Tidsserier (pagineret — PostgREST capper ved 1000 rows) ---
    const PAGE_SIZE = 1000;
    const mvData: Array<Record<string, unknown>> = [];
    let mvOffset = 0;

    while (true) {
      let page: Array<Record<string, unknown>> | null;
      if (useAggregat) {
        // Aggregeret over den filtrerede handler-population. Rækkerne har samme
        // form som mv_boligpris_maaned (kommune_kode, maaned, antal_handler,
        // avg_pris, avg_m2_pris), så den efterfølgende aggregering er uændret.
        const { data, error: aggErr } = await admin
          .rpc('boligpris_aggregat', {
            p_kommune_koder: kommuner ?? null,
            p_boligtype_koder: boligtyper ?? null,
            p_fra: fraMaaned,
            p_til: tilMaanedSlut,
            p_areal_min: arealMin,
            p_areal_max: arealMax,
            p_byggear_min: byggearMin,
            p_byggear_max: byggearMax,
            p_etager_min: etagerMin,
            p_etager_max: etagerMax,
            p_vaerelser_min: vaerelserMin,
            p_vaerelser_max: vaerelserMax,
            p_postnumre: postnrStrings,
          })
          .order('maaned', { ascending: true })
          .order('kommune_kode', { ascending: true })
          .range(mvOffset, mvOffset + PAGE_SIZE - 1);
        if (aggErr) {
          logger.error('[boligpris] aggregat RPC fejl:', aggErr.message);
          return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
        }
        page = data;
      } else {
        let mvQuery = admin
          .from('mv_boligpris_maaned')
          .select(
            'kommune_kode, boligtype_kode, maaned, antal_handler, avg_pris, median_pris, avg_m2_pris'
          )
          .gte('maaned', fraMaaned)
          .lte('maaned', tilMaanedSlut)
          .order('maaned', { ascending: true })
          .range(mvOffset, mvOffset + PAGE_SIZE - 1);

        if (kommuner) mvQuery = mvQuery.in('kommune_kode', kommuner);
        if (boligtyper) mvQuery = mvQuery.in('boligtype_kode', boligtyper);

        const { data, error: mvErr } = await mvQuery;
        if (mvErr) {
          logger.error('[boligpris] MV query fejl:', mvErr.message);
          return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
        }
        page = data;
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

    // --- Individuelle handler via RPC (same join as MV — korrekt boligtype-filter) ---
    let handler = undefined;
    let handlerTotal = undefined;
    if (wantHandler) {
      try {
        // BIZZ-2056: RPC-kaldet fejler intermitterende (transient PostgREST/pooler-
        // fejl) for nogle boligtyper — selve SQL'en kører på 5-60ms. Når det sker
        // udelades handler-tabellen helt, så brugeren oplever at kun den først-viste
        // boligtype (typisk Enfamiliehus, som er varm) reproducerbart returnerer data.
        // Bounded retry (3 forsøg, kort backoff) gør hentningen robust uden at maskere
        // ægte fejl.
        let hData: unknown = null;
        let hErr: { message: string } | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const res = await admin.rpc('boligpris_handler', {
            p_kommune_koder: kommuner ?? null,
            p_boligtype_koder: boligtyper ?? null,
            p_fra: fraMaaned,
            p_til: tilMaanedSlut,
            p_areal_min: arealMin,
            p_areal_max: arealMax,
            p_byggear_min: byggearMin,
            p_byggear_max: byggearMax,
            p_etager_min: etagerMin,
            p_etager_max: etagerMax,
            p_vaerelser_min: vaerelserMin,
            p_vaerelser_max: vaerelserMax,
            // BIZZ-2112: eksakt postnr-efterfiltrering i RPC'en (join mod
            // bfe_adresse_cache) — kommune-prefiltret ovenfor afgrænser fortsat
            // index-scanningen, men kun rækker med matchende postnr returneres.
            p_postnumre: postnrStrings,
            p_limit: limit,
            p_offset: offset,
          });
          hData = res.data;
          hErr = res.error;
          if (!hErr) break;
          logger.warn(`[boligpris] RPC handler fejl (forsøg ${attempt}/3):`, hErr.message);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
        }
        if (hErr) {
          logger.warn('[boligpris] RPC handler opgivet efter 3 forsøg:', hErr.message);
        } else {
          const rows = (hData ?? []) as Array<Record<string, unknown>>;
          // RPC'en returnerer KUN sidens rækker (ingen vindues-COUNT — den var
          // ustabil/timeout-følsom nationalt). Det samlede antal ("i alt"-badge)
          // tages fra KPI'en (noegletal.antal_handler) — samme tal brugeren ser i
          // KPI-kortet, beregnet fra mv_boligpris_maaned over præcis samme
          // join-population som handler-MV'en → garanteret match på alle
          // granulariteter, og hurtigt.
          handlerTotal = noegletal.antal_handler;
          // BIZZ-2112: når postnr-filter er aktivt er KPI'en kommune-bucketed og
          // tæller HELE kommunen — brug i stedet capped count-RPC'en der tæller de
          // faktisk postnr-filtrerede rækker, så badgen matcher listen.
          if (postnrStrings) {
            const { data: cntData, error: cntErr } = await admin.rpc('boligpris_handler_count', {
              p_kommune_koder: kommuner ?? null,
              p_boligtype_koder: boligtyper ?? null,
              p_fra: fraMaaned,
              p_til: tilMaanedSlut,
              p_areal_min: arealMin,
              p_areal_max: arealMax,
              p_byggear_min: byggearMin,
              p_byggear_max: byggearMax,
              p_etager_min: etagerMin,
              p_etager_max: etagerMax,
              p_vaerelser_min: vaerelserMin,
              p_vaerelser_max: vaerelserMax,
              p_postnumre: postnrStrings,
            });
            if (!cntErr && typeof cntData === 'number') {
              handlerTotal = cntData;
            } else if (cntErr) {
              logger.warn('[boligpris] count-RPC fejl (beholder KPI-total):', cntErr.message);
            }
          }
          handler = rows.map((h) => {
            const pris = Number(h.samlet_koebesum) || 0;
            const areal = Number(h.samlet_boligareal) || 0;
            const typeKode = String(h.byg021_anvendelse ?? '');
            return {
              bfe_nummer: h.bfe_nummer,
              dato: h.overtagelsesdato,
              pris,
              m2_pris: areal > 0 ? Math.round(pris / areal) : null,
              areal: areal || null,
              boligtype: BOLIGTYPE_LABELS[typeKode] ?? (typeKode || null),
              kommune_kode: null,
              adresse: h.adresse ? `${h.adresse}, ${h.postnr} ${h.postnrnavn}` : null,
              kommune: h.kommune ?? h.postnrnavn ?? null,
            };
          });
        }
      } catch (err) {
        logger.warn('[boligpris] RPC handler exception:', err);
      }
    }

    // BBR-filtre (areal + byggeår) håndteres nu i RPC-funktionen

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
