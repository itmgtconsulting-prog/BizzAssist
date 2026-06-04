/**
 * POST /api/virksomhedshandler/berig
 *
 * BIZZ-1928 / BIZZ-1948: AI-beriget virksomhedshandel-kandidat.
 * Beregner estimeret TRANSAKTIONSVÆRDI for en ejerandels-ændring via
 * branche-multiple, returnerer fuldt beregnings-breakdown (EBITDA × multiple
 * → enterprise value → × ejerandels-delta), datakilde-liste, caveats og et
 * confidence-niveau begrundet i regnskabs-friskhed (ikke medie-hits).
 *
 * Oven på den deterministiske baseline kalder routen Claude for en KVALITATIV
 * AI-vurdering (vurdering + værdidrivere + risici), forankret i de beregnede
 * tal så modellen ikke kan hallucinere nye hårde beløb. Det reelle token-forbrug
 * tilskrives brugeren via recordAiUsage og returneres som `tokensUsed`, så det
 * vises og tæller med på linje med løsningens øvrige AI-handlinger.
 *
 * Understøttende nyhedsartikler hentes IKKE her — frontend-modalen kalder
 * /api/ai/article-search/articles?phase=raw asynkront (Serper, ingen tokens).
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
import Anthropic from '@anthropic-ai/sdk';
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
import { recordAiUsage, extractTokenUsage } from '@/app/lib/aiTracking';

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

/**
 * AI-genereret kvalitativ vurdering oven på det deterministiske baseline-estimat.
 * Claude tilføjer IKKE nye hårde tal — den fortolker baseline-beregningen.
 */
interface AiVurdering {
  /** 2-3 sætningers narrativ vurdering forankret i baseline-beregningen. */
  vurdering: string;
  /** Faktorer der kan trække værdien op (vækst, margin, marked). */
  vaerdidrivere: string[];
  /** Faktorer der kan trække værdien ned / usikkerheder. */
  risici: string[];
}

interface BerigResponse {
  estimeret_transaktionsvaerdi: (Interval & { currency: 'DKK' }) | null;
  breakdown: TransaktionsBreakdown | null;
  data_sources: string[];
  caveats: string[];
  confidence: 'low' | 'medium' | 'high';
  confidence_reason: string;
  /** Claude-genereret kvalitativ vurdering (null hvis AI-kald fejlede/ikke kørte). */
  ai_vurdering: AiVurdering | null;
  /** Samlet antal Claude-tokens brugt på denne berigelse (0 = ingen AI-kald). */
  tokensUsed: number;
  /** True når svaret kom fra cachen (intet nyt token-forbrug). */
  fromCache: boolean;
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

// ─── AI-vurdering (Claude, forankret i deterministisk baseline) ──────────────

/** Resultat af et Claude-berigelses-kald: vurdering + reelt token-forbrug. */
interface AiVurderingResult {
  aiVurdering: AiVurdering | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Kalder Claude for en kvalitativ M&A-vurdering FORANKRET i det deterministiske
 * baseline-estimat. Claude må ikke opfinde nye hårde tal — den fortolker den
 * allerede beregnede transaktionsværdi (vækst-/margin-drivere, risici), så
 * brugeren får en reel AI-værdiansættelse der bruger + viser tokens som de
 * øvrige AI-handlinger i løsningen.
 *
 * Fail-soft: returnerer aiVurdering=null + 0 tokens hvis nøglen mangler, Claude
 * fejler, eller svaret ikke kan parses — så baseline-estimatet altid leveres.
 *
 * @param breakdown - Det deterministiske beregnings-breakdown (baseline)
 * @param req - Den oprindelige request (virksomheds-kontekst)
 * @param confidence - Det regnskabs-baserede confidence-niveau
 * @returns AI-vurdering + input/output-tokens (0 ved fallback)
 */
async function generateAiVurdering(
  breakdown: TransaktionsBreakdown,
  req: BerigRequest,
  confidence: 'low' | 'medium' | 'high'
): Promise<AiVurderingResult> {
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) return { aiVurdering: null, inputTokens: 0, outputTokens: 0 };

