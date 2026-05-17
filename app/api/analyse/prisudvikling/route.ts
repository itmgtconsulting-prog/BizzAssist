/**
 * GET /api/analyse/prisudvikling?bfe=XXXXX
 *
 * BIZZ-1464: Henter prisudvikling, ejerskabshistorik og m²-pris
 * for en ejendom fra lokale tabeller (ejerskifte_historik +
 * tinglysning_adkomst + bbr_ejendom_status).
 *
 * Returnerer data klar til Recharts line/bar charts.
 *
 * @param bfe - BFE-nummer
 * @returns { prishistorik, ejerskaber, ejendom, kommuneGennemsnit }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bfe = Number(req.nextUrl.searchParams.get('bfe'));
  if (!Number.isFinite(bfe) || bfe <= 0) {
    return NextResponse.json({ error: 'Ugyldigt BFE-nummer' }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // 1. Ejerskiftehistorik med priser
  const { data: ejerskifter } = await admin
    .from('ejerskifte_historik')
    .select(
      'overtagelsesdato, ejer_navn, ejer_cvr, ejer_type, kontant_koebesum, i_alt_koebesum, m2_pris, boligareal_m2, kommune_kode'
    )
    .eq('bfe_nummer', bfe)
    .order('overtagelsesdato', { ascending: true });

  // 2. Tinglysning adkomster (supplement)
  const { data: adkomster } = await admin
    .from('tinglysning_adkomst')
    .select('overtagelsesdato, ejer_navn, ejer_cvr, kontant_koebesum, i_alt_koebesum, dokument_id')
    .eq('bfe_nummer', bfe)
    .order('overtagelsesdato', { ascending: true });

  // 3. Ejendomsdata fra BBR
  const { data: ejendom } = await admin
    .from('bbr_ejendom_status')
    .select(
      'bfe_nummer, kommune_kode, samlet_boligareal, byg021_anvendelse, opfoerelsesaar, energimaerke'
    )
    .eq('bfe_nummer', bfe)
    .single();

  // 4. Kommune-gennemsnit m²-pris (for sammenligning)
  let kommuneGennemsnit = null;
  const kommuneKode = ejendom?.kommune_kode ?? ejerskifter?.[0]?.kommune_kode ?? null;
  if (kommuneKode) {
    const { data: kgData } = await admin
      .from('ejerskifte_historik')
      .select('overtagelsesdato, m2_pris')
      .eq('kommune_kode', kommuneKode)
      .not('m2_pris', 'is', null)
      .order('overtagelsesdato', { ascending: true })
      .limit(500);

    if (kgData && kgData.length > 0) {
      // Gruppér per kvartal
      const byQuarter = new Map<string, number[]>();
      for (const r of kgData) {
        if (!r.overtagelsesdato || !r.m2_pris) continue;
        const d = new Date(r.overtagelsesdato);
        const q = `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
        if (!byQuarter.has(q)) byQuarter.set(q, []);
        byQuarter.get(q)!.push(r.m2_pris);
      }
      kommuneGennemsnit = Array.from(byQuarter.entries())
        .map(([kvartal, priser]) => ({
          kvartal,
          gns_m2_pris: Math.round(priser.reduce((a, b) => a + b, 0) / priser.length),
          antal: priser.length,
        }))
        .sort((a, b) => a.kvartal.localeCompare(b.kvartal));
    }
  }

  // 5. Merge prishistorik fra begge kilder (dedupliker på dato)
  const prisMap = new Map<string, Record<string, unknown>>();
  for (const e of ejerskifter ?? []) {
    const key = e.overtagelsesdato ?? 'ukendt';
    prisMap.set(key, { ...e, kilde: 'ejf' });
  }
  for (const a of adkomster ?? []) {
    const key = a.overtagelsesdato ?? 'ukendt';
    if (!prisMap.has(key)) {
      prisMap.set(key, { ...a, kilde: 'tinglysning' });
    } else {
      // Berig eksisterende med tinglysning-pris hvis mangler
      const existing = prisMap.get(key)!;
      if (!existing.kontant_koebesum && a.kontant_koebesum) {
        existing.kontant_koebesum = a.kontant_koebesum;
      }
      if (!existing.dokument_id && a.dokument_id) {
        existing.dokument_id = a.dokument_id;
      }
    }
  }

  const prishistorik = Array.from(prisMap.values()).sort((a, b) =>
    String(a.overtagelsesdato ?? '').localeCompare(String(b.overtagelsesdato ?? ''))
  );

  return NextResponse.json({
    bfe_nummer: bfe,
    prishistorik,
    ejendom: ejendom ?? null,
    kommuneGennemsnit,
    dataPunkter: prishistorik.length,
    medPris: prishistorik.filter((p) => p.kontant_koebesum || p.i_alt_koebesum).length,
  });
}
