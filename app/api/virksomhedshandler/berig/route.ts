/**
 * POST /api/virksomhedshandler/berig
 *
 * BIZZ-1928 / BIZZ-1948: AI-beriget virksomhedshandel-kandidat.
 * Beregner estimeret TRANSAKTIONSVÆRDI for en ejerandels-ændring via
 * branche-multiple, returnerer fuldt beregnings-breakdown (EBITDA × multiple
 * → enterprise value → × ejerandels-delta), datakilde-liste, caveats og et
 * confidence-niveau begrundet i regnskabs-friskhed (ikke medie-hits).
 *
 * Understøttende nyhedsartikler hentes IKKE her — frontend-modalen kalder
 * /api/ai/article-search/articles?phase=raw asynkront (Serper, ingen tokens),
 * så berig forbliver hurtigt og gratis.
 *
 * Retention: ingen persistering — beregnes on-demand, caches kun in-memory (24h).
 *
 * @param body.kandidat_id        - Unik ID for kandidat-rækken
 * @param body.virksomhed_cvr     - CVR-nummer på target-virksomheden
 * @param body.ejerandel_delta_pp - Ændring i ejerandel i procentpoint
 * @param body.aarsresultat_dkk   - Seneste resultat før skat (EBITDA-proxy) i DKK
 * @param body.branchekode        - DB07 branchekode
 * @param body.omsaetning_dkk     - Seneste omsætning i DKK (valgfri, til datakilde/caveat)
 * @param body.regnskab_aar       - Regnskabsår for de brugte tal (valgfri, til confidence/caveat)
 * @returns Estimeret transaktionsværdi, breakdown, datakilder, caveats, confidence
 *
 * @module app/api/virksomhedshandler/berig/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { requireModuleAccess } from '@/app/lib/serverModuleAccess';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { logger } from '@/app/lib/logger';
import {
  beregnTransaktionsvaerdi,
  type Interval,
  type TransaktionsBreakdown,
} from '@/app/lib/virksomhedshandler/brancheMultiples';
import { recordAiUsage } from '@/app/lib/aiTracking';

export const runtime = 'nodejs';
export const maxDuration = 30;

// ─── Types ──────────────────────────────────────────────────────────────────

interface BerigRequest {
  kandidat_id: string;
  virksomhed_cvr: string;
  person_enhedsnummer?: number;
  deltager_navn?: string;
  virksomhed_navn?: string;
  ejerandel_delta_pp: number;
  aarsresultat_dkk: number;
  branchekode: string;
  omsaetning_dkk?: number | null;
  regnskab_aar?: number | null;
  gyldig_fra?: string;
}

interface BerigResponse {
  estimeret_transaktionsvaerdi: (Interval & { currency: 'DKK' }) | null;
  breakdown: TransaktionsBreakdown | null;
  data_sources: string[];
  caveats: string[];
  confidence: 'low' | 'medium' | 'high';
  confidence_reason: string;
}

// ─── Cache (24h TTL) ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { data: BerigResponse; ts: number }>();

/**
 * Renser expired entries fra cache.
 * Kaldes periodisk for at undgå memory leak.
 */
function pruneCache(): void {
  const now = Date.now();
  const keys = Array.from(cache.keys());
  for (let i = 0; i < keys.length; i++) {
    const entry = cache.get(keys[i]);
    if (entry && now - entry.ts > CACHE_TTL_MS) cache.delete(keys[i]);
  }
}

// ─── DKK-formattering (til menneskelæsbare datakilder/caveats) ────────────────

/**
 * Formaterer et DKK-beløb kompakt (mio./t.) til datakilde-tekster.
 *
 * @param amount - Beløb i DKK
 * @returns Kompakt streng, fx "64,4 mio. DKK"
 */
function fmtDkk(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace('.', ',')} mio. DKK`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)} t. DKK`;
  return `${sign}${abs} DKK`;
}

// ─── Datakilder + caveats ─────────────────────────────────────────────────────

/**
 * Bygger listen over hvilke datakilder estimatet hviler på.
 *
 * @param breakdown - Det beregnede breakdown
 * @param req - Den oprindelige request (regnskabsår, omsætning, branche)
 */
function buildDataSources(breakdown: TransaktionsBreakdown, req: BerigRequest): string[] {
  const sources: string[] = [];
  const aar = req.regnskab_aar ? `${req.regnskab_aar}` : 'seneste';
  const omsDel = req.omsaetning_dkk ? `omsætning ${fmtDkk(req.omsaetning_dkk)}, ` : '';
  sources.push(
    `Regnskab (${aar}): ${omsDel}resultat før skat ${fmtDkk(breakdown.ebitda_used)} (EBITDA-proxy)`
  );
  sources.push(
    `Branche-multiple: ${breakdown.branche_label} ${breakdown.multiple.lav}–${breakdown.multiple.hoej}x EV/EBITDA (kilde: ${breakdown.kilde})`
  );
  sources.push(
    `CVR-data: branchekode ${req.branchekode}, ejerandels-ændring ${breakdown.delta_pct} pp`
  );
  return sources;
}

/**
 * Bygger forbehold (caveats) brugeren bør kende, så estimatet ikke
 * fejlfortolkes som en præcis værdiansættelse.
 *
 * @param breakdown - Det beregnede breakdown
 * @param req - Den oprindelige request
 * @param aar - Regnskabets alder i år (null hvis ukendt)
 */
