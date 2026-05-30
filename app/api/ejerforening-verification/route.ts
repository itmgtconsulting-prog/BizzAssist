/**
 * GET    /api/ejerforening-verification?bfeNummer=12345
 *   Returnerer verificeringer for en BFE inkl. brugerens egne verdicts
 *   og aggregerede counts (verified_count, rejected_count) per candidate_cvr.
 *
 * POST   /api/ejerforening-verification
 *   Body: { bfe_nummer, candidate_cvr, verdict }
 *   Gemmer eller opdaterer brugerens verdict (upsert via UNIQUE constraint).
 *
 * DELETE /api/ejerforening-verification?bfeNummer=X&candidateCvr=Y
 *   Fjerner brugerens verdict (trækker stemme tilbage).
 *
 * @module app/api/ejerforening-verification/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

/** Zod schema for POST body */
const PostSchema = z.object({
  bfe_nummer: z.number().int().positive(),
  candidate_cvr: z.string().min(1),
  verdict: z.enum(['verified', 'rejected']),
});

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/**
 * Returnerer Supabase server-client med cookie-baseret session.
 *
 * @returns Supabase client med bruger-auth
 */
async function getSessionClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        /* read-only i route handlers */
      },
    },
  });
}

/** Aggregeret count-række fra ejerforening_verification_counts view */
interface CountRow {
  bfe_nummer: number;
  candidate_cvr: string;
  verified_count: number;
  rejected_count: number;
}

