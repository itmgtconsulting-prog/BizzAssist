/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 *
 * Prefetches DAWA address + BBR data server-side so the client component
 * can render immediately without waiting for sequential client-side fetches.
 * This eliminates the DAWA→BBR waterfall and lets ejerskab/tinglysning
 * start loading sooner (as soon as BFE is available).
 */
import { erDawaId } from '@/app/lib/dawa';
import { darHentAdresse } from '@/app/lib/dar';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import type { DawaAdresse } from '@/app/lib/dawa';
import type { EjendomApiResponse } from '@/app/lib/fetchBbrData';
import type { VurderingResponse } from '@/app/api/vurdering/route';
import type { HandelData } from '@/app/api/salgshistorik/route';
import EjendomDetaljeClient from './EjendomDetaljeClient';
import { logger } from '@/app/lib/logger';

export const dynamic = 'force-dynamic';

/** Next.js App Router page props for dynamic route /dashboard/ejendomme/[id] */
interface EjendommeDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
}

/** Ejerskabsdata prefetched fra ejf_ejerskab cache */
export interface PrefetchedEjerskab {
  ejere: Array<{
    ejer_navn: string;
    ejer_type: string;
    ejerandel_taeller: number | null;
    ejerandel_naevner: number | null;
    status: string;
  }>;
}

/** Prefetched data passed to client component — all fields optional (graceful fallback) */
export interface PrefetchedPropertyData {
  dawaAdresse: DawaAdresse | null;
  bbrData: EjendomApiResponse | null;
  /** BIZZ-1287: Server-side prefetched vurdering fra cache — eliminerer klient-side waterfall */
  vurderingData?: VurderingResponse | null;
  /** BIZZ-1323: Server-side prefetched ejerskab fra ejf_ejerskab — sparer 300-800ms */
  ejerskabData?: PrefetchedEjerskab | null;
  /** BIZZ-1630: Server-side prefetched salgshistorik fra ejerskifte_historik — sparer 300-1500ms */
  salgshistorikData?: HandelData[] | null;
}