  const navn = req.virksomhed_navn ? `"${req.virksomhed_navn}"` : `CVR ${req.virksomhed_cvr}`;
  const tv = breakdown.transaktionsvaerdi;
  const system =
    'Du er en dansk M&A-analytiker. Du får en deterministisk baseline-værdiansættelse ' +
    'af en ejerandels-ændring, beregnet via branche-multiple (EV/EBITDA). Din opgave er ' +
    'at give en KVALITATIV fortolkning — IKKE at opfinde nye tal. Anvend kun de tal du får. ' +
    'Vurdér hvad der kan trække værdien op eller ned. Svar UDELUKKENDE med gyldig JSON i ' +
    'formatet: {"vurdering": string (2-3 sætninger på dansk), "vaerdidrivere": string[] ' +
    '(2-4 korte punkter), "risici": string[] (2-4 korte punkter)}. Ingen markdown, kun JSON.';
  const userMessage =
    `Virksomhed: ${navn}\n` +
    `Branche: ${breakdown.branche_label} (DB07 ${req.branchekode})\n` +
    `EBITDA-proxy (resultat før skat): ${fmtDkk(breakdown.ebitda_used)}\n` +
    `${req.omsaetning_dkk ? `Omsætning: ${fmtDkk(req.omsaetning_dkk)}\n` : ''}` +
    `Anvendt branche-multiple: ${breakdown.multiple.lav}–${breakdown.multiple.hoej}x EV/EBITDA\n` +
    `Enterprise value: ${fmtDkk(breakdown.ev_range.lav)} – ${fmtDkk(breakdown.ev_range.hoej)}\n` +
    `Ejerandels-ændring: ${breakdown.delta_pct} procentpoint\n` +
    `Baseline transaktionsværdi: ${fmtDkk(tv.lav)} – ${fmtDkk(tv.hoej)} (midt ${fmtDkk(tv.mid)})\n` +
    `Datafriskhed/confidence: ${confidence}\n\n` +
    'Giv din kvalitative vurdering forankret i ovenstående tal.';

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const { inputTokens, outputTokens } = extractTokenUsage(response);

    // Trim evt. markdown-fence og parse JSON.
    const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(jsonStr) as Partial<AiVurdering>;
    const aiVurdering: AiVurdering = {
      vurdering: typeof parsed.vurdering === 'string' ? parsed.vurdering : '',
      vaerdidrivere: Array.isArray(parsed.vaerdidrivere)
        ? parsed.vaerdidrivere.filter((x): x is string => typeof x === 'string').slice(0, 4)
        : [],
      risici: Array.isArray(parsed.risici)
        ? parsed.risici.filter((x): x is string => typeof x === 'string').slice(0, 4)
        : [],
    };
    if (!aiVurdering.vurdering) {
      return { aiVurdering: null, inputTokens, outputTokens };
    }
    return { aiVurdering, inputTokens, outputTokens };
  } catch (err) {
    logger.warn('virksomhedshandler/berig: AI-vurdering fejlede (fallback til baseline)', {
      error: err,
    });
    return { aiVurdering: null, inputTokens: 0, outputTokens: 0 };
  }
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
    // Cache-hit: intet nyt token-forbrug — markér så UI'en ikke viser token-pris igen.
    return NextResponse.json({ ...cached.data, fromCache: true });
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

    // 4. AI-vurdering via Claude — forankret i baseline-beregningen.
    // Kun når et breakdown findes (ellers er der intet at fortolke).
    let aiVurdering: AiVurdering | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    if (breakdown) {
      const ai = await generateAiVurdering(breakdown, body, confidence);
      aiVurdering = ai.aiVurdering;
      inputTokens = ai.inputTokens;
      outputTokens = ai.outputTokens;
    }

    // 5. Byg response
    const response: BerigResponse = {
      estimeret_transaktionsvaerdi: breakdown
        ? { ...breakdown.transaktionsvaerdi, currency: 'DKK' }
        : null,
      breakdown,
      data_sources: breakdown ? buildDataSources(breakdown, body) : [],
      caveats: breakdown ? buildCaveats(breakdown, body, regnskabAlder) : [],
      confidence,
      confidence_reason: reason,
      ai_vurdering: aiVurdering,
      tokensUsed: inputTokens + outputTokens,
      fromCache: false,
    };

    // 6. Cache result
    cache.set(cacheKey, { data: response, ts: Date.now() });

    // 7. Record AI-token-forbrug (kun hvis Claude faktisk kørte → no-op ved 0).
    void recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'virksomhedshandler.berig',
      inputTokens,
      outputTokens,
      model: 'claude-sonnet-4-6',
    });

    return NextResponse.json(response);
  } catch (err) {
    logger.error('virksomhedshandler/berig fejl', { error: err });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