function buildCaveats(
  breakdown: TransaktionsBreakdown,
  req: BerigRequest,
  aar: number | null
): string[] {
  const caveats: string[] = [];
  if (aar != null && aar >= 2) {
    caveats.push(`Regnskabet er ${aar} år gammelt — tallene kan være forældede.`);
  } else if (req.regnskab_aar == null) {
    caveats.push('Regnskabsår er ukendt — estimatet bygger på senest cachede tal.');
  }
  caveats.push(
    'EBITDA-proxy = resultat før skat, ikke ren EBITDA — afskrivninger og renter er ikke renset ud.'
  );
  caveats.push(
    `Branche-multiplen (${breakdown.multiple.lav}–${breakdown.multiple.hoej}x) er et sektor-gennemsnit; faktisk multipel afhænger af vækst, margin og marked.`
  );
  caveats.push(
    'Estimatet er enterprise-value-baseret og ikke korrigeret for gæld, likviditet eller kontrol-præmie.'
  );
  return caveats;
}

// ─── Confidence scoring (regnskabs-baseret, ikke medie-baseret) ──────────────

/**
 * Beregner confidence ud fra regnskabets friskhed og om en branche-multiple
 * kunne matches — ikke længere ud fra medie-dækning (BIZZ-1948).
 *
 * @param hasBreakdown - Om et breakdown kunne beregnes (EBITDA + branche fundet)
 * @param regnskabAlderAar - Regnskabets alder i år (null = ukendt)
 * @param deltaPct - Ejerandels-ændring i procentpoint
 */
function scoreConfidence(
  hasBreakdown: boolean,
  regnskabAlderAar: number | null,
  deltaPct: number
): { confidence: 'low' | 'medium' | 'high'; reason: string } {
  if (!hasBreakdown) {
    return {
      confidence: 'low',
      reason: 'Mangler EBITDA eller branche-multiple — transaktionsværdi kunne ikke estimeres.',
    };
  }
  if (regnskabAlderAar != null && regnskabAlderAar <= 2 && deltaPct >= 25) {
    return {
      confidence: 'high',
      reason: `Friskt regnskab (${regnskabAlderAar} år) + kendt branche-multiple + stor ejerandels-ændring (${deltaPct} pp).`,
    };
  }
  if (regnskabAlderAar != null && regnskabAlderAar <= 4) {
    return {
      confidence: 'medium',
      reason: `Regnskab ${regnskabAlderAar} år gammelt + kendt branche-multiple — rimeligt estimat med moderat usikkerhed.`,
    };
  }
  return {
    confidence: 'low',
    reason:
      regnskabAlderAar == null
        ? 'Regnskabsår ukendt — estimatet er behæftet med stor usikkerhed.'
        : `Regnskab er ${regnskabAlderAar} år gammelt — estimatet er behæftet med stor usikkerhed.`,
  };
}

// ─── POST handler ───────────────────────────────────────────────────────────

/**
 * POST /api/virksomhedshandler/berig
 *
 * Beriger en virksomhedshandel-kandidat med estimeret transaktionsværdi,
 * beregnings-breakdown, datakilder, caveats og confidence.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Rate limit
  const limited = await checkRateLimit(req, aiRateLimit);
  if (limited) return limited;

  // Auth
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }

  // BIZZ-1988: server-side modul-håndhævelse (plan/addon-entitlement) før AI-gaten.
  const blocked = await requireModuleAccess('virksomhedshandler');
  if (blocked) return blocked as unknown as NextResponse;

  // AI billing gate
  const gateResponse = await assertAiAllowed(auth.userId);
  if (gateResponse) return gateResponse as unknown as NextResponse;

  // Parse body
  let body: BerigRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { kandidat_id, virksomhed_cvr, ejerandel_delta_pp, aarsresultat_dkk, branchekode } = body;

  if (
    !kandidat_id ||
    !virksomhed_cvr ||
    ejerandel_delta_pp == null ||
    aarsresultat_dkk == null ||
    !branchekode
  ) {
    return NextResponse.json(
      {
        error:
          'Manglende felter: kandidat_id, virksomhed_cvr, ejerandel_delta_pp, aarsresultat_dkk, branchekode',
      },
      { status: 400 }
    );
  }

  // Check cache (24h TTL)
  pruneCache();
  const cacheKey = `berig:${kandidat_id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    // 1. Beregn transaktionsværdi + breakdown
    const breakdown = beregnTransaktionsvaerdi(branchekode, aarsresultat_dkk, ejerandel_delta_pp);

    // 2. Regnskabs-alder (til confidence + caveats)
    const regnskabAlder =
      body.regnskab_aar != null ? new Date().getFullYear() - body.regnskab_aar : null;

    // 3. Confidence
    const { confidence, reason } = scoreConfidence(
      breakdown !== null,
      regnskabAlder,
      ejerandel_delta_pp
    );

    // 4. Byg response
    const response: BerigResponse = {
      estimeret_transaktionsvaerdi: breakdown
        ? { ...breakdown.transaktionsvaerdi, currency: 'DKK' }
        : null,
      breakdown,
      data_sources: breakdown ? buildDataSources(breakdown, body) : [],
      caveats: breakdown ? buildCaveats(breakdown, body, regnskabAlder) : [],
      confidence,
      confidence_reason: reason,
    };

    // 5. Cache result
    cache.set(cacheKey, { data: response, ts: Date.now() });

    // 6. Record AI usage (fire-and-forget — ren beregning, ingen tokens)
    void recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'virksomhedshandler.berig',
      inputTokens: 0,
      outputTokens: 0,
      model: 'branche-multiple',
    });

    return NextResponse.json(response);
  } catch (err) {
    logger.error('virksomhedshandler/berig fejl', { error: err });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
