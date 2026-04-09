/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import VirksomhedDetaljeClient from './VirksomhedDetaljeClient';

export const dynamic = 'force-dynamic';

/** Next.js App Router page props for dynamic route /dashboard/companies/[cvr] */
interface CompaniesDetailPageProps {
  params: Promise<{ cvr: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
}

export default function CompaniesDetailPage(props: CompaniesDetailPageProps) {
  return <VirksomhedDetaljeClient {...props} />;
}
