/**
 * GET /api/cron/sync-tinglysning-detail
 *
 * Daglig sync af tinglysning_haeftelse, tinglysning_servitut og ejendomshandel
 * for BFE'er der er aendret de seneste 5 dage.
 *
 * Bruger samme aendringer-feed som pull-tinglysning-aendringer, men henter
 * ejdsummarisk XML og parser adkomst, haeftelser og servitutter.
 *
 * Schedule: 0 4 * * * UTC (dagligt kl. 04:00 — efter pull-tinglysning-aendringer)
 *
 * @module api/cron/sync-tinglysning-detail
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { tlFetch, tlPost } from '@/app/lib/tlFetch';
import { computeWindow, extractUniqueBfes } from '@/app/api/cron/pull-tinglysning-aendringer/route';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Rate limit: 2 req/sec — 500ms mellem kald */
const FETCH_DELAY_MS = 500;

/** Max BFE per cron-koorsel (safety) */
const MAX_BFES_PER_RUN = 500;

/** 5-dages rolling window (same as pull-tinglysning-aendringer) */
const DEFAULT_WINDOW_DAYS = 5;

/** Safety margin before maxDuration */
const SAFETY_MARGIN_MS = 30_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface ParsedHandler {
  bfe_nummer: number;
  dato: string | null;
  tinglyst_dato: string | null;
  koebsaftale_dato: string | null;
  koebesum: number | null;
  samlet_koebesum: number | null;
  andel_taeller: number | null;
  andel_naevner: number | null;
  koeber_navne: string[] | null;
  koeber_cvrs: string[] | null;
}

interface ParsedHaeftelse {
  bfe_nummer: number;
  prioritet: number;
  type: string;
  hovedstol: number | null;
  kreditor: string | null;
  kreditor_cvr: string | null;
  tinglyst_dato: string | null;
  akt_navn: string | null;
  status: string;
}

interface ParsedServitut {
  bfe_nummer: number;
  prioritet: number;
  tekst: string;
  type: string | null;
  tinglyst_dato: string | null;
  akt_navn: string | null;
  paataleberettiget: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verify CRON_SECRET bearer + x-vercel-cron in production.
 *
 * @param request - Incoming request
 * @returns true if authorised
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

/**
 * Extract a date-like string from XML, trimming timezone/time parts.
 *
 * @param xml - XML fragment
 * @param tag - Tag name without namespace
 * @returns ISO date string (YYYY-MM-DD) or null
 */
function extractDate(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`));
  return m?.[1]?.split(/[+T]/)[0] || null;
}

/**
 * Extract an integer from XML tag content.
 *
 * @param xml - XML fragment
 * @param tag - Tag name without namespace
 * @returns Parsed integer or null
 */
function extractInt(xml: string, tag: string): number | null {
  const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`));
  const n = parseInt(m?.[1]?.trim() || '', 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract text content from first matching XML tag.
 *
 * @param xml - XML fragment
 * @param tag - Tag name without namespace
 * @returns Trimmed text or null
 */
function extractText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`${tag}[^>]*>([^<]+)`));
  return m?.[1]?.trim() || null;
}

/**
 * Extract kreditor name from KreditorInformationSamling block.
 * Searches only within the kreditor section to avoid picking up debitor names.
 *
 * @param xml - HaeftelseSummarisk XML fragment
 * @returns Kreditor name or null
 */
function extractKreditor(xml: string): { navn: string | null; cvr: string | null } {
  const kreditorBlock = xml.match(
    /KreditorInformationSamling[^>]*>([\s\S]*?)<\/[^:]*:?KreditorInformationSamling/
  );
  if (!kreditorBlock) return { navn: null, cvr: null };
  const block = kreditorBlock[1];
  return {
    navn: extractText(block, 'LegalUnitName') || extractText(block, 'PersonName'),
    cvr: extractText(block, 'CVRnumberIdentifier'),
  };
}

/**
 * Hent og parse alle tinglysningsdata for et BFE via ejdsummarisk XML.
 *
 * @param bfe - BFE-nummer
 * @returns Parsed handler, haeftelser, servitutter
 */
