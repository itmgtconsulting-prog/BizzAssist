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
import { resolveSfeForAdresse } from '@/app/lib/forsikring/sfeStruktur';

const DAWA_BASE = 'https://api.dataforsyningen.dk';

/** Markør-type returneret til klienten */
/** BIZZ-2145: Bygningsdata fra BBR */
interface BbrData {
  bebygget_areal: number | null;
  antal_etager: number | null;
  opfoerelsesaar: number | null;
  anvendelse: string | null;
}

/** BIZZ-2145: Bygningsdata fra police */
interface PoliceBygning {
  navn: string | null;
  anvendelse: string | null;
  bebygget_areal_m2: number | null;
  antal_etager: number | null;
  opfoert_aar: number | null;
}

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
  /** BIZZ-2145: BBR bygningsdata */
  bbr?: BbrData | null;
  /** BIZZ-2145: Police bygningsdata */
  policeBygninger?: PoliceBygning[] | null;
}

/** DAWA mini-struktur svar */
interface DawaMini {
  id?: string;
  x?: number;
  y?: number;
  betegnelse?: string;
  adressebetegnelse?: string;
}

/** BIZZ-2147: Relevante felter fra cvr_virksomhed.adresse_json */
interface CvrAdresse {
  vejnavn?: string | null;
  husnummerFra?: number | null;
  bogstavFra?: string | null;
  postnummer?: number | null;
  postdistrikt?: string | null;
}

/**
 * BIZZ-2147: Byg en geokodbar adressestreng fra en CVR-virksomheds adresse_json.
 *
 * @param adr - adresse_json fra public.cvr_virksomhed
 * @returns Adressestreng ("Torvegade 5A, 3000 Helsingør") eller null
 */
