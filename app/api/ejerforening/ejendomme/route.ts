/**
 * GET /api/ejerforening/ejendomme?cvr=XXX
 *
 * BIZZ-1644: Henter ejendomme administreret af en ejerforening (E/F).
 *
 * To-trins opslag:
 * 1. CVR → ejf_ejerskab → BFE-numre (ejerforholdskode 30 = forening/selskab)
 * 2. BFE → bbr_ejendom_status for adresse + ejendomstype
 * 3. For SFE-ejendomme: hent antal ejerlejligheder under SFE
 *
 * @returns { ejendomme: Array<{ bfe, adresse, ejendomstype, antalLejligheder }> }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';

const querySchema = z.object({
  cvr: z.string().regex(/^\d{8}$/),
});

export interface EjerforeningEjendom {
  bfe: number;
  adresse: string | null;
  dawaId: string | null;
  kommuneKode: number | null;
  ejendomstype: string | null;
  antalLejligheder: number | null;
  ejerandel: string | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'CVR-nummer påkrævet (8 cifre)' }, { status: 400 });
  }
  const { cvr } = parsed.data;

  try {
    const admin = createAdminClient();

    // Trin 1: Find BFE-numre ejet af denne CVR via ejf_ejerskab
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejfRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
      .eq('ejer_cvr', cvr)
      .eq('status', 'gældende')
      .limit(100);

    if (!ejfRows || ejfRows.length === 0) {
      return NextResponse.json({ ejendomme: [] });
    }

    const bfes = ejfRows as Array<{
      bfe_nummer: number;
      ejerandel_taeller: number | null;
      ejerandel_naevner: number | null;
    }>;
    const bfeNums = bfes.map((r) => r.bfe_nummer);

    // Trin 2: Berig med adresse + ejendomstype fra bbr_ejendom_status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: bbrRows } = await (admin as any)
      .from('bbr_ejendom_status')
      .select('bfe_nummer, adgangsadresse_id, kommune_kode, ejendomstype_norm, ejerforholdskode')
      .in('bfe_nummer', bfeNums);

    const bbrMap = new Map<
      number,
      {
        adgangsadresse_id: string | null;
        kommune_kode: number | null;
        ejendomstype_norm: string | null;
        ejerforholdskode: string | null;
      }
    >();
    for (const r of (bbrRows ?? []) as Array<Record<string, unknown>>) {
      bbrMap.set(r.bfe_nummer as number, {
        adgangsadresse_id: (r.adgangsadresse_id as string) ?? null,
        kommune_kode: (r.kommune_kode as number) ?? null,
        ejendomstype_norm: (r.ejendomstype_norm as string) ?? null,
        ejerforholdskode: (r.ejerforholdskode as string) ?? null,
      });
    }

    // Trin 3: For SFE-ejendomme, tæl ejerlejligheder
    const sfeToCount = new Map<number, number>();
    const sfeBfes = bfeNums.filter((bfe) => {
      const bbr = bbrMap.get(bfe);
      return bbr?.ejendomstype_norm === 'SFE' || bbr?.ejerforholdskode === '30';
    });

    if (sfeBfes.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: lejRows } = await (admin as any)
        .from('ejf_ejerskab')
        .select('bfe_nummer')
        .in('bfe_nummer', sfeBfes)
        .neq('ejer_cvr', cvr)
        .eq('status', 'gældende');

      // Count unique BFEs that are ejerlejligheder under each SFE
      // (simplified: just count all ejer-rows that aren't the E/F itself)
      for (const r of (lejRows ?? []) as Array<{ bfe_nummer: number }>) {
        sfeToCount.set(r.bfe_nummer, (sfeToCount.get(r.bfe_nummer) ?? 0) + 1);
      }
    }

    // Trin 4: Resolve adresser via DAWA (best-effort, batch)
    const adresseMap = new Map<number, string>();
    const dawaIds = bfes
      .map((b) => ({ bfe: b.bfe_nummer, dawaId: bbrMap.get(b.bfe_nummer)?.adgangsadresse_id }))
      .filter((x) => x.dawaId);

    // Batch resolve (max 20 for performance)
    for (const { bfe, dawaId } of dawaIds.slice(0, 20)) {
      try {
        const r = await fetch(`https://dawa.aws.dk/adgangsadresser/${dawaId}?struktur=mini`, {
          signal: AbortSignal.timeout(2000),
        });
        if (r.ok) {
          const adr = (await r.json()) as {
            vejnavn?: string;
            husnr?: string;
            postnr?: string;
            postnrnavn?: string;
          };
          if (adr.vejnavn) {
            adresseMap.set(
              bfe,
              `${adr.vejnavn} ${adr.husnr ?? ''}, ${adr.postnr ?? ''} ${adr.postnrnavn ?? ''}`.trim()
            );
          }
        }
      } catch {
        /* best-effort */
      }
    }

    // Byg resultat
    const ejendomme: EjerforeningEjendom[] = bfes.map((b) => {
      const bbr = bbrMap.get(b.bfe_nummer);
      const andel =
        b.ejerandel_taeller != null && b.ejerandel_naevner != null && b.ejerandel_naevner > 0
          ? `${Math.round((b.ejerandel_taeller / b.ejerandel_naevner) * 100)}%`
          : null;
      return {
        bfe: b.bfe_nummer,
        adresse: adresseMap.get(b.bfe_nummer) ?? null,
        dawaId: bbr?.adgangsadresse_id ?? null,
        kommuneKode: bbr?.kommune_kode ?? null,
        ejendomstype: bbr?.ejendomstype_norm ?? null,
        antalLejligheder: sfeToCount.get(b.bfe_nummer) ?? null,
        ejerandel: andel,
      };
    });

    return NextResponse.json(
      { ejendomme },
      {
        headers: { 'Cache-Control': 'public, s-maxage=3600' },
      }
    );
  } catch (err) {
    logger.error('[ejerforening/ejendomme]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
