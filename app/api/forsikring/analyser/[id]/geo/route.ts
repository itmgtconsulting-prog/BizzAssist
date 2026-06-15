/**
 * GET /api/forsikring/analyser/[id]/geo
 *
 * Returnerer geokodede markører for alle aktiver i en forsikringsanalyse.
 * Ejendomme resolves via bfe_adresse_cache.dawa_id → DAWA koordinater.
 * Virksomheder resolves via adresse-felt → DAWA fuzzy geocoding.
 *
 * @returns { markers: ForsikringMarker[] }
 *
 * @module api/forsikring/analyser/[id]/geo
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

const DAWA_BASE = 'https://api.dataforsyningen.dk';

/** Markør-type returneret til klienten */
interface ForsikringMarker {
  id: string;
  type: 'ejendom' | 'virksomhed';
  label: string;
  lat: number;
  lng: number;
  bfe: number | null;
  cvr: string | null;
  adresse: string | null;
  isInsured: boolean;
  gapCritical: number;
  gapWarning: number;
}

/** DAWA mini-struktur svar */
interface DawaMini {
  id?: string;
  x?: number;
  y?: number;
  betegnelse?: string;
  adressebetegnelse?: string;
}

/**
 * Geokod en adressetekst via DAWA fuzzy søgning.
 *
 * @param adresse - Adressetekst at geokode
 * @returns { lat, lng } eller null
 */
async function geokodAdresse(adresse: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `${DAWA_BASE}/adresser?q=${encodeURIComponent(adresse)}&struktur=mini&per_side=1&fuzzy`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as DawaMini[];
    const hit = Array.isArray(raw) ? raw[0] : undefined;
    if (hit && typeof hit.x === 'number' && typeof hit.y === 'number') {
      return { lat: hit.y, lng: hit.x };
    }
  } catch {
    /* opslag fejlede */
  }
  return null;
}

/**
 * Geokod via DAWA adresse-UUID.
 *
 * @param dawaId - DAWA adresse-UUID
 * @returns { lat, lng } eller null
 */
async function geokodDawaId(dawaId: string): Promise<{ lat: number; lng: number } | null> {
  for (const endpoint of ['adresser', 'adgangsadresser']) {
    try {
      const res = await fetch(`${DAWA_BASE}/${endpoint}/${dawaId}?struktur=mini`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const raw = (await res.json()) as DawaMini;
      if (typeof raw.x === 'number' && typeof raw.y === 'number') {
        return { lat: raw.y, lng: raw.x };
      }
    } catch {
      /* prøv næste endpoint */
    }
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing analyse id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    // Hent aktiver + gaps parallelt
    const [aktiverResult, gapsResult] = await Promise.all([
      db
        .from('forsikring_aktiver')
        .select('id, type, label, bfe, cvr, adresse, matched_policy_id')
        .eq('analyse_id', id)
        .eq('tenant_id', auth.tenantId)
        .in('type', ['ejendom', 'virksomhed']),
      db
        .from('forsikring_gaps')
        .select('aktiv_id, severity')
        .eq('analyse_id', id)
        .eq('tenant_id', auth.tenantId),
    ]);

    const aktiver = (aktiverResult.data ?? []) as Array<{
      id: string;
      type: 'ejendom' | 'virksomhed';
      label: string;
      bfe: number | null;
      cvr: string | null;
      adresse: string | null;
      matched_policy_id: string | null;
    }>;

    // Aggregér gaps per aktiv
    const gapsByAktiv = new Map<string, { critical: number; warning: number }>();
    for (const g of (gapsResult.data ?? []) as Array<{
      aktiv_id: string;
      severity: string;
    }>) {
      const entry = gapsByAktiv.get(g.aktiv_id) ?? { critical: 0, warning: 0 };
      if (g.severity === 'critical') entry.critical++;
      else if (g.severity === 'warning') entry.warning++;
      gapsByAktiv.set(g.aktiv_id, entry);
    }

    // Hent BFE-numre for ejendomme → slå dawa_id op i bfe_adresse_cache
    const bfeNrs = aktiver.filter((a) => a.type === 'ejendom' && a.bfe).map((a) => a.bfe!);

    const bfeDawaMap = new Map<number, string>();
    if (bfeNrs.length > 0) {
      const { data: cacheRows } = await admin
        .from('bfe_adresse_cache')
        .select('bfe_nummer, dawa_id')
        .in('bfe_nummer', bfeNrs);
      for (const row of (cacheRows ?? []) as Array<{
        bfe_nummer: number;
        dawa_id: string | null;
      }>) {
        if (row.dawa_id) bfeDawaMap.set(row.bfe_nummer, row.dawa_id);
      }
    }

    // Geokod alle aktiver (maks 10 parallelt for at skåne DAWA)
    const markers: ForsikringMarker[] = [];
    for (let i = 0; i < aktiver.length; i += 10) {
      const chunk = aktiver.slice(i, i + 10);
      const resolved = await Promise.all(
        chunk.map(async (aktiv) => {
          let coords: { lat: number; lng: number } | null = null;

          // Prioritet: dawa_id fra cache → adresse-tekst → skip
          if (aktiv.type === 'ejendom' && aktiv.bfe) {
            const dawaId = bfeDawaMap.get(aktiv.bfe);
            if (dawaId) coords = await geokodDawaId(dawaId);
          }
          if (!coords && aktiv.adresse) {
            coords = await geokodAdresse(aktiv.adresse);
          }
          if (!coords) return null;

          const gaps = gapsByAktiv.get(aktiv.id);
          return {
            id: aktiv.id,
            type: aktiv.type,
            label: aktiv.label,
            lat: coords.lat,
            lng: coords.lng,
            bfe: aktiv.bfe,
            cvr: aktiv.cvr,
            adresse: aktiv.adresse,
            isInsured: !!aktiv.matched_policy_id,
            gapCritical: gaps?.critical ?? 0,
            gapWarning: gaps?.warning ?? 0,
          } satisfies ForsikringMarker;
        })
      );
      for (const m of resolved) if (m) markers.push(m);
    }

    return NextResponse.json({ markers });
  } catch (err) {
    logger.error('[forsikring/analyser/geo] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
