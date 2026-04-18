/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * BIZZ-483: Dedikeret detaljeside for EJF_PersonVirksomhedsoplys-parter
 * (dødsboer, fonde, udenlandske ejere, administratorer) — parter uden
 * CVR/CPR der ikke passer på /dashboard/companies eller /dashboard/owners.
 */
import PVOplysDetailPageClient from './PVOplysDetailPageClient';

export const dynamic = 'force-dynamic';

/** Next.js App Router page props for /dashboard/pvoplys/[fiktivtPVnummer] */
interface PVOplysDetailPageProps {
  params: Promise<{ fiktivtPVnummer: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
}

export default function PVOplysDetailPage(props: PVOplysDetailPageProps) {
  return <PVOplysDetailPageClient {...props} />;
}
