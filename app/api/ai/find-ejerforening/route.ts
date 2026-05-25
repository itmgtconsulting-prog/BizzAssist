/**
 * GET /api/ai/find-ejerforening?bfeNummer=12345&adresse=Vigerslevvej+146&postnr=2500
 *
 * AI-baseret reverse-lookup: givet en ejerlejligheds BFE, find den
 * sandsynlige ejerforening der administrerer bygningen.
 *
 * Algoritme:
 *   1. Cache-check (24h TTL)
 *   2. Opslag i bfe_adresse_cache for ejendommens adresse (fallback: query params)
 *   3. Find nabo-ejendomme på samme gade+postnr
 *   4. Check ejf_administrator + ejf_ejerskab for nabo-BFE'er → grupper per CVR
 *   5. Filtrér til ejerforeninger (FFO/forening i cvr_virksomhed)
 *   6. Entydigt match → returner direkte (sparer tokens)
 *   7. Ellers → Claude Sonnet 4.6 evaluerer kandidater
 *   8. recordAiUsage() + cache resultat
 *
 * @param bfeNummer - BFE-nummer for ejendommen
 * @param adresse - Fallback-adresse (bruges når bfe_adresse_cache er tom)
 * @param postnr - Fallback-postnr
 * @returns JSON med { candidates, cachedAt? }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { recordAiUsage } from '@/app/lib/aiTracking';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** AI-fundet ejerforenings-kandidat */
export interface EjerforeningKandidat {
  cvr: string;
  navn: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  administeredCount: number;
}

/** Cache TTL: 24 timer */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ekstrahér gadenavn fra adressestreng (fjern husnummer, interval, etage/kælder-suffix).
 *
 * @param adresse - f.eks. "Vigerslevvej 144-148 (kælder)" eller "Skyttegårdsvej 3, kl."
 * @returns Gadenavn uden nr — f.eks. "Vigerslevvej"
 */