function byggCvrAdresse(adr: CvrAdresse | null): string | null {
  if (!adr || !adr.vejnavn || adr.husnummerFra == null) return null;
  const husnr = `${adr.husnummerFra}${adr.bogstavFra ?? ''}`;
  const post = adr.postnummer && adr.postdistrikt ? `, ${adr.postnummer} ${adr.postdistrikt}` : '';
  return `${adr.vejnavn} ${husnr}${post}`;
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

/**
 * Geokod via BFE → DAWA jordstykker visueltcenter.
 * Fallback for ubebyggede grunde (markjorder) uden adgangsadresse.
 *
 * @param bfe - BFE-nummer
 * @returns { lat, lng } eller null
 */
async function geokodViaBfe(bfe: number): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(`${DAWA_BASE}/jordstykker?bfenummer=${bfe}&format=geojson`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const geojson = (await res.json()) as {
      features?: Array<{
        properties?: { visueltcenter_x?: number; visueltcenter_y?: number };
      }>;
    };
    const props = geojson.features?.[0]?.properties;
    if (typeof props?.visueltcenter_x === 'number' && typeof props?.visueltcenter_y === 'number') {
      return { lat: props.visueltcenter_y, lng: props.visueltcenter_x };
    }
  } catch {
    /* opslag fejlede */
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

    // BIZZ-2145: Hent BBR-data for alle BFE'er
    const bbrMap = new Map<number, BbrData>();
    if (bfeNrs.length > 0) {
      const { data: bbrRows } = await admin
        .from('bbr_ejendom_status')
        .select('bfe_nummer, bebygget_areal, antal_etager, opfoerelsesaar, byg021_anvendelse')
        .in('bfe_nummer', bfeNrs);
      for (const row of (bbrRows ?? []) as Array<{
        bfe_nummer: number;
        bebygget_areal: number | null;
        antal_etager: number | null;
        opfoerelsesaar: number | null;
        byg021_anvendelse: string | null;
      }>) {
        bbrMap.set(row.bfe_nummer, {
          bebygget_areal: row.bebygget_areal,
          antal_etager: row.antal_etager,
          opfoerelsesaar: row.opfoerelsesaar,
          anvendelse: row.byg021_anvendelse,
        });
      }
    }

    // BIZZ-2145: Hent police-bygningsdata via matched_policy_id → raw_metadata.bygninger
    const policeBygningerMap = new Map<string, PoliceBygning[]>();
    const matchedPolicyIds = aktiver
      .filter((a) => a.matched_policy_id)
      .map((a) => a.matched_policy_id!);
    if (matchedPolicyIds.length > 0) {
      const { data: policyRows } = await db
        .from('forsikring_policies')
        .select('id, raw_metadata')
        .in('id', [...new Set(matchedPolicyIds)])
        .eq('tenant_id', auth.tenantId);
      for (const row of (policyRows ?? []) as Array<{
        id: string;
        raw_metadata: { bygninger?: PoliceBygning[] } | null;
      }>) {
        if (row.raw_metadata?.bygninger) {
          policeBygningerMap.set(row.id, row.raw_metadata.bygninger);
        }
      }
    }

    // BIZZ-2147: Virksomheds-aktiver har ofte adresse=null (kun CVR kendt), så de
    // aldrig blev geokodet og derfor ikke vist på kortet. Slå adressen op via
    // public.cvr_virksomhed.adresse_json så de kan placeres.
    const virkCvrs = aktiver
      .filter((a) => a.type === 'virksomhed' && a.cvr && !a.adresse)
      .map((a) => a.cvr!);
    const cvrAdresseMap = new Map<string, string>();
    if (virkCvrs.length > 0) {
      const { data: cvrRows } = await admin
        .from('cvr_virksomhed')
        .select('cvr, adresse_json')
        .in('cvr', [...new Set(virkCvrs)]);
      for (const row of (cvrRows ?? []) as Array<{
        cvr: string;
        adresse_json: CvrAdresse | null;
      }>) {
        const adr = byggCvrAdresse(row.adresse_json);
        if (adr) cvrAdresseMap.set(row.cvr, adr);
      }
    }

    // BIZZ-2161: Memoisér jordstykke-centroide pr. BFE inden for requestet —
    // mange ejerlejligheder deler samme SFE-BFE og skal ikke slå det op hver.
    const bfeCentroidCache = new Map<number, { lat: number; lng: number } | null>();
    const centroidForBfe = async (bfe: number): Promise<{ lat: number; lng: number } | null> => {
      const cached = bfeCentroidCache.get(bfe);
      if (cached !== undefined) return cached;
      const coords = await geokodViaBfe(bfe);
      bfeCentroidCache.set(bfe, coords);
      return coords;
    };

    // Geokod alle aktiver (maks 10 parallelt for at skåne DAWA)
    const markers: ForsikringMarker[] = [];
    for (let i = 0; i < aktiver.length; i += 10) {
      const chunk = aktiver.slice(i, i + 10);
      const resolved = await Promise.all(
        chunk.map(async (aktiv) => {
          let coords: { lat: number; lng: number } | null = null;

          // BIZZ-2161: Prioritér matrikel-centroide (jordstykke visueltcenter)
          // over DAWA-adgangspunktet. Adgangspunktet ligger ved fortovskant/
          // indgang — i tætbebyggede bymidter 10-30 m fra matriklen, så pins
          // landede på nabomatriklen eller ude på gaden. visueltcenter ligger
          // altid inde i matriklen.
          if (aktiv.type === 'ejendom') {
            // 1) Eget jordstykke (SFE/bygning med egen matrikel)
            if (aktiv.bfe) coords = await centroidForBfe(aktiv.bfe);
            // 2) Ejerlejlighed uden eget jordstykke → resolve SFE-BFE og brug
            //    DEN samlede faste ejendoms matrikel-centroide
            if (!coords && aktiv.adresse) {
              const sfe = await resolveSfeForAdresse(aktiv.adresse);
              if (sfe?.sfeBfe) coords = await centroidForBfe(sfe.sfeBfe);
            }
            // 3) Adgangspunkt (fortovskant) som sidste struktur-fallback
            if (!coords && aktiv.bfe) {
              const dawaId = bfeDawaMap.get(aktiv.bfe);
              if (dawaId) coords = await geokodDawaId(dawaId);
            }
          }
          if (!coords && aktiv.adresse) {
            coords = await geokodAdresse(aktiv.adresse);
          }
          // BIZZ-2147: Virksomhed uden adresse → geokod via CVR-opslået adresse
          let visAdresse = aktiv.adresse;
          if (!coords && aktiv.type === 'virksomhed' && aktiv.cvr) {
            const cvrAdr = cvrAdresseMap.get(aktiv.cvr);
            if (cvrAdr) {
              coords = await geokodAdresse(cvrAdr);
              if (!visAdresse) visAdresse = cvrAdr;
            }
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
            adresse: visAdresse,
            isInsured: !!aktiv.matched_policy_id,
            gapCritical: gaps?.critical ?? 0,
            gapWarning: gaps?.warning ?? 0,
            bbr: aktiv.bfe ? (bbrMap.get(aktiv.bfe) ?? null) : null,
            policeBygninger: aktiv.matched_policy_id
              ? (policeBygningerMap.get(aktiv.matched_policy_id) ?? null)
              : null,
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
