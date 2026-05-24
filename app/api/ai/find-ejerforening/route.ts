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

    const naboBfes = ((naboRows ?? []) as Array<{ bfe_nummer: number }>)
      .map((r) => r.bfe_nummer)
      .filter((b) => b !== bfeNummer);

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

    // Søg også i ejf_ejerskab — ejerforeninger er ofte registreret som ejere
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejerRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_cvr')
      .in('bfe_nummer', naboBfes.slice(0, 200))
      .eq('status', 'gældende')
      .not('ejer_cvr', 'is', null);

    // Grupper per CVR (administrator + ejer)
    const cvrCounts = new Map<string, number>();
    for (const row of (adminRows ?? []) as Array<{
      bfe_nummer: number;
      virksomhed_cvr: string;
    }>) {
      cvrCounts.set(row.virksomhed_cvr, (cvrCounts.get(row.virksomhed_cvr) ?? 0) + 1);
    }
    for (const row of (ejerRows ?? []) as Array<{
      bfe_nummer: number;
      ejer_cvr: string;
    }>) {
      cvrCounts.set(row.ejer_cvr, (cvrCounts.get(row.ejer_cvr) ?? 0) + 1);
    }

    if (cvrCounts.size === 0) {
      // Ingen administratorer/ejere fundet i nærområdet — cache tomt resultat
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

    // ── 4b. Filtrér til ejerforeninger (FFO/forening) ───────────
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

    // ── 5. Entydigt match → returner direkte ────────────────────
    if (filteredCvrs.size === 1) {
      const [cvr, count] = [...filteredCvrs.entries()][0];
      const result: EjerforeningKandidat[] = [
        {
          cvr,
          navn: cvrNavne.get(cvr) ?? `CVR ${cvr}`,
          confidence: count >= 3 ? 'high' : 'medium',
          reasoning: `Administrerer ${count} ejendomme på ${gadenavn}`,
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
        reasoning: `Ejer/administrerer ${filteredCvrs.get(cvr) ?? 0} ejendomme i området`,
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
