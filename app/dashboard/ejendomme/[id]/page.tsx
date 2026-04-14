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

        prefetched = { dawaAdresse: adresse, bbrData };
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
