/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import EjendomDetaljeClient from './EjendomDetaljeClient';

export const dynamic = 'force-dynamic';

/** Next.js App Router page props for dynamic route /dashboard/ejendomme/[id] */
interface EjendommeDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
}

export default function EjendommeDetailPage(props: EjendommeDetailPageProps) {
  return <EjendomDetaljeClient {...props} />;
}
