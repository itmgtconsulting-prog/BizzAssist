/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 *
 * BIZZ-1160: Prefetcher CVR-data server-side fra cvr_virksomhed cache
 * så virksomhedssiden kan vise basisinfo med det samme.
 */
import { createAdminClient } from '@/lib/supabase/admin';
import VirksomhedDetaljeClient from './VirksomhedDetaljeClient';
import { logger } from '@/app/lib/logger';

export const dynamic = 'force-dynamic';

/** Prefetched data passed to client component */
export interface PrefetchedCompanyData {
  navn: string | null;
  virksomhedsform: string | null;
  branche_tekst: string | null;
  status: string | null;
  ophoert: string | null;
}

/** Next.js App Router page props for dynamic route /dashboard/companies/[cvr] */
interface CompaniesDetailPageProps {
  params: Promise<{ cvr: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
}

export default async function CompaniesDetailPage(props: CompaniesDetailPageProps) {
  const { cvr } = await props.params;

  let prefetched: PrefetchedCompanyData | undefined;

  // Server-side prefetch fra lokal cache — instant (ingen ekstern API)
  if (/^\d{8}$/.test(cvr)) {
    try {
      const admin = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (admin as any)
        .from('cvr_virksomhed')
        .select('navn, virksomhedsform, branche_tekst, status, ophoert')
        .eq('cvr', cvr)
        .maybeSingle();
      if (data) {
        prefetched = data;
      }
    } catch (err) {
      logger.warn('[companies/page] Server prefetch fejl:', err);
    }
  }

  return <VirksomhedDetaljeClient {...props} prefetched={prefetched} />;
}
