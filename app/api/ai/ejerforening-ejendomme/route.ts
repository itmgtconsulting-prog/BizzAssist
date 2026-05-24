/**
 * GET /api/ai/ejerforening-ejendomme?cvr=12345678
 *
 * BIZZ-1828: AI-baseret resolve af ejerforenings-ejendomme.
 * Finder administrerede BFE'er, ekstraherer adresse-clusters, finder
 * kandidat-ejendomme på samme gader, og kalder Claude til at vurdere
 * sandsynligheden for at hver kandidat tilhører ejerforeningen.
 *
 * Resultatet caches i Supabase (24t TTL) pr. CVR.
 *
 * @param cvr - CVR-nummer for ejerforeningen
 * @returns JSON med {candidates: AiEjendomKandidat[], cachedAt?: string}
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

/** AI-vurderet kandidat-ejendom */
export interface AiEjendomKandidat {
  bfeNummer: number;
  adresse: string;
  postnr: string | null;
  by: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/** Cache TTL: 24 timer */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hent adresse-clusters fra direkte administrerede BFE'er.
 * Returnerer unikke gadenavn+postnr par.
 *
 * @param adminBfes - BFE-numre fra ejf_administrator
 * @param admin - Supabase admin client
 * @returns Array af {gadenavn, postnr} clusters
 */
async function extractAddressClusters(
  adminBfes: number[],
  admin: ReturnType<typeof createAdminClient>
): Promise<Array<{ gadenavn: string; postnr: string; adresser: string[] }>> {
  if (adminBfes.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: adresseRows } = await (admin as any)
    .from('bfe_adresse_cache')
    .select('bfe_nummer, adresse, postnr, postnrnavn')
    .in('bfe_nummer', adminBfes.slice(0, 100));

  const clusterMap = new Map<string, { gadenavn: string; postnr: string; adresser: string[] }>();
  for (const row of (adresseRows ?? []) as Array<{
    bfe_nummer: number;
    adresse: string | null;
    postnr: string | null;
    postnrnavn: string | null;
  }>) {
    if (!row.adresse || !row.postnr) continue;
    // Ekstrahér gadenavn (fjern husnummer, interval, etage/kælder-suffix)
    // Eksempler: "Vigerslevvej 144-148 (kælder)" → "Vigerslevvej"
    //            "Skyttegårdsvej 3, kl." → "Skyttegårdsvej"
    const gadenavn = row.adresse
      .replace(/\s*\(.*?\)\s*/g, '') // fjern parenteser: "(kælder)", "(st.)"
      .replace(/,\s*\d*\.?\s*(?:kl|st|sal|th|tv|mf)\.?\s*$/i, '') // fjern etage-suffix
      .replace(/\s+\d+[\w-]*.*$/, '') // fjern husnummer og alt efter (inkl. intervaller som 144-148)
      .trim();
    if (!gadenavn) continue;
    const key = `${gadenavn}|${row.postnr}`;
    if (!clusterMap.has(key)) {
      clusterMap.set(key, { gadenavn, postnr: row.postnr, adresser: [] });
    }
    clusterMap.get(key)!.adresser.push(row.adresse);
  }
  return [...clusterMap.values()];
}

/**
 * Find kandidat-ejendomme på samme gader som administrerede ejendomme.
 *
 * @param clusters - Adresse-clusters
 * @param adminBfes - BFE'er der allerede er administrerede (ekskluderes)
 * @param admin - Supabase admin client
 * @returns Array af kandidat-BFE'er med adresser
 */
async function findCandidates(
  clusters: Array<{ gadenavn: string; postnr: string }>,
  adminBfes: Set<number>,
  admin: ReturnType<typeof createAdminClient>
): Promise<
  Array<{ bfe_nummer: number; adresse: string; postnr: string; postnrnavn: string | null }>
> {
  if (clusters.length === 0) return [];

  const candidates: Array<{
    bfe_nummer: number;
    adresse: string;
    postnr: string;
    postnrnavn: string | null;
  }> = [];

  // Søg pr. gadenavn+postnr via ILIKE
  for (const cluster of clusters.slice(0, 10)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows } = await (admin as any)
      .from('bfe_adresse_cache')
      .select('bfe_nummer, adresse, postnr, postnrnavn')
      .ilike('adresse', `${cluster.gadenavn}%`)
      .eq('postnr', cluster.postnr)
      .limit(50);

    for (const row of (rows ?? []) as Array<{
      bfe_nummer: number;
      adresse: string;
      postnr: string;
      postnrnavn: string | null;
    }>) {
      if (!adminBfes.has(row.bfe_nummer)) {
        candidates.push(row);
      }
    }
  }

