/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import PersonDetailPageClient from './PersonDetailPageClient';

export const dynamic = 'force-dynamic';

/** Next.js App Router page props for dynamic route /dashboard/owners/[enhedsNummer] */
interface OwnersDetailPageProps {
  params: Promise<{ enhedsNummer: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
}

export default function OwnersDetailPage(props: OwnersDetailPageProps) {
  return <PersonDetailPageClient {...props} />;
}
