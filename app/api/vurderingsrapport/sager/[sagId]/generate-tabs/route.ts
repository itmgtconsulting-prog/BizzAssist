/**
 * POST /api/vurderingsrapport/sager/[sagId]/generate-tabs
 *
 * BIZZ-1642 + BIZZ-1737: Generer alle 8 rapport-tabs fra BizzAssist data.
 *
 * Data hentes via collectEjendomData helper der orkestrerer parallelle
 * opslag mod BBR, VUR, EJF, Tinglysning S2S, og DAWA. Alle kilder er
 * non-fatal — partial data er bedre end ingen data.
 *
 * Tabs:
 *   1. identifikation — adresse, BFE, matrikel, zone, ejerforhold
 *   2. bygningsdata — BBR konstruktion, arealer, materialer
 *   3. energi — energimaerke, opvarmning, vandforsyning
 *   4. vurdering_skat — ejendomsvaerdi, grundvaerdi, grundskyld
 *   5. tinglysning — ejere, salgshistorik, haeftelser
 *   6. servitutter — tinglysning S2S servitutter
 *   7. beliggenhed — adresse, kommune, region, zone, koordinater
 *   8. risiko — uploads (lejeindtaegter, driftsudgifter, referencer)
 *
 * @module api/vurderingsrapport/sager/[sagId]/generate-tabs
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { collectEjendomData } from '@/app/lib/vurdering/collectEjendomData';
import { logger } from '@/app/lib/logger';

export const maxDuration = 45;

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

    // Hent sag + parsed uploads parallelt
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

    // ── BIZZ-1737: Hent komplet ejendomsdata fra alle BizzAssist-kilder ────
    const bfe = sag.ejendom_bfe as number | null;
    const dawaId = sag.ejendom_dawa_id as string | null;

    const ejendomData = bfe ? await collectEjendomData(bfe, dawaId) : null;

    // Saml parsed upload-data per zone
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

    // ── Byg 8 rapport-tabs med rig data ────────────────────────────────────

    const bbr = ejendomData?.bbr;
    const vur = ejendomData?.vurdering;
    const bel = ejendomData?.beliggenhed;

    const tabs: Record<string, unknown> = {
      identifikation: {
        adresse: bel?.adresse ?? sag.ejendom_adresse,
        bfe: sag.ejendom_bfe,
        matrikelnr: bel?.matrikelnr ?? null,
        ejerlavsnavn: bel?.ejerlavsnavn ?? null,
        ejerlavskode: bel?.ejerlavskode ?? null,
        kommune: bel?.kommunenavn ?? null,
        region: bel?.regionsnavn ?? null,
        postnr: bel?.postnr ?? null,
        postnrnavn: bel?.postnrnavn ?? null,
        zone: bel?.zone ?? null,
        ejerforholdskode: bbr?.ejerforholdskode ?? null,
        bygningsanvendelse: bbr?.bygningsanvendelse ?? null,
        benyttelseskode: vur?.benyttelseskode ?? null,
        juridiskKategori: vur?.juridiskKategori ?? null,
      },

      bygningsdata: {
        opfoerelsesaar: bbr?.opfoerelsesaar ?? null,
        omTilbygningsaar: bbr?.omTilbygningsaar ?? null,
        bebyggetAreal: bbr?.bebyggetAreal ?? null,
        samletBygningsareal: bbr?.samletBygningsareal ?? null,
        samletBoligareal: bbr?.samletBoligareal ?? null,
        samletErhvervsareal: bbr?.samletErhvervsareal ?? null,
        grundareal: bbr?.grundareal ?? bel?.grundareal ?? null,
        antalEtager: bbr?.antalEtager ?? null,
        tagdaekningsmateriale: bbr?.tagdaekningsmateriale ?? null,
        ydervaegMateriale: bbr?.ydervaegMateriale ?? null,
        fredning: bbr?.fredning ?? null,
        bevaringsvaerdighed: bbr?.bevaringsvaerdighed ?? null,
        asbestholdigtMateriale: bbr?.asbestholdigtMateriale ?? null,
        bebyggelsesprocent: vur?.bebyggelsesprocent ?? null,
      },

      energi: {
        energimaerke: bbr?.energimaerke ?? null,
        energimaerkeDato: bbr?.energimaerkeDato ?? null,
        opvarmning: bbr?.opvarmning ?? null,
        opvarmningsmiddel: bbr?.opvarmningsmiddel ?? null,
        supplerendeVarme: bbr?.supplerendeVarme ?? null,
        vandforsyning: bbr?.vandforsyning ?? null,
        afloebsforhold: bbr?.afloebsforhold ?? null,
      },

      vurdering_skat: {
        ejendomsvaerdi: vur?.ejendomsvaerdi ?? null,
        grundvaerdi: vur?.grundvaerdi ?? null,
        afgiftspligtigEjendomsvaerdi: vur?.afgiftspligtigEjendomsvaerdi ?? null,
        afgiftspligtigGrundvaerdi: vur?.afgiftspligtigGrundvaerdi ?? null,
        estimeretGrundskyld: vur?.estimeretGrundskyld ?? null,
        grundskyldspromille: vur?.grundskyldspromille ?? null,
        vurderingsaar: vur?.vurderingsaar ?? null,
        vurderetAreal: vur?.vurderetAreal ?? null,
      },

      tinglysning: {
        ejere: (ejendomData?.ejere ?? []).map((e) => ({
          navn: e.navn,
          cvr: e.cvr,
          type: e.type,
          andel: e.andelProcent,
          virkningFra: e.virkningFra,
        })),
        salgshistorik: (ejendomData?.salgshistorik ?? []).map((s) => ({
          dato: s.overtagelsesdato,
          koebsaftaleDato: s.koebsaftaleDato,
          ejer: s.ejerNavn,
          cvr: s.ejerCvr,
          kontantPris: s.kontantKoebesum,
          samletPris: s.samletKoebesum,
          overdragelsesmaade: s.overdragelsesmaadeLabel ?? s.overdragelsesmaade,
          betinget: s.betinget,
        })),
        haeftelser: (ejendomData?.haeftelser ?? []).map((h) => ({
          dato: h.dato,
          type: h.type,
          hovedstolDkk: h.hovedstolDkk,
          restgaeldDkk: h.restgaeldDkk,
          kreditor: h.kreditor,
          rente: h.rente,
        })),
      },

      servitutter: {
        servitutter: (ejendomData?.servitutter ?? []).map((s) => ({
          dato: s.dato,
          type: s.type,
          aktNummer: s.aktNummer,
          beskrivelse: s.beskrivelse,
        })),
        noter: fritekstByZone.oevrige ?? null,
      },

      beliggenhed: {
        adresse: bel?.adresse ?? sag.ejendom_adresse,
        kommune: bel?.kommunenavn ?? null,
        region: bel?.regionsnavn ?? null,
        postnr: bel?.postnr ?? null,
        postnrnavn: bel?.postnrnavn ?? null,
        zone: bel?.zone ?? null,
        koordinater: bel?.koordinater ?? null,
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

    // Rapporter datakomplethed
    const dataSources = {
      bbr: !!ejendomData?.bbr,
      vurdering: !!ejendomData?.vurdering,
      ejere: (ejendomData?.ejere?.length ?? 0) > 0,
      salgshistorik: (ejendomData?.salgshistorik?.length ?? 0) > 0,
      servitutter: (ejendomData?.servitutter?.length ?? 0) > 0,
      haeftelser: (ejendomData?.haeftelser?.length ?? 0) > 0,
      beliggenhed: !!ejendomData?.beliggenhed,
    };

    return NextResponse.json({
      ok: true,
      tabs_generated: Object.keys(tabs).length,
      data_sources: dataSources,
    });
  } catch (err) {
    logger.error('[vurdering/generate-tabs]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
