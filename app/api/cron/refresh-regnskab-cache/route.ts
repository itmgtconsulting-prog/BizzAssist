/**
 * GET /api/cron/refresh-regnskab-cache
 *
 * BIZZ-1193 + BIZZ-1986: Daglig regnskab-cache sync for M&A-radar.
 *
 * To faser per kørsel:
 *   1. **Nye CVRs** — virksomheder i mv_virksomhedshandel_kandidater der IKKE
 *      er i regnskab_cache. Prioriteret først så radaren ikke viser "—".
 *   2. **Stale CVRs** — eksisterende cache med fetched_at > 90 dage.
 *
 * Henter seneste regnskab via CVR ES offentliggoerelser → XBRL parse →
 * upsert med years JSONB + flade kolonner (omsaetning, bruttofortjeneste,
 * resultat_foer_skat etc.) som M&A-radaren læser direkte.
 *
 * Cap: 400 CVR per kørsel (5 min Vercel budget).
 * Schedule: 0 6 * * * UTC (dagligt kl. 06:00 — efter EJF + CVR delta-sync).
 *
 * @module api/cron/refresh-regnskab-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { getCvrEsAuthHeader } from '@/app/lib/cvrIngest';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Max CVRs per kørsel (nye + stale samlet) */
const MAX_PER_RUN = 400;

/** Stale threshold — genhent regnskaber ældre end 90 dage */
const STALE_DAYS = 90;

/** Safety margin before Vercel maxDuration */
const SAFETY_MARGIN_MS = 30_000;

/** Concurrent XBRL fetches */
const CONCURRENCY = 8;

/** Parser version — must match scripts/lib/regnskab-xbrl-parser.mjs */
const PARSER_VERSION = 'v9';

// ─── XBRL tag mappings (synced with scripts/lib/regnskab-xbrl-parser.mjs) ────

const RESULTAT_TAGS: Record<string, string[]> = {
  omsaetning: ['Revenue', 'Nettoomsaetning'],
  bruttofortjeneste: ['GrossProfitLoss', 'GrossProfit'],
  resultatFoerSkat: [
    'ProfitLossFromOrdinaryActivitiesBeforeTax',
    'ProfitBeforeTax',
    'ProfitLossBeforeTax',
  ],
  aaretsResultat: ['ProfitLoss'],
  finansielleIndtaegter: ['OtherFinanceIncome', 'FinanceIncome'],
  finansielleOmkostninger: ['OtherFinanceExpenses', 'FinanceCosts'],
  personaleomkostninger: ['EmployeeBenefitsExpense', 'StaffCosts'],
  afskrivninger: [
    'DepreciationAmortisationExpenseAndImpairmentLossesOfPropertyPlantAndEquipmentAndIntangibleAssetsRecognisedInProfitOrLoss',
    'DepreciationAmortisation',
    'DepreciationAndAmortisationExpense',
  ],
  eksterneOmkostninger: [
    'ExternalExpenses',
    'OtherExternalExpenses',
    'RawMaterialsAndConsumablesUsed',
  ],
  skatAfAaretsResultat: [
    'TaxExpenseOnOrdinaryActivities',
    'TaxExpense',
    'IncomeTaxExpense',
    'IncomeTaxExpenseContinuingOperations',
  ],
};

const BALANCE_TAGS: Record<string, string[]> = {
  aktiverIAlt: ['Assets'],
  egenkapital: ['Equity'],
  selskabskapital: ['ContributedCapital', 'IssuedCapital'],
  gaeldsforpligtelserIAlt: [
    'LiabilitiesAndEquity',
    'Liabilities',
    'ShorttermLiabilitiesOtherThanProvisions',
    'LongtermLiabilitiesOtherThanProvisions',
  ],
};