  // Dedup
  const seen = new Set<number>();
  return candidates.filter((c) => {
    if (seen.has(c.bfe_nummer)) return false;
    seen.add(c.bfe_nummer);
    return true;
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as unknown as NextResponse;

  const rl = await checkRateLimit(request, aiRateLimit);
  if (rl) return rl;

  const cvr = request.nextUrl.searchParams.get('cvr');
  if (!cvr || !/^\d{8}$/.test(cvr)) {
    return NextResponse.json({ error: 'Ugyldigt CVR' }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    // Check cache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached } = await (admin as any)
      .from('ai_ejf_ejendom_cache')
      .select('candidates, created_at')
      .eq('cvr', cvr)
      .maybeSingle();

    if (cached?.candidates) {
      const age = Date.now() - new Date(cached.created_at).getTime();
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({
          candidates: cached.candidates as AiEjendomKandidat[],
          cachedAt: cached.created_at,
        });
      }
    }

    // Hent direkte administrerede BFE'er
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: adminRows } = await (admin as any)
      .from('ejf_administrator')
      .select('bfe_nummer')
      .eq('virksomhed_cvr', cvr)
      .eq('status', 'gældende')
      .limit(200);

    // Tilføj også ejede ejendomme fra ejf_ejerskab (gældende + historisk)
    // Historiske records fanger ejendomme der tidligere var registreret under foreningen
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejerRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer')
      .eq('ejer_cvr', cvr)
      .limit(200);

    const adminBfes = new Set<number>();
    for (const row of (adminRows ?? []) as Array<{ bfe_nummer: number }>) {
      adminBfes.add(row.bfe_nummer);
    }
    for (const row of (ejerRows ?? []) as Array<{ bfe_nummer: number }>) {
      adminBfes.add(row.bfe_nummer);
    }

    if (adminBfes.size === 0) {
      return NextResponse.json({ candidates: [] });
    }

    // Hent virksomhedsnavn
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: virkRow } = await (admin as any)
      .from('cvr_virksomhed')
      .select('navn')
      .eq('cvr', cvr)
      .maybeSingle();
    const virkNavn = virkRow?.navn ?? `CVR ${cvr}`;

    // Ekstrahér adresse-clusters fra registrerede ejendomme
    const clusters = await extractAddressClusters([...adminBfes], admin);

    // Udtræk gadenavne fra virksomhedsnavnet som ekstra clusters.
    // Eksempel: "Ejerforeningen Skyttegårdsvej 1-11 Vigerslevvej 144-148"
    // → ekstra clusters for "Skyttegårdsvej" og "Vigerslevvej" i samme postnr.
    const existingStreets = new Set(clusters.map((c) => c.gadenavn.toLowerCase()));
    const postnrFromClusters = clusters[0]?.postnr;
    if (postnrFromClusters) {
      const streetPattern =
        /([A-ZÆØÅ][a-zæøåé]+(?:gade|vej|allé|stræde|plads|boulevard|vænge|park|have|gård|sti|torv|bro)\w*)/g;
      let match: RegExpExecArray | null;
      while ((match = streetPattern.exec(virkNavn)) !== null) {
        const street = match[1];
        if (!existingStreets.has(street.toLowerCase())) {
          clusters.push({ gadenavn: street, postnr: postnrFromClusters, adresser: [] });
          existingStreets.add(street.toLowerCase());
        }
      }
    }

    if (clusters.length === 0) {
      return NextResponse.json({ candidates: [] });
    }

    // Find kandidater via adresse-clusters
    const candidates = await findCandidates(clusters, adminBfes, admin);

    // Fallback: parse husnummer-ranges fra foreningens navn og søg direkte.
    // Eksempel: "Skyttegårdsvej 1-11 Vigerslevvej 144-148" → søg BFE'er
    // på Skyttegårdsvej 1-11 og Vigerslevvej 144-148.
    if (candidates.length === 0) {
      const rangePattern =
        /([A-ZÆØÅ][a-zæøåé]+(?:gade|vej|allé|stræde|plads|vænge|park|gård)\w*)\s+(\d+)(?:\s*-\s*(\d+))?/gi;
      let rm: RegExpExecArray | null;
      const seenBfes = new Set(candidates.map((c) => c.bfe_nummer));
      while ((rm = rangePattern.exec(virkNavn)) !== null) {
        const street = rm[1];
        const lo = Number(rm[2]);
        const hi = rm[3] ? Number(rm[3]) : lo;
        // Søg alle BFE'er på denne gade i postnr
        const pnr = postnrFromClusters ?? '0000';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: rangeRows } = await (admin as any)
          .from('bfe_adresse_cache')
          .select('bfe_nummer, adresse, postnr, postnrnavn')
          .ilike('adresse', `${street}%`)
          .eq('postnr', pnr)
          .limit(200);

        for (const row of (rangeRows ?? []) as Array<{
          bfe_nummer: number;
          adresse: string;
          postnr: string;
          postnrnavn: string | null;
        }>) {
          if (adminBfes.has(row.bfe_nummer) || seenBfes.has(row.bfe_nummer)) continue;
          // Check om husnr er i range
          const hnrMatch = row.adresse.match(/\s+(\d+)/);
          if (hnrMatch) {
            const hnr = Number(hnrMatch[1]);
            if (hnr >= lo && hnr <= hi) {
              candidates.push(row);
              seenBfes.add(row.bfe_nummer);
            }
          }
        }
      }
    }