export default async function EjendommeDetailPage({
  params,
  searchParams,
}: EjendommeDetailPageProps) {
  const { id } = await params;

  let prefetched: PrefetchedPropertyData | undefined;

  // BIZZ-1505: BFE-nummer → resolve til DAWA UUID via lokal DB eller DAWA, derefter redirect.
  // VIGTIGT: redirect() kaster en NEXT_REDIRECT-fejl der SKAL bobble op til Next.js —
  // derfor må vi aldrig kalde redirect() inde i en try/catch der sluger alle fejl.
  if (!erDawaId(id) && /^\d+$/.test(id)) {
    let resolvedDawaId: string | null = null;

    // Strategi 1: Opslag i bbr_ejendom_status (hurtigst — lokal DB)
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      if (supabaseUrl && serviceKey) {
        const admin = createClient(supabaseUrl, serviceKey);
        const { data: bbrRow } = await admin
          .from('bbr_ejendom_status')
          .select('adgangsadresse_id')
          .eq('bfe_nummer', Number(id))
          .not('adgangsadresse_id', 'is', null)
          .limit(1)
          .single();
        if (bbrRow?.adgangsadresse_id) {
          resolvedDawaId = bbrRow.adgangsadresse_id as string;
        }
      }
    } catch {
      // bbr_ejendom_status har ikke denne BFE — prøv DAWA fallback
    }

    // Strategi 2: DAWA jordstykker→adgangsadresser — fanger SFE-BFE'er der
    // ikke er i bbr_ejendom_status. DAWA /bfe/{bfe} er fjernet, så vi går
    // via /jordstykker?bfenummer=X → /adgangsadresser?ejerlavkode=Y&matrikelnr=Z
    if (!resolvedDawaId) {
      try {
        const { fetchDawa } = await import('@/app/lib/dawa');
        const jordRes = await fetchDawa(
          `https://dawa.aws.dk/jordstykker?bfenummer=${id}&struktur=mini`,
          { signal: AbortSignal.timeout(5000) },
          { caller: 'ejendom-page.bfe-resolve-jordstykke' }
        );
        if (jordRes.ok) {
          const jordstykker = (await jordRes.json()) as Array<{
            ejerlavkode?: number;
            matrikelnr?: string;
          }>;
          const js = jordstykker[0];
          if (js?.ejerlavkode && js?.matrikelnr) {
            const adrRes = await fetchDawa(
              `https://dawa.aws.dk/adgangsadresser?ejerlavkode=${js.ejerlavkode}&matrikelnr=${encodeURIComponent(js.matrikelnr)}&struktur=mini&per_side=1`,
              { signal: AbortSignal.timeout(5000) },
              { caller: 'ejendom-page.bfe-resolve-adgangsadresse' }
            );
            if (adrRes.ok) {
              const adresser = (await adrRes.json()) as Array<{ id: string }>;
              if (adresser[0]?.id) {
                resolvedDawaId = adresser[0].id;
              }
            }
          }
        }
      } catch {
        // Fallback: prøv Vurderingsportalen for ejerlejligheder
      }
    }

    // Strategi 3: Vurderingsportalen — ejerlejligheder har ingen egen jordstykke,
    // så vi slår BFE op i VP for at få vejnavn + husnr + postnr, hvorefter vi
    // resolver building's adgangsadresse via DAWA.
    if (!resolvedDawaId) {
      try {
        const vpRes = await fetch(
          'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            },
            body: JSON.stringify({
              query: { term: { bfeNumbers: parseInt(id, 10) } },
              size: 1,
              _source: ['roadName', 'houseNumber', 'zipcode', 'municipalityNumber'],
            }),
            signal: AbortSignal.timeout(5000),
          }
        );
        if (vpRes.ok) {
          const vpData = (await vpRes.json()) as {
            hits?: {
              hits?: Array<{
                _source?: {
                  roadName?: string;
                  houseNumber?: string;
                  zipcode?: string;
                  municipalityNumber?: string;
                };
              }>;
            };
          };
          const src = vpData.hits?.hits?.[0]?._source;
          if (src?.roadName && src?.houseNumber && src?.zipcode) {
            const { fetchDawa } = await import('@/app/lib/dawa');
            const adrRes = await fetchDawa(
              `https://dawa.aws.dk/adgangsadresser?vejnavn=${encodeURIComponent(src.roadName)}&husnr=${encodeURIComponent(src.houseNumber)}&postnr=${encodeURIComponent(src.zipcode)}&struktur=mini&per_side=1`,
              { signal: AbortSignal.timeout(5000) },
              { caller: 'ejendom-page.bfe-resolve-vp-adresse' }
            );
            if (adrRes.ok) {
              const adresser = (await adrRes.json()) as Array<{ id: string }>;
              if (adresser[0]?.id) {
                resolvedDawaId = adresser[0].id;
              }
            }
          }
        }
      } catch {
        // Fallback: render med BFE som ID (klienten viser fejl-tilstand)
      }
    }

    // Redirect skal stå UDENFOR try/catch så NEXT_REDIRECT-fejlen bobler op.
    if (resolvedDawaId) {
      const { redirect } = await import('next/navigation');
      redirect(`/dashboard/ejendomme/${resolvedDawaId}`);
    }
  }

  if (erDawaId(id)) {
    try {
      // Step 1: Fetch DAWA address server-side
      const adresse = await darHentAdresse(id);

      if (adresse) {
        // Step 2: Fetch BBR data server-side (uses DAWA UUID)
        // BIZZ-1627: Race BBR live fetch vs timeout — fallback til bbr_ejendom_status
        // cache når Datafordeler er langsom/nede. Giver <50ms response i stedet for 1-3s.
        let bbrResult: Omit<EjendomApiResponse, 'dawaId'>;
        let bbrFromCache = false;
        try {
          bbrResult = await Promise.race([
            fetchBbrForAddress(id),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('BBR_TIMEOUT')), 4000)
            ),
          ]);
        } catch {
          // Live BBR fejlede/timeouted — prøv cache fallback fra bbr_ejendom_status
          bbrResult = {
            bbr: null,
            enheder: null,
            bygningPunkter: null,
            ejendomsrelationer: null,
            ejerlejlighedBfe: null,
            moderBfe: null,
            parentAdgangsadresseId: null,
            opgange: null,
            etager: null,
            tekniskeAnlaeg: null,
            bbrFejl:
              'BBR-data midlertidigt utilgængeligt — Datafordeler API svarer ikke. Prøv igen om lidt.',
          };
          try {
            const { createAdminClient } = await import('@/lib/supabase/admin');
            const admin = createAdminClient();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: cached } = await (admin as any)
              .from('bbr_ejendom_status')
              .select(
                'bfe_nummer, kommune_kode, samlet_boligareal, samlet_erhvervsareal, grundareal, bebygget_areal, opfoerelsesaar, byg021_anvendelse, energimaerke, antal_etager, antal_boligenheder, bygninger, enheder, ejerforholdskode, bbr_fetched_at'
              )
              .eq('adgangsadresse_id', id)
              .eq('is_udfaset', false)
              .maybeSingle();
            if (cached?.bfe_nummer) {
              bbrResult.ejendomsrelationer = [
                {
                  bfeNummer: Number(cached.bfe_nummer),
                  ejendomsnummer: null,
                  ejendomstype: null,
                  ejerlavKode: null,
                  matrikelnr: null,
                },
              ];
              bbrResult.bbrFejl = `Viser cached BBR-data fra ${new Date(cached.bbr_fetched_at).toLocaleDateString('da-DK')}. Live data utilgængelig.`;
              bbrFromCache = true;
            }
          } catch {
            // Cache lookup fejlede — beholder den tomme bbrResult med fejlbesked
          }
        }
        const bbrData: EjendomApiResponse = { dawaId: id, ...bbrResult };
        // Marker cached BBR for klienten
        if (bbrFromCache) (bbrData as unknown as Record<string, unknown>)['_bbrCached'] = true;

        // BIZZ-1287+1323+1327: Prefetch vurdering + ejerskab parallelt fra cache
        let vurderingData: VurderingResponse | null = null;
        let ejerskabData: PrefetchedEjerskab | null = null;
        let salgshistorikData: HandelData[] | null = null;
        const bfeNummer = bbrResult.ejendomsrelationer?.[0]?.bfeNummer;

        if (bfeNummer) {
          const { createAdminClient } = await import('@/lib/supabase/admin');
          const admin = createAdminClient();

          // Kør alle cache-lookups parallelt
          const [vurResult, ejfResult, shResult] = await Promise.allSettled([
            // Vurdering fra cache
            (async () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: cached } = (await (admin as any)
                .from('vurdering_cache')
                .select(
                  'vurderinger, grundvaerdispec, fordeling, loft, fritagelser, fradrag, stale_after'
                )
                .eq('bfe_nummer', bfeNummer)
                .maybeSingle()) as { data: Record<string, unknown> | null };

              if (
                cached?.vurderinger &&
                cached.stale_after &&
                new Date(String(cached.stale_after)) > new Date()
              ) {
                const vurderinger = cached.vurderinger as VurderingResponse['alle'];
                return {
                  vurdering: vurderinger.length > 0 ? vurderinger[0] : null,
                  alle: vurderinger,
                  fordeling: (cached.fordeling ?? []) as VurderingResponse['fordeling'],
                  grundvaerdispec: (cached.grundvaerdispec ??
                    []) as VurderingResponse['grundvaerdispec'],
                  loft: (cached.loft ?? []) as VurderingResponse['loft'],
                  fritagelser: (cached.fritagelser ?? []) as VurderingResponse['fritagelser'],
                  fradrag: (cached.fradrag as VurderingResponse['fradrag']) ?? null,
                  fejl: null,
                  manglerNoegle: false,
                } as VurderingResponse;
              }
              return null;
            })(),
            // BIZZ-1323: Ejerskab fra ejf_ejerskab
            (async () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: ejere } = await (admin as any)
                .from('ejf_ejerskab')
                .select('ejer_navn, ejer_type, ejerandel_taeller, ejerandel_naevner, status')
                .eq('bfe_nummer', bfeNummer)
                .eq('status', 'gældende')
                .limit(10);
              if (ejere && (ejere as unknown[]).length > 0) {
                return { ejere: ejere as PrefetchedEjerskab['ejere'] };
              }
              return null;
            })(),
            // BIZZ-1630: Salgshistorik fra ejerskifte_historik (537k rækker)
            (async () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: handler } = await (admin as any)
                .from('ejerskifte_historik')
                .select(
                  'overtagelsesdato, ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, kontant_koebesum, i_alt_koebesum, koebsaftale_dato, dokument_id, historisk_kilde'
                )
                .eq('bfe_nummer', bfeNummer)
                .order('overtagelsesdato', { ascending: false })
                .limit(20);
              if (handler && (handler as unknown[]).length > 0) {
                return handler as HandelData[];
              }
              return null;
            })(),
          ]);

          if (vurResult.status === 'fulfilled') vurderingData = vurResult.value;
          if (ejfResult.status === 'fulfilled') ejerskabData = ejfResult.value;
          if (shResult.status === 'fulfilled') salgshistorikData = shResult.value;
        }

        prefetched = {
          dawaAdresse: adresse,
          bbrData,
          vurderingData,
          ejerskabData,
          salgshistorikData,
        };
      } else {
        prefetched = { dawaAdresse: null, bbrData: null };
      }
    } catch (err) {
      // Server-side prefetch failed — client will retry
      logger.error('[ejendom/page] Server prefetch fejl:', err);
      prefetched = undefined;
    }
  }

  return (
    <EjendomDetaljeClient
      params={Promise.resolve({ id })}
      searchParams={searchParams}
      prefetched={prefetched}
    />
  );
}