const NOEGLETAL_TAGS: Record<string, string[]> = {
  antalAnsatte: ['AverageNumberOfEmployees'],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Verificerer CRON_SECRET bearer + (i prod) Vercel cron-header.
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

interface EsRegnskab {
  offentliggjort: string;
  periodeStart: string;
  periodeSlut: string;
  dokumentUrl: string;
}

/**
 * Henter seneste regnskab-offentliggørelser for et CVR fra ES.
 */
async function fetchRegnskaber(cvr: string, esAuth: string): Promise<EsRegnskab[]> {
  const body = {
    query: {
      bool: {
        must: [
          { term: { cvrNummer: parseInt(cvr, 10) } },
          { term: { offentliggoerelsestype: 'regnskab' } },
        ],
      },
    },
    sort: [{ offentliggoerelsesTidspunkt: { order: 'desc' } }],
    size: 5,
  };
  const res = await fetch('http://distribution.virk.dk/offentliggoerelser/_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: esAuth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    hits?: { hits?: Array<{ _source?: Record<string, unknown> }> };
  };
  const results: EsRegnskab[] = [];
  for (const h of data.hits?.hits ?? []) {
    const src = h._source;
    if (!src) continue;
    const periode = (src.regnskab as Record<string, unknown> | undefined)?.regnskabsperiode as
      | Record<string, string>
      | undefined;
    const docs = Array.isArray(src.dokumenter) ? src.dokumenter : [];
    const xmlDoc = docs.find(
      (d: Record<string, unknown>) =>
        typeof d.dokumentMimeType === 'string' &&
        (d.dokumentMimeType.includes('xml') || d.dokumentMimeType.includes('xhtml'))
    ) as Record<string, string> | undefined;
    if (periode?.startDato && periode?.slutDato && xmlDoc?.dokumentUrl) {
      results.push({
        offentliggjort: src.offentliggoerelsesTidspunkt as string,
        periodeStart: periode.startDato,
        periodeSlut: periode.slutDato,
        dokumentUrl: xmlDoc.dokumentUrl,
      });
    }
  }
  return results;
}

/**
 * Simpel XBRL tag-extraction. Finder den første matchende tag-værdi i XML.
 */
function extractTag(xml: string, tags: string[], contextFilter?: string): number | null {
  for (const tag of tags) {
    const regex = new RegExp(`<[^>]*?:?${tag}[^>]*?>([-\\d.,]+)<`, 'i');
    const match = xml.match(regex);
    if (match) {
      if (contextFilter && !match[0].includes(contextFilter)) continue;
      const raw = match[1].replace(/\./g, '').replace(',', '.');
      const val = parseFloat(raw);
      if (!isNaN(val)) return Math.round(val);
    }
  }
  return null;
}

interface ParsedYear {
  aar: number;
  resultat: {
    omsaetning: number | null;
    bruttofortjeneste: number | null;
    resultatFoerSkat: number | null;
    aaretsResultat: number | null;
  };
  balance: {
    aktiverIAlt: number | null;
    egenkapital: number | null;
    selskabskapital: number | null;
    gaeldsforpligtelserIAlt: number | null;
  };
  noegletal: {
    antalAnsatte: number | null;
  };
}

/**
 * Fetcher og parser XBRL for ét regnskab.
 */
async function fetchAndParseXbrl(regn: EsRegnskab): Promise<ParsedYear | null> {
  try {
    const res = await fetch(regn.dokumentUrl, {
      signal: AbortSignal.timeout(30000),
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    });
    if (!res.ok) return null;
    const xml = await res.text();

    const slutYear = parseInt(regn.periodeSlut.substring(0, 4), 10);
    if (isNaN(slutYear)) return null;

    return {
      aar: slutYear,
      resultat: {
        omsaetning: extractTag(xml, RESULTAT_TAGS.omsaetning),
        bruttofortjeneste: extractTag(xml, RESULTAT_TAGS.bruttofortjeneste),
        resultatFoerSkat: extractTag(xml, RESULTAT_TAGS.resultatFoerSkat),
        aaretsResultat: extractTag(xml, RESULTAT_TAGS.aaretsResultat),
      },
      balance: {
        aktiverIAlt: extractTag(xml, BALANCE_TAGS.aktiverIAlt),
        egenkapital: extractTag(xml, BALANCE_TAGS.egenkapital),
        selskabskapital: extractTag(xml, BALANCE_TAGS.selskabskapital),
        gaeldsforpligtelserIAlt: extractTag(xml, BALANCE_TAGS.gaeldsforpligtelserIAlt),
      },
      noegletal: {
        antalAnsatte: extractTag(xml, NOEGLETAL_TAGS.antalAnsatte),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Processerer ét CVR: ES → XBRL → parse → upsert med flade kolonner.
 */
async function processCvr(
  cvr: string,
  esAuth: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any
): Promise<'ok' | 'no-regnskab' | 'parse-failed' | 'error'> {
  try {
    const regnskaber = await fetchRegnskaber(cvr, esAuth);
    if (regnskaber.length === 0) return 'no-regnskab';

    const parsed = await fetchAndParseXbrl(regnskaber[0]);
    if (!parsed) return 'parse-failed';

    const esTimestamp = `${regnskaber[0].offentliggjort}_${PARSER_VERSION}`;

    const { error } = await table.upsert(
      {
        cvr,
        years: [parsed],
        es_timestamp: esTimestamp,
        fetched_at: new Date().toISOString(),
        seneste_aar: parsed.aar,
        omsaetning: parsed.resultat.omsaetning,
        bruttofortjeneste: parsed.resultat.bruttofortjeneste,
        resultat_foer_skat: parsed.resultat.resultatFoerSkat,
        aarsresultat: parsed.resultat.aaretsResultat,
        egenkapital: parsed.balance.egenkapital,
        aktiver_i_alt: parsed.balance.aktiverIAlt,
        gaeld_i_alt: parsed.balance.gaeldsforpligtelserIAlt,
        selskabskapital: parsed.balance.selskabskapital,
        antal_ansatte: parsed.noegletal.antalAnsatte,
      },
      { onConflict: 'cvr' }
    );

    return error ? 'error' : 'ok';
  } catch {
    return 'error';
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * Cron handler: refresh regnskab_cache for M&A-radar virksomheder.
 *
 * @param request - Incoming request with CRON_SECRET auth
 * @returns JSON summary
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'refresh-regnskab-cache', schedule: '0 6 * * *', intervalMinutes: 1440 },
    async () => {
      const startTime = Date.now();
      const esAuth = getCvrEsAuthHeader();
      if (!esAuth) {
        return NextResponse.json(
          { ok: false, error: 'CVR_ES_USER/PASS ikke konfigureret' },
          { status: 503 }
        );
      }

      const admin = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const table = (admin as any).from('regnskab_cache');
      const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // ── Phase 1: Nye CVRs i M&A-radar uden regnskab_cache ──
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: newCvrs } = await (admin as any).rpc('get_ma_cvrs_missing_regnskab', {
        max_rows: MAX_PER_RUN,
      });
      const newList: string[] = (newCvrs ?? []).map(
        (r: { virksomhed_cvr: string }) => r.virksomhed_cvr
      );

      // ── Phase 2: Stale CVRs (kun hvis der er plads i budget) ──
      const staleSlots = Math.max(0, MAX_PER_RUN - newList.length);
      let staleList: string[] = [];
      if (staleSlots > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: staleCvrs } = await (admin as any)
          .from('regnskab_cache')
          .select('cvr')
          .lt('fetched_at', staleCutoff)
          .order('fetched_at', { ascending: true })
          .limit(staleSlots);
        staleList = (staleCvrs ?? []).map((r: { cvr: string }) => r.cvr);
      }

      const allCvrs = [...newList, ...staleList];
      logger.log(
        `[refresh-regnskab-cache] ${newList.length} nye + ${staleList.length} stale = ${allCvrs.length} CVRs`
      );

      let ok = 0;
      let noRegnskab = 0;
      let errors = 0;

      // Process in batches of CONCURRENCY
      for (let i = 0; i < allCvrs.length; i += CONCURRENCY) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.warn(
            `[refresh-regnskab-cache] Safety margin ramt efter ${ok + noRegnskab + errors} CVRs`
          );
          break;
        }

        const batch = allCvrs.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((cvr) => processCvr(cvr, esAuth, table)));

        for (const r of results) {
          if (r === 'ok') ok++;
          else if (r === 'no-regnskab') noRegnskab++;
          else errors++;
        }
      }

      const summary = {
        ok: true,
        newCvrs: newList.length,
        staleCvrs: staleList.length,
        refreshed: ok,
        noRegnskab,
        errors,
        durationMs: Date.now() - startTime,
      };
      logger.log('[refresh-regnskab-cache] Done:', summary);
      return NextResponse.json(summary);
    }
  );
}