    if (candidates.length === 0) {
      return NextResponse.json({ candidates: [] });
    }

    // Byg Claude prompt
    const adminAdresser = clusters
      .flatMap((c) => c.adresser)
      .slice(0, 30)
      .join('\n- ');
    const kandidatListe = candidates
      .slice(0, 40)
      .map((c) => `BFE ${c.bfe_nummer}: ${c.adresse}, ${c.postnr} ${c.postnrnavn ?? ''}`)
      .join('\n');

    const systemPrompt = `Du er en dansk ejendomsanalytiker der hjælper med at identificere ejendomme der sandsynligvis tilhører en ejerforening.

Du modtager:
1. Ejerforeningens navn og CVR
2. Liste af ejendomme der ALLEREDE er registreret under foreningen
3. Liste af KANDIDAT-ejendomme på samme gader

Din opgave: Vurdér for HVER kandidat-ejendom om den sandsynligvis tilhører ejerforeningen.

VURDERINGSKRITERIER:
- Adresseproximitet: Ejendomme på samme gade og i sammenhængende husnumre-range er sandsynlige
- Ejendomstype: Ejerforeninger administrerer typisk ejerlejligheder i samme bygning/kompleks
- Nummerserier: Hvis foreningen har nr. 2, 4, 6 → nr. 8 er sandsynlig. Hvis der er et "hul" → fyld det
- Tværgade-logik: Hjørneejendomme kan have adresse på tværgaden men tilhøre foreningen

REGLER:
- Returnér KUN ejendomme du mener tilhører foreningen med rimelig sikkerhed
- confidence: "high" (>80% sikker), "medium" (50-80%), "low" (<50%)
- Vær konservativ — hellere misse én end inkludere én der ikke hører til
- Skriv kort reasoning på dansk (max 1 sætning per ejendom)

Svar UDELUKKENDE med valid JSON array:
[{"bfeNummer": 12345, "confidence": "high", "reasoning": "Ligger mellem nr. 4 og 8 som begge tilhører foreningen"}]

Ingen markdown, ingen forklaring uden for arrayet.`;

    const userPrompt = `Ejerforening: ${virkNavn} (CVR ${cvr})

Allerede registrerede ejendomme:
- ${adminAdresser}

Kandidat-ejendomme at vurdere:
${kandidatListe}`;

    const client = new Anthropic({ apiKey: process.env.BIZZASSIST_CLAUDE_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Track AI usage
    const usage = response.usage;
    void recordAiUsage({
      userId: auth.userId,
      tenantId: auth.tenantId,
      route: 'ai.ejerforening-ejendomme',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      model: 'claude-sonnet-4-6',
    });

    // Parse AI response
    const aiText = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '[]';
    let aiCandidates: Array<{
      bfeNummer: number;
      confidence: string;
      reasoning: string;
    }> = [];
    try {
      // Fjern evt. markdown code fences
      const cleaned = aiText
        .replace(/```json?\s*/g, '')
        .replace(/```/g, '')
        .trim();
      aiCandidates = JSON.parse(cleaned);
    } catch {
      logger.warn('[ai/ejerforening-ejendomme] Could not parse AI response:', aiText.slice(0, 200));
      return NextResponse.json({ candidates: [] });
    }

    // Berig med adresse-data og validér confidence
    const validConfidences = new Set(['high', 'medium', 'low']);
    const result: AiEjendomKandidat[] = aiCandidates
      .filter((c) => c.bfeNummer && validConfidences.has(c.confidence))
      .map((c) => {
        const candidateRow = candidates.find((cr) => cr.bfe_nummer === c.bfeNummer);
        return {
          bfeNummer: c.bfeNummer,
          adresse: candidateRow?.adresse ?? `BFE ${c.bfeNummer}`,
          postnr: candidateRow?.postnr ?? null,
          by: candidateRow?.postnrnavn ?? null,
          confidence: c.confidence as 'high' | 'medium' | 'low',
          reasoning: c.reasoning ?? '',
        };
      });

    // Cache resultatet
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (admin as any)
      .from('ai_ejf_ejendom_cache')
      .upsert(
        {
          cvr,
          candidates: result,
          created_at: new Date().toISOString(),
        },
        { onConflict: 'cvr' }
      )
      .then(() => {});

    return NextResponse.json({ candidates: result });
  } catch (err) {
    logger.error(
      '[ai/ejerforening-ejendomme] Error:',
      err instanceof Error ? err.message : 'unknown'
    );
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
