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
}

export default async function EjendommeDetailPage({
  params,
  searchParams,
}: EjendommeDetailPageProps) {
  const { id } = await params;

  let prefetched: PrefetchedPropertyData | undefined;

  // BIZZ-1505: BFE-nummer → resolve til DAWA UUID via lokal DB og redirect
  if (!erDawaId(id) && /^\d+$/.test(id)) {
    let resolved = false;

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
          const { redirect } = await import('next/navigation');
          redirect(`/dashboard/ejendomme/${bbrRow.adgangsadresse_id}`);
          resolved = true; // redirect throws, but guard anyway
        }
      }
    } catch {
      // bbr_ejendom_status har ikke denne BFE — prøv DAWA fallback
    }

    // Strategi 2: DAWA /bfe/{bfe} — fanger SFE-BFE'er der ikke er i bbr_ejendom_status
    if (!resolved) {
      try {
        const { fetchDawa } = await import('@/app/lib/dawa');
        const bfeRes = await fetchDawa(
          `https://dawa.aws.dk/bfe/${id}`,
          { signal: AbortSignal.timeout(5000) },
          { caller: 'ejendom-page.bfe-resolve' }
        );
        if (bfeRes.ok) {
          const bfeData = (await bfeRes.json()) as {
            beliggenhedsadresse?: { id?: string };
          };
          const dawaId = bfeData?.beliggenhedsadresse?.id;
          if (dawaId) {
            const { redirect } = await import('next/navigation');
            redirect(`/dashboard/ejendomme/${dawaId}`);
          }
        }
      } catch {
        // Fallback: render med BFE som ID (klienten viser fejl-tilstand)
      }
    }
  }

  if (erDawaId(id)) {
    try {
      // Step 1: Fetch DAWA address server-side
      const adresse = await darHentAdresse(id);

      if (adresse) {
        // Step 2: Fetch BBR data server-side (uses DAWA UUID)
        const bbrResult = await fetchBbrForAddress(id);
        const bbrData: EjendomApiResponse = { dawaId: id, ...bbrResult };

        // BIZZ-1287+1323+1327: Prefetch vurdering + ejerskab parallelt fra cache
        let vurderingData: VurderingResponse | null = null;
        let ejerskabData: PrefetchedEjerskab | null = null;
        const bfeNummer = bbrResult.ejendomsrelationer?.[0]?.bfeNummer;

        if (bfeNummer) {
          const { createAdminClient } = await import('@/lib/supabase/admin');
          const admin = createAdminClient();

          // Kør begge cache-lookups parallelt
          const [vurResult, ejfResult] = await Promise.allSettled([
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
          ]);

          if (vurResult.status === 'fulfilled') vurderingData = vurResult.value;
          if (ejfResult.status === 'fulfilled') ejerskabData = ejfResult.value;
        }

        prefetched = { dawaAdresse: adresse, bbrData, vurderingData, ejerskabData };
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
