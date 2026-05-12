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

/** Prefetched data passed to client component — all fields optional (graceful fallback) */
export interface PrefetchedPropertyData {
  dawaAdresse: DawaAdresse | null;
  bbrData: EjendomApiResponse | null;
  /** BIZZ-1287: Server-side prefetched vurdering fra cache — eliminerer klient-side waterfall */
  vurderingData?: VurderingResponse | null;
}

export default async function EjendommeDetailPage({
  params,
  searchParams,
}: EjendommeDetailPageProps) {
  const { id } = await params;

  let prefetched: PrefetchedPropertyData | undefined;

  if (erDawaId(id)) {
    try {
      // Step 1: Fetch DAWA address server-side
      const adresse = await darHentAdresse(id);

      if (adresse) {
        // Step 2: Fetch BBR data server-side (uses DAWA UUID)
        const bbrResult = await fetchBbrForAddress(id);
        const bbrData: EjendomApiResponse = { dawaId: id, ...bbrResult };

        // BIZZ-1287: Prefetch vurdering fra cache parallelt — eliminerer klient-side waterfall
        let vurderingData: VurderingResponse | null = null;
        const bfeNummer = bbrResult.ejendomsrelationer?.[0]?.bfeNummer;
        if (bfeNummer) {
          try {
            const { createAdminClient } = await import('@/lib/supabase/admin');
            const admin = createAdminClient();
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
              vurderingData = {
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
              };
            }
          } catch {
            /* Cache miss — klient fetcher live */
          }
        }

        prefetched = { dawaAdresse: adresse, bbrData, vurderingData };
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
