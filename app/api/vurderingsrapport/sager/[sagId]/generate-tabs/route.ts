/**
 * POST /api/vurderingsrapport/sager/[sagId]/generate-tabs
 *
 * BIZZ-1642: Generer alle 8 rapport-tabs automatisk fra:
 * 1. BizzAssist data (BBR, vurdering, ejerskab, tinglysning, salgshistorik)
 * 2. Parsed upload-data fra vurdering_dokumenter
 * 3. Fritekst-noter fra upload-zoner
 *
 * @module api/vurderingsrapport/sager/[sagId]/generate-tabs
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

export const maxDuration = 30;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ sagId: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sagId } = await params;

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Hent sag + parsed uploads
    const [sagResult, docsResult, zonerResult] = await Promise.all([
      db
        .from('vurdering_sager')
        .select('*')
        .eq('id', sagId)
        .eq('tenant_id', auth.tenantId)
        .maybeSingle(),
      db.from('vurdering_dokumenter').select('*').eq('sag_id', sagId).eq('parse_status', 'parsed'),
      db.from('vurdering_upload_zoner').select('*').eq('sag_id', sagId),
    ]);

    const sag = sagResult.data;
    if (!sag) return NextResponse.json({ error: 'Sag ikke fundet' }, { status: 404 });

    const docs = (docsResult.data ?? []) as Array<Record<string, unknown>>;
    const zoner = (zonerResult.data ?? []) as Array<Record<string, unknown>>;

    // Hent BizzAssist-data for ejendommen
    let bbrData: Record<string, unknown> | null = null;
    let vurderingData: Record<string, unknown> | null = null;
    let ejerskabData: Array<Record<string, unknown>> = [];
    let salgshistorikData: Array<Record<string, unknown>> = [];

    if (sag.ejendom_dawa_id) {
      // BBR
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: bbr } = await (admin as any)
          .from('bbr_ejendom_status')
          .select('*')
          .eq('adgangsadresse_id', sag.ejendom_dawa_id)
          .maybeSingle();
        if (bbr) bbrData = bbr;
      } catch {
        /* non-fatal */
      }
    }

    if (sag.ejendom_bfe) {
      // Vurdering
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: vur } = await (admin as any)
          .from('vurdering_cache')
          .select('*')
          .eq('bfe_nummer', sag.ejendom_bfe)
          .maybeSingle();
        if (vur) vurderingData = vur;
      } catch {
        /* non-fatal */
      }

      // Ejerskab
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: ejf } = await (admin as any)
          .from('ejf_ejerskab')
          .select(
            'ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, virkning_fra'
          )
          .eq('bfe_nummer', sag.ejendom_bfe)
          .eq('status', 'gældende')
          .limit(10);
        if (ejf) ejerskabData = ejf;
      } catch {
        /* non-fatal */
      }

      // Salgshistorik
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: salg } = await (admin as any)
          .from('ejerskifte_historik')
          .select('overtagelsesdato, ejer_navn, kontant_koebesum, i_alt_koebesum')
          .eq('bfe_nummer', sag.ejendom_bfe)
          .order('overtagelsesdato', { ascending: false })
          .limit(10);
        if (salg) salgshistorikData = salg;
      } catch {
        /* non-fatal */
      }
    }

    // Saml parsed data per zone
    const parsedByZone: Record<string, unknown[]> = {};
    for (const d of docs) {
      const zone = zoner.find((z) => z.id === d.zone_id);
      const zt = (zone?.zone_type as string) ?? 'oevrige';
      if (!parsedByZone[zt]) parsedByZone[zt] = [];
      if (d.parsed_data) parsedByZone[zt].push(d.parsed_data);
    }

    const fritekstByZone: Record<string, string> = {};
    for (const z of zoner) {
      if (z.fritekst) fritekstByZone[z.zone_type as string] = z.fritekst as string;
    }

    // Generer tab-indhold (data-mapping, ikke AI)
    const tabs: Record<string, unknown> = {
      identifikation: {
        adresse: sag.ejendom_adresse,
        bfe: sag.ejendom_bfe,
        kommune: bbrData?.kommune_kode ?? null,
        matrikel: null,
        zone: bbrData?.zone ?? null,
        ejerforholdskode: bbrData?.ejerforholdskode ?? null,
      },
      bygningsdata: {
        opfoerelsesaar: bbrData?.opfoerelsesaar ?? null,
        bebygget_areal: bbrData?.bebygget_areal ?? null,
        samlet_boligareal: bbrData?.samlet_boligareal ?? null,
        samlet_erhvervsareal: bbrData?.samlet_erhvervsareal ?? null,
        grundareal: bbrData?.grundareal ?? null,
        antal_etager: bbrData?.antal_etager ?? null,
        tagmateriale: bbrData?.tagmateriale ?? null,
        ydervaeg: bbrData?.ydervaeg_materiale ?? null,
        opvarmning: bbrData?.opvarmningsform ?? null,
      },
      energi: {
        energimaerke: bbrData?.energimaerke ?? null,
        energimaerke_dato: bbrData?.energimaerke_dato ?? null,
      },
      vurdering_skat: {
        ejendomsvaerdi: vurderingData?.ejendomsvaerdi ?? null,
        grundvaerdi: vurderingData?.grundvaerdi ?? null,
        vurderingsaar: vurderingData?.vurderingsaar ?? null,
      },
      tinglysning: {
        ejere: ejerskabData.map((e) => ({
          navn: e.ejer_navn,
          cvr: e.ejer_cvr,
          type: e.ejer_type,
          andel:
            e.ejerandel_taeller && e.ejerandel_naevner
              ? `${Math.round(((e.ejerandel_taeller as number) / (e.ejerandel_naevner as number)) * 100)}%`
              : null,
        })),
        salgshistorik: salgshistorikData.map((s) => ({
          dato: s.overtagelsesdato,
          ejer: s.ejer_navn,
          pris: s.kontant_koebesum ?? s.i_alt_koebesum,
        })),
      },
      servitutter: {
        noter: fritekstByZone.oevrige ?? null,
      },
      beliggenhed: {
        adresse: sag.ejendom_adresse,
        noter: fritekstByZone.besigtigelse ?? null,
        besigtigelse: parsedByZone.besigtigelse ?? [],
      },
      risiko: {
        lejeindtaegter: parsedByZone.lejeindtaegter ?? [],
        driftsudgifter: parsedByZone.driftsudgifter ?? [],
        referencer: parsedByZone.referenceejendomme ?? [],
      },
    };

    // Upsert alle tabs
    for (const [tabKey, indhold] of Object.entries(tabs)) {
      await db.from('vurdering_rapport_tabs').upsert(
        {
          sag_id: sagId,
          tenant_id: auth.tenantId,
          tab_key: tabKey,
          indhold,
          ai_genereret: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'sag_id,tab_key' }
      );
    }

    // Opdater sag-status
    await db
      .from('vurdering_sager')
      .update({
        status: 'rapport_genereret',
        updated_at: new Date().toISOString(),
      })
      .eq('id', sagId);

    return NextResponse.json({ ok: true, tabs_generated: Object.keys(tabs).length });
  } catch (err) {
    logger.error('[vurdering/generate-tabs]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