function extractStreetName(adresse: string): string {
  return adresse
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/,\s*\d*\.?\s*(?:kl|st|sal|th|tv|mf)\.?\s*$/i, '')
    .replace(/\s+\d+[\w-]*.*$/, '')
    .trim();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bfeParam = request.nextUrl.searchParams.get('bfeNummer');
  if (!bfeParam || !/^\d+$/.test(bfeParam)) {
    return NextResponse.json({ error: 'Ugyldigt bfeNummer' }, { status: 400 });
  }
  const bfeNummer = Number(bfeParam);

  const admin = createAdminClient();

  try {
    // ── 1. Cache-check ──────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached } = await (admin as any)
      .from('ai_find_ejerforening_cache')
      .select('candidates, created_at')
      .eq('bfe_nummer', bfeNummer)
      .maybeSingle();

    if (cached?.candidates) {
      const age = Date.now() - new Date(cached.created_at).getTime();
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({
          candidates: cached.candidates as EjerforeningKandidat[],
          cachedAt: cached.created_at,
        });
      }
    }

    // Fra dette punkt kræves billing-check + rate limit
    const blocked = await assertAiAllowed(auth.userId);
    if (blocked) return blocked as unknown as NextResponse;

    const rl = await checkRateLimit(request, aiRateLimit);
    if (rl) return rl;

    // ── 2. Opslag i bfe_adresse_cache (med fallback til query params) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: propertyRow } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('adresse, postnr, postnrnavn')
      .eq('bfe_nummer', bfeNummer)
      .maybeSingle();

    // Fallback: frontend sender adresse+postnr som query params
    const fallbackAdresse = request.nextUrl.searchParams.get('adresse');
    const fallbackPostnr = request.nextUrl.searchParams.get('postnr');

    const adresse = propertyRow?.postnr ? propertyRow.adresse : (fallbackAdresse ?? null);
    const postnr = propertyRow?.postnr ? propertyRow.postnr : (fallbackPostnr ?? null);
    const postnrnavn = propertyRow?.postnrnavn ?? null;

    if (!adresse || !postnr) {
      return NextResponse.json({ candidates: [] });
    }

    const gadenavn = extractStreetName(adresse);
    if (!gadenavn) {
      return NextResponse.json({ candidates: [] });
    }

    // ── 3. Find nabo-ejendomme ──────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: naboRows } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('bfe_nummer')
      .ilike('adresse', `${gadenavn}%`)
      .eq('postnr', postnr)
      .limit(200);

    const naboBfes = ((naboRows ?? []) as Array<{ bfe_nummer: number }>).map((r) => r.bfe_nummer);
    // BIZZ-1841: Inkludér target BFE — det kan selv have admin/ejer-registreringer

    // BIZZ-1841: SFE-hierarki traversal — find BFE'er på præcis samme
    // adresse (vejnavn+husnr) som er SFE/hovedejendom-niveauer der dækker
    // target ejerlejligheden. Deres ejf_administrator/ejf_ejerskab rækker
    // fanger ejerforeninger der er registreret på SFE-niveau.
    const husnrMatch = adresse.match(/\s+(\d+)/);
    const targetHusnr = husnrMatch ? husnrMatch[1] : null;
    if (targetHusnr) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: siblingRows } = await (admin as any)
        .from('bfe_adresse_cache')
        .select('bfe_nummer')
        .ilike('adresse', `${gadenavn} ${targetHusnr}%`)
        .eq('postnr', postnr)
        .limit(50);
      for (const row of (siblingRows ?? []) as Array<{ bfe_nummer: number }>) {
        if (!naboBfes.includes(row.bfe_nummer)) {
          naboBfes.push(row.bfe_nummer);
        }
      }
    }

    // Sørg for at target BFE selv er med
    if (!naboBfes.includes(bfeNummer)) {
      naboBfes.push(bfeNummer);
    }

    if (naboBfes.length === 0) {
      return NextResponse.json({ candidates: [] });
    }

    // ── 4. Check ejf_administrator + ejf_ejerskab for naboer ────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: adminRows } = await (admin as any)
      .from('ejf_administrator')
      .select('bfe_nummer, virksomhed_cvr')
      .in('bfe_nummer', naboBfes.slice(0, 200))
      .eq('status', 'gældende')
      .not('virksomhed_cvr', 'is', null);

    // Søg i ejf_ejerskab — gældende ejere
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejerRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_cvr')
      .in('bfe_nummer', naboBfes.slice(0, 200))
      .eq('status', 'gældende')
      .not('ejer_cvr', 'is', null);

    // Søg i ejf_ejerskab — historiske ejere (fanger ejendomme der tidligere
    // tilhørte ejerforeningen, stærkt signal for ejerlejligheder i samme struktur)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: histEjerRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_cvr')
      .in('bfe_nummer', naboBfes.slice(0, 200))
      .eq('status', 'historisk')
      .not('ejer_cvr', 'is', null);

    // Grupper per CVR — track match-årsager for reasoning
    const cvrCounts = new Map<string, number>();
    const cvrReasons = new Map<string, string[]>();
    const adminCvrCount = new Map<string, number>();
    const ejerCvrCount = new Map<string, number>();
    const histEjerCvrCount = new Map<string, number>();

    for (const row of (adminRows ?? []) as Array<{
      bfe_nummer: number;
      virksomhed_cvr: string;
    }>) {
      // BIZZ-1841: Direkte admin-registrering på target/sibling BFE giver
      // højere score (10) end nabo-BFE (1)
      const score = row.bfe_nummer === bfeNummer ? 10 : 1;
      cvrCounts.set(row.virksomhed_cvr, (cvrCounts.get(row.virksomhed_cvr) ?? 0) + score);
      adminCvrCount.set(row.virksomhed_cvr, (adminCvrCount.get(row.virksomhed_cvr) ?? 0) + 1);
      if (row.bfe_nummer === bfeNummer) {
        if (!cvrReasons.has(row.virksomhed_cvr)) cvrReasons.set(row.virksomhed_cvr, []);
        cvrReasons.get(row.virksomhed_cvr)!.push('Direkte administrator for ejendommen');
      }
    }
    for (const row of (ejerRows ?? []) as Array<{
      bfe_nummer: number;
      ejer_cvr: string;
    }>) {
      const score = row.bfe_nummer === bfeNummer ? 10 : 1;
      cvrCounts.set(row.ejer_cvr, (cvrCounts.get(row.ejer_cvr) ?? 0) + score);
      ejerCvrCount.set(row.ejer_cvr, (ejerCvrCount.get(row.ejer_cvr) ?? 0) + 1);
      if (row.bfe_nummer === bfeNummer) {
        if (!cvrReasons.has(row.ejer_cvr)) cvrReasons.set(row.ejer_cvr, []);
        cvrReasons.get(row.ejer_cvr)!.push('Direkte ejer af ejendommen');
      }
    }
    for (const row of (histEjerRows ?? []) as Array<{
      bfe_nummer: number;
      ejer_cvr: string;
    }>) {
      // Historiske ejerskaber giver lavere score men er stadig et signal
      const score = row.bfe_nummer === bfeNummer ? 5 : 1;
      cvrCounts.set(row.ejer_cvr, (cvrCounts.get(row.ejer_cvr) ?? 0) + score);
      histEjerCvrCount.set(row.ejer_cvr, (histEjerCvrCount.get(row.ejer_cvr) ?? 0) + 1);
    }

    // ── 4b. Søg ejerforeninger via navn der matcher gadenavn ────
    // Stærkeste signal: foreningens navn indeholder gadenavn+husnumre.
    // Eksempel: "Ejerforeningen Skyttegårdsvej 1-11 Vigerslevvej 144-148"
    // matcher for en ejendom på Vigerslevvej 146.
    // Filtrerer direkte i query til foreninger (ejerforening/e/f/a/b/andelsbolig)
    // for at undgå at irrelevante virksomheder fylder limit op.
    const foreningPatterns = [
      `navn.ilike.%ejerforening%${gadenavn}%`,
      `navn.ilike.%E/F %${gadenavn}%`,
      `navn.ilike.%A/B %${gadenavn}%`,
      `navn.ilike.%andelsbolig%${gadenavn}%`,
      `navn.ilike.%boligforening%${gadenavn}%`,
      // Omvendt rækkefølge: gade først, forening-ord efter
      `navn.ilike.%${gadenavn}%ejerforening%`,
      `navn.ilike.%${gadenavn}%forening%`,
    ].join(',');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: navnMatchRows } = await (admin as any)
      .from('cvr_virksomhed')
      .select('cvr, navn')
      .or(foreningPatterns)
      .limit(50);

    // Ekstrahér husnummer fra adressen for range-matching
    const husnr = targetHusnr ? Number(targetHusnr) : null;

    for (const row of (navnMatchRows ?? []) as Array<{ cvr: string; navn: string }>) {
      let score = 5; // Base-score for navne-match

      // Bonus: check om foreningens husnummer-range inkluderer vores husnr.
      // Eksempel: "Vigerslevvej 144-148" og husnr=146 → match
      if (husnr !== null) {
        const rangePattern = new RegExp(
          gadenavn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d+)(?:\\s*-\\s*(\\d+))?',
          'i'
        );
        const rm = row.navn.match(rangePattern);
        if (rm) {
          const lo = Number(rm[1]);
          const hi = rm[2] ? Number(rm[2]) : lo;
          if (husnr >= lo && husnr <= hi) {
            score = 20; // Stærkt match — husnummer er i range
          }
        }
      }

      cvrCounts.set(row.cvr, (cvrCounts.get(row.cvr) ?? 0) + score);
      if (score >= 20) {
        if (!cvrReasons.has(row.cvr)) cvrReasons.set(row.cvr, []);
        cvrReasons.get(row.cvr)!.push(`Foreningens navn dækker adressen`);
      } else {
        if (!cvrReasons.has(row.cvr)) cvrReasons.set(row.cvr, []);
        cvrReasons.get(row.cvr)!.push(`Foreningens navn nævner ${gadenavn}`);
      }
    }

    if (cvrCounts.size === 0) {
      // Ingen administratorer/ejere/navnematch fundet — cache tomt resultat
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (admin as any)
        .from('ai_find_ejerforening_cache')
        .upsert(
          { bfe_nummer: bfeNummer, candidates: [], created_at: new Date().toISOString() },
          { onConflict: 'bfe_nummer' }
        )
        .then(() => {});
      return NextResponse.json({ candidates: [] });
    }

    // ── 4c. Filtrér til ejerforeninger (FFO/forening) ───────────
    // Ikke alle CVR'er er ejerforeninger — filtrér via cvr_virksomhed
    const allCvrList = [...cvrCounts.keys()];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: allVirkRows } = await (admin as any)
      .from('cvr_virksomhed')
      .select('cvr, navn, virksomhedsform')
      .in('cvr', allCvrList);

    // Behold kun foreninger (FFO, forening, ejerforening i navn/form)
    const foreningCvrs = new Set<string>();
    for (const row of (allVirkRows ?? []) as Array<{
      cvr: string;
      navn: string;
      virksomhedsform: string | null;
    }>) {
      const navnLower = row.navn.toLowerCase();
      const formLower = (row.virksomhedsform ?? '').toLowerCase();
      if (
        formLower.includes('ffo') ||
        formLower.includes('forening') ||
        navnLower.includes('ejerforening') ||
        navnLower.includes('e/f') ||
        navnLower.includes('a/b') ||
        navnLower.includes('andelsbolig') ||
        navnLower.includes('boligforening')
      ) {
        foreningCvrs.add(row.cvr);
      }
    }

    // Hvis ingen foreninger fundet, prøv med alle CVR'er (fallback)
    const filteredCvrs =
      foreningCvrs.size > 0
        ? new Map([...cvrCounts].filter(([cvr]) => foreningCvrs.has(cvr)))
        : cvrCounts;

    if (filteredCvrs.size === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (admin as any)
        .from('ai_find_ejerforening_cache')
        .upsert(
          { bfe_nummer: bfeNummer, candidates: [], created_at: new Date().toISOString() },
          { onConflict: 'bfe_nummer' }
        )
        .then(() => {});
      return NextResponse.json({ candidates: [] });
    }

    // Hent virksomhedsnavne for filtrerede CVR'er
    const cvrList = [...filteredCvrs.keys()];
    const cvrNavne = new Map<string, string>();
    for (const row of (allVirkRows ?? []) as Array<{ cvr: string; navn: string }>) {
      if (filteredCvrs.has(row.cvr)) {
        cvrNavne.set(row.cvr, row.navn);
      }
    }

    /**
     * Byg reasoning-streng baseret på match-kilder for et CVR.
     *
     * @param cvr - CVR-nummer
     * @returns Reasoning-tekst på dansk
     */
    function buildReasoning(cvr: string): string {
      const parts: string[] = [];
      const ac = adminCvrCount.get(cvr);
      const ec = ejerCvrCount.get(cvr);
      const hc = histEjerCvrCount.get(cvr);
      if (ac && ac > 0) parts.push(`Administrator for ${ac} ejendomme i ejendomsstrukturen`);
      if (ec && ec > 0) parts.push(`Registreret ejer af ${ec} ejendomme på ${gadenavn}`);
      if (hc && hc > 0) parts.push(`Historisk registreret på ${hc} ejendomme i ejendomsstrukturen`);
      const extraReasons = cvrReasons.get(cvr) ?? [];
      for (const r of extraReasons) {
        if (!parts.includes(r)) parts.push(r);
      }
      return parts.length > 0 ? parts.join('. ') : `Fundet i nærområdet`;
    }

    // ── 5. Entydigt match → returner direkte ────────────────────
    if (filteredCvrs.size === 1) {
      const [cvr, count] = [...filteredCvrs.entries()][0];
      const result: EjerforeningKandidat[] = [
        {
          cvr,
          navn: cvrNavne.get(cvr) ?? `CVR ${cvr}`,
          confidence: count >= 3 ? 'high' : 'medium',
          reasoning: buildReasoning(cvr),
          administeredCount: count,
        },
      ];

      // Cache
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (admin as any)
        .from('ai_find_ejerforening_cache')
        .upsert(
          { bfe_nummer: bfeNummer, candidates: result, created_at: new Date().toISOString() },
          { onConflict: 'bfe_nummer' }
        )
        .then(() => {});

      return NextResponse.json({ candidates: result });
    }

    // ── 6. Flere kandidater → Claude evaluerer ──────────────────
    const kandidatListe = cvrList
      .map((cvr) => {
        const navn = cvrNavne.get(cvr) ?? `CVR ${cvr}`;
        const count = filteredCvrs.get(cvr) ?? 0;
        return `CVR ${cvr}: ${navn} (ejer/administrerer ${count} ejendomme i området)`;
      })
      .join('\n');

    const systemPrompt = `Du er en dansk ejendomsanalytiker. Du skal finde den mest sandsynlige ejerforening for en specifik ejerlejlighed.

Du modtager:
1. Ejerlejlighedens adresse
2. En liste over ejerforeninger der administrerer andre ejendomme på samme gade

Din opgave: Vurdér hvilken ejerforening der mest sandsynligt administrerer den givne ejerlejlighed.

VURDERINGSKRITERIER:
- Antal administrerede ejendomme på gaden: Flere = mere sandsynligt
- Foreningens navn: Matcher det gadenavn eller husnummer-range?
- Hvis én forening klart dominerer gaden, er den mest sandsynlig

REGLER:
- confidence: "high" (>80% sikker), "medium" (50-80%), "low" (<50%)
- Vær konservativ — hellere "medium" end forkert "high"
- Skriv kort reasoning på dansk (max 1 sætning per kandidat)
- Returnér ALLE kandidater, sorteret efter sandsynlighed

Svar UDELUKKENDE med valid JSON array:
[{"cvr": "12345678", "confidence": "high", "reasoning": "Administrerer flest ejendomme på gaden og navnet matcher"}]

Ingen markdown, ingen forklaring uden for arrayet.`;

    const userPrompt = `Ejerlejlighed: ${adresse}, ${postnr} ${postnrnavn ?? ''}

Kandidat-ejerforeninger:
${kandidatListe}`;

    const client = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Track AI usage
    const usage = response.usage;
    void recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'ai.find-ejerforening',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      model: 'claude-sonnet-4-6',
    });

    // Parse AI response
    const aiText = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '[]';
    let aiCandidates: Array<{ cvr: string; confidence: string; reasoning: string }> = [];
    try {
      const cleaned = aiText
        .replace(/```json?\s*/g, '')
        .replace(/```/g, '')
        .trim();
      aiCandidates = JSON.parse(cleaned);
    } catch {
      logger.warn('[ai/find-ejerforening] Could not parse AI response:', aiText.slice(0, 200));
      // Fallback: returner alle kandidater med medium confidence
      aiCandidates = cvrList.map((cvr) => ({
        cvr,
        confidence: 'medium',
        reasoning: buildReasoning(cvr),
      }));
    }

    // ── 7. Berig + cache ────────────────────────────────────────
    const validConfidences = new Set(['high', 'medium', 'low']);
    const result: EjerforeningKandidat[] = aiCandidates
      .filter((c) => c.cvr && validConfidences.has(c.confidence))
      .map((c) => ({
        cvr: c.cvr,
        navn: cvrNavne.get(c.cvr) ?? `CVR ${c.cvr}`,
        confidence: c.confidence as 'high' | 'medium' | 'low',
        reasoning: c.reasoning ?? '',
        administeredCount: filteredCvrs.get(c.cvr) ?? 0,
      }));

    // Cache resultatet
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (admin as any)
      .from('ai_find_ejerforening_cache')
      .upsert(
        { bfe_nummer: bfeNummer, candidates: result, created_at: new Date().toISOString() },
        { onConflict: 'bfe_nummer' }
      )
      .then(() => {});

    return NextResponse.json({ candidates: result });
  } catch (err) {
    logger.error('[ai/find-ejerforening] Error:', err instanceof Error ? err.message : 'unknown');
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