/** Svar-shape per candidate_cvr til frontend */
export interface EjerforeningVerificationSummary {
  candidate_cvr: string;
  verified_count: number;
  rejected_count: number;
  /** Brugerens eget valg — null = ingen stemme */
  user_verdict: 'verified' | 'rejected' | null;
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const bfeParam = req.nextUrl.searchParams.get('bfeNummer') ?? '';
    if (!bfeParam || !/^\d+$/.test(bfeParam)) {
      return NextResponse.json({ error: 'bfeNummer er påkrævet' }, { status: 400 });
    }
    const bfeNummer = Number(bfeParam);

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return NextResponse.json([], { status: 200 });
    }

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Hent brugerens session
    const sessionClient = await getSessionClient();
    const {
      data: { user },
    } = await sessionClient.auth.getUser();

    // Hent aggregerede counts
    const { data: counts, error: countsErr } = await serviceClient
      .from('ejerforening_verification_counts')
      .select('bfe_nummer, candidate_cvr, verified_count, rejected_count')
      .eq('bfe_nummer', bfeNummer);

    if (countsErr) {
      logger.error('[ejerforening-verification GET] counts error:', countsErr.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Hent brugerens egne verdicts
    const userVerdicts = new Map<string, 'verified' | 'rejected'>();
    if (user) {
      const { data: ownVerdicts } = await serviceClient
        .from('ejerforening_verifications')
        .select('candidate_cvr, verdict')
        .eq('bfe_nummer', bfeNummer)
        .eq('user_id', user.id);

      for (const row of (ownVerdicts ?? []) as Array<{
        candidate_cvr: string;
        verdict: 'verified' | 'rejected';
      }>) {
        userVerdicts.set(row.candidate_cvr, row.verdict);
      }
    }

    const result: EjerforeningVerificationSummary[] = (counts as CountRow[]).map((c) => ({
      candidate_cvr: c.candidate_cvr,
      verified_count: Number(c.verified_count),
      rejected_count: Number(c.rejected_count),
      user_verdict: userVerdicts.get(c.candidate_cvr) ?? null,
    }));

    return NextResponse.json(result);
  } catch (err) {
    logger.error('[ejerforening-verification GET] uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return NextResponse.json({ error: 'Supabase ikke konfigureret' }, { status: 503 });
    }

    const sessionClient = await getSessionClient();
    const {
      data: { user },
    } = await sessionClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
    }

    const parsed = PostSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ugyldigt input' }, { status: 400 });
    }
    const { bfe_nummer, candidate_cvr, verdict } = parsed.data;

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { error } = await serviceClient.from('ejerforening_verifications').upsert(
      {
        user_id: user.id,
        bfe_nummer,
        candidate_cvr,
        verdict,
      },
      { onConflict: 'user_id,bfe_nummer,candidate_cvr' }
    );

    if (error) {
      logger.error('[ejerforening-verification POST] upsert error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Matrikel-stempel: gem matrikelnr som verificeret for denne CVR.
    // Bruges af ejendomme-by-owner til at hente ALLE lejligheder fra DAWA.
    const matrikelnr = req.nextUrl.searchParams.get('matrikelnr');
    const postnr = req.nextUrl.searchParams.get('postnr');
    if (verdict === 'verified' && matrikelnr) {
      void (async () => {
        try {
          // Hent ejerlavkode
          const ejlRes = await fetch(
            `https://api.dataforsyningen.dk/adgangsadresser?matrikelnr=${encodeURIComponent(matrikelnr)}&postnr=${postnr ?? ''}&per_side=1&format=json`,
            { signal: AbortSignal.timeout(3000) }
          );
          if (ejlRes.ok) {
            const ejlData = (await ejlRes.json()) as Array<{
              jordstykke?: { ejerlav?: { kode?: number } };
            }>;
            const ejerlavKode = ejlData[0]?.jordstykke?.ejerlav?.kode;
            if (ejerlavKode) {
              const { createAdminClient } = await import('@/lib/supabase/admin');
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (createAdminClient() as any).from('ejerforening_matrikel_verified').upsert(
                {
                  candidate_cvr: candidate_cvr,
                  matrikelnr,
                  ejerlav_kode: ejerlavKode,
                  verified_at: new Date().toISOString(),
                },
                { onConflict: 'candidate_cvr,matrikelnr,ejerlav_kode' }
              );
              logger.log(
                `[ejerforening-verification] Matrikel stemplet: CVR ${candidate_cvr} → matrikel ${matrikelnr} ejerlav ${ejerlavKode}`
              );
            }
          }
        } catch {
          /* matrikel stempel non-fatal */
        }
      })();
    }

    // Matrikel-propagering: når en ejerforening verificeres, propager til
    // ALLE lejligheder på samme matrikel (fire-and-forget). Ejerforeningen
    // dækker hele matriklen, så alle lejligheder bør se den.
    // matrikelnr og postnr allerede defineret ovenfor (linje 179-180)
    if (verdict === 'verified' && matrikelnr && postnr) {
      void (async () => {
        try {
          const { createAdminClient } = await import('@/lib/supabase/admin');
          const admin = createAdminClient();
          // Find alle BFE'er på samme matrikel via bfe_adresse_cache
          // (fanger alle husnumre på matriklen)
          const dawaRes = await fetch(
            `https://api.dataforsyningen.dk/adresser?ejerlavkode=2000174&matrikelnr=${encodeURIComponent(matrikelnr)}&format=json&struktur=mini&per_side=500`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (!dawaRes.ok) return;
          const adresser = (await dawaRes.json()) as Array<{ id: string }>;
          // Hent BFE'er for disse adresser
          const dawaIds = adresser.map((a) => a.id).slice(0, 200);
          if (dawaIds.length === 0) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: bfeRows } = await (admin as any)
            .from('bfe_adresse_cache')
            .select('bfe_nummer')
            .in('dawa_id', dawaIds);
          const siblingBfes = ((bfeRows ?? []) as Array<{ bfe_nummer: number }>)
            .map((r) => r.bfe_nummer)
            .filter((b) => b !== bfe_nummer);
          if (siblingBfes.length === 0) return;
          // Propager: upsert verification for alle siblings
          const rows = siblingBfes.map((b) => ({
            user_id: user.id,
            bfe_nummer: b,
            candidate_cvr,
            verdict: 'verified',
          }));
          await serviceClient
            .from('ejerforening_verifications')
            .upsert(rows, { onConflict: 'user_id,bfe_nummer,candidate_cvr' });
          logger.log(
            `[ejerforening-verification] Propageret til ${siblingBfes.length} siblings på matrikel ${matrikelnr}`
          );
        } catch (propErr) {
          logger.warn(
            '[ejerforening-verification] Propagering fejl:',
            propErr instanceof Error ? propErr.message : propErr
          );
        }
      })();
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[ejerforening-verification POST] uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return NextResponse.json({ error: 'Supabase ikke konfigureret' }, { status: 503 });
    }

    const sessionClient = await getSessionClient();
    const {
      data: { user },
    } = await sessionClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
    }

    const bfeParam = req.nextUrl.searchParams.get('bfeNummer') ?? '';
    const candidateCvr = req.nextUrl.searchParams.get('candidateCvr') ?? '';

    if (!bfeParam || !candidateCvr) {
      return NextResponse.json({ error: 'bfeNummer og candidateCvr er påkrævet' }, { status: 400 });
    }

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { error } = await serviceClient
      .from('ejerforening_verifications')
      .delete()
      .eq('user_id', user.id)
      .eq('bfe_nummer', Number(bfeParam))
      .eq('candidate_cvr', candidateCvr);

    if (error) {
      logger.error('[ejerforening-verification DELETE] error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[ejerforening-verification DELETE] uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}