async function fetchDetailForBfe(bfe: number): Promise<{
  handler: ParsedHandler[];
  haeftelser: ParsedHaeftelse[];
  servitutter: ParsedServitut[];
} | null> {
  // Step 1: BFE -> UUID
  const r1 = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`);
  if (r1.status !== 200 || !r1.body || r1.body === '{}') return null;

  let uuid: string | undefined;
  try {
    const parsed = JSON.parse(r1.body) as { items?: Array<{ uuid?: string }> };
    uuid = parsed?.items?.[0]?.uuid;
  } catch {
    return null;
  }
  if (!uuid) return null;

  // Step 2: UUID -> summarisk XML
  const r2 = await tlFetch(`/ejdsummarisk/${uuid}`, { accept: 'application/xml' });
  if (r2.status !== 200 || !r2.body) return null;
  const xml = r2.body;

  // Parse ADKOMST (handler)
  const handler: ParsedHandler[] = [];
  const adkomstEntries = [
    ...xml.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g),
  ];
  for (const [, e] of adkomstEntries) {
    const dato = extractDate(e, 'SkoedeOvertagelsesDato');
    const kontantKoebesum = extractInt(e, 'KontantKoebesum');
    if (!dato && !kontantKoebesum) continue;

    const koeber = extractText(e, 'PersonNavn') || extractText(e, 'VirksomhedNavn');
    const koeberCvr = extractText(e, 'VirksomhedCvrNummer');

    handler.push({
      bfe_nummer: bfe,
      dato,
      tinglyst_dato: extractDate(e, 'TinglysningsDato'),
      koebsaftale_dato: extractDate(e, 'KoebsaftaleDato'),
      koebesum: kontantKoebesum,
      samlet_koebesum: extractInt(e, 'IAltKoebesum'),
      andel_taeller: extractInt(e, 'AndelTaeller'),
      andel_naevner: extractInt(e, 'AndelNaevner'),
      koeber_navne: koeber ? [koeber] : null,
      koeber_cvrs: koeberCvr ? [koeberCvr] : null,
    });
  }

  // Parse HAEFTELSER
  const haeftelser: ParsedHaeftelse[] = [];
  const haeftelseEntries = [
    ...xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk/g),
  ];
  let prioritet = 0;
  for (const [, e] of haeftelseEntries) {
    prioritet++;
    const kreditor = extractKreditor(e);
    haeftelser.push({
      bfe_nummer: bfe,
      prioritet,
      type: extractText(e, 'DokumentType') || extractText(e, 'HaeftelseType') || 'Ukendt',
      // e-TL XML: <HaeftelseBeloeb><BeloebValuta><BeloebVaerdi>50000</...>
      hovedstol: extractInt(e, 'BeloebVaerdi'),
      kreditor: kreditor.navn,
      kreditor_cvr: kreditor.cvr,
      tinglyst_dato: extractDate(e, 'TinglysningsDato'),
      akt_navn: extractText(e, 'DokumentAliasIdentifikator'),
      status: extractText(e, 'Status')?.toLowerCase() || 'gaeldende',
    });
  }

  // Parse SERVITUTTER
  const servitutter: ParsedServitut[] = [];
  const servitutEntries = [
    ...xml.matchAll(/ServitutSummarisk>([\s\S]*?)<\/[^:]*:?ServitutSummarisk/g),
  ];
  let servPrioritet = 0;
  for (const [, e] of servitutEntries) {
    servPrioritet++;
    servitutter.push({
      bfe_nummer: bfe,
      prioritet: servPrioritet,
      tekst: extractText(e, 'ServitutTekst') || extractText(e, 'DokumentType') || 'Ukendt',
      type: extractText(e, 'ServitutType'),
      tinglyst_dato: extractDate(e, 'TinglysningsDato'),
      akt_navn: extractText(e, 'AktNavn'),
      paataleberettiget: extractText(e, 'PaataleBerettiget'),
    });
  }

  return { handler, haeftelser, servitutter };
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    {
      jobName: 'sync-tinglysning-detail',
      schedule: '0 4 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
      const startTime = Date.now();
      const admin = createAdminClient();

      const windowDaysRaw = request.nextUrl.searchParams.get('windowDays');
      const windowDays = windowDaysRaw ? parseInt(windowDaysRaw, 10) : DEFAULT_WINDOW_DAYS;

      // BIZZ-1827: Accept explicit BFE list for re-sync of existing records.
      // Usage: ?bfes=100000,100001,100002 (comma-separated, max 500)
      const bfesParam = request.nextUrl.searchParams.get('bfes');
      let bfes: number[];

      let datoFra = '';
      let datoTil = '';
      let aendringerFound = 0;

      if (bfesParam) {
        // Explicit BFE list mode — skip aendringer feed
        bfes = bfesParam
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
          .slice(0, MAX_BFES_PER_RUN);
        aendringerFound = bfes.length;
        logger.log(`[tl-detail] BIZZ-1827: Explicit BFE list: ${bfes.length} BFE`);
      } else {
        // Standard mode — fetch from aendringer feed
        ({ datoFra, datoTil } = computeWindow(new Date(), windowDays));
        logger.log(`[tl-detail] Starter: window ${datoFra}...${datoTil} (${windowDays}d)`);

        // 1. Fetch aendringer for window — reuse same pagination as pull-tinglysning-aendringer
        interface AendretTinglysningsobjekt {
          EjendomIdentifikator?: { BestemtFastEjendomNummer?: string };
        }
        interface AendringerResponse {
          AendredeTinglysningsobjekterHentResultat?: {
            AendretTinglysningsobjektSamling?: AendretTinglysningsobjekt[];
            SoegningResultatInterval?: { FlereResultater?: boolean };
          };
        }

        const allItems: AendretTinglysningsobjekt[] = [];
        let fraSide = 1;
        let pagesFetched = 0;
        const maxPages = 50;

        while (pagesFetched < maxPages) {
          try {
            const res = await tlPost('/tinglysningsobjekter/aendringer', {
              AendredeTinglysningsobjekterHentType: { bog: 'EJENDOM', datoFra, datoTil, fraSide },
            });
            if (res.status !== 200) break;
            const json = JSON.parse(res.body) as AendringerResponse;
            const result = json.AendredeTinglysningsobjekterHentResultat;
            allItems.push(...(result?.AendretTinglysningsobjektSamling ?? []));
            pagesFetched++;
            if (result?.SoegningResultatInterval?.FlereResultater !== true) break;
            fraSide++;
          } catch {
            break;
          }
        }

        bfes = extractUniqueBfes(allItems).slice(0, MAX_BFES_PER_RUN);
        aendringerFound = allItems.length;
        logger.log(`[tl-detail] ${allItems.length} aendringer -> ${bfes.length} unique BFE`);
      }

      // 2. Process each BFE
      let bfesProcessed = 0;
      let handlerUpserted = 0;
      let haeftelserUpserted = 0;
      let servitutterUpserted = 0;
      let errors = 0;

      for (const bfe of bfes) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.warn('[tl-detail] Safety margin — stopping early');
          break;
        }

        try {
          const detail = await fetchDetailForBfe(bfe);
          if (!detail) {
            bfesProcessed++;
            continue;
          }

          // Upsert handler -> ejendomshandel
          if (detail.handler.length > 0) {
            // Delete existing + insert (full replace per BFE for idempotency)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any)
              .from('ejendomshandel')
              .delete()
              .eq('bfe_nummer', bfe)
              .eq('kilde', 'tinglysning-summarisk');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { error: hErr } = await (admin as any).from('ejendomshandel').insert(
              detail.handler.map((h) => ({
                bfe_nummer: h.bfe_nummer,
                dato: h.dato,
                tinglyst_dato: h.tinglyst_dato,
                koebsaftale_dato: h.koebsaftale_dato,
                koebesum: h.koebesum,
                samlet_koebesum: h.samlet_koebesum,
                andel_taeller: h.andel_taeller,
                andel_naevner: h.andel_naevner,
                koeber_navne: h.koeber_navne,
                koeber_cvrs: h.koeber_cvrs,
                kilde: 'tinglysning-summarisk',
                sidst_opdateret: new Date().toISOString(),
              }))
            );
            if (!hErr) handlerUpserted += detail.handler.length;
          }

          // Upsert haeftelser -> tinglysning_haeftelse (full replace per BFE)
          if (detail.haeftelser.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any).from('tinglysning_haeftelse').delete().eq('bfe_nummer', bfe);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { error: haErr } = await (admin as any).from('tinglysning_haeftelse').insert(
              detail.haeftelser.map((h) => ({
                bfe_nummer: h.bfe_nummer,
                prioritet: h.prioritet,
                type: h.type,
                // BIZZ-1797: Korrekte kolonnenavne (var hovedstol/kreditor → nu hovedstol_dkk/kreditor_navn)
                hovedstol_dkk: h.hovedstol,
                kreditor_navn: h.kreditor,
                kreditor_cvr: h.kreditor_cvr,
                tinglyst_dato: h.tinglyst_dato,
                akt_navn: h.akt_navn,
                status: h.status,
                sidst_opdateret: new Date().toISOString(),
              }))
            );
            if (!haErr) haeftelserUpserted += detail.haeftelser.length;
          }

          // Upsert servitutter -> tinglysning_servitut (full replace per BFE)
          if (detail.servitutter.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any).from('tinglysning_servitut').delete().eq('bfe_nummer', bfe);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { error: sErr } = await (admin as any).from('tinglysning_servitut').insert(
              detail.servitutter.map((s) => ({
                bfe_nummer: s.bfe_nummer,
                prioritet: s.prioritet,
                tekst: s.tekst,
                type: s.type,
                tinglyst_dato: s.tinglyst_dato,
                akt_navn: s.akt_navn,
                paataleberettiget: s.paataleberettiget,
                sidst_opdateret: new Date().toISOString(),
              }))
            );
            if (!sErr) servitutterUpserted += detail.servitutter.length;
          }

          bfesProcessed++;
        } catch (err) {
          errors++;
          logger.warn(`[tl-detail] BFE ${bfe} fejl:`, err instanceof Error ? err.message : err);
        }

        // Rate limiting: 2 TL-kald per BFE × 500ms
        await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
      }

      const durationMs = Date.now() - startTime;
      const summary = {
        ok: true,
        windowDays,
        datoFra: datoFra || 'explicit-bfe-list',
        datoTil: datoTil || 'explicit-bfe-list',
        aendringerFound,
        bfesUnique: bfes.length,
        bfesProcessed,
        handlerUpserted,
        haeftelserUpserted,
        servitutterUpserted,
        errors,
        durationMs,
      };
      logger.log('[tl-detail] Done:', summary);
      return NextResponse.json(summary);
    }
  );
}
