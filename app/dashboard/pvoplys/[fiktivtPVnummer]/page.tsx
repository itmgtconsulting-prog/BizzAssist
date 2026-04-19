/**
 * BIZZ-483: Server entry for PVOplys-detaljeside.
 *
 * /dashboard/pvoplys/[fiktivtPVnummer]?navn=...&type=...&landekode=...&adresse=...&administrator=...
 *
 * PVOplys-parter (dødsboer, fonde, udenlandske ejere, administratorer) har
 * intet CVR/CPR — kun et fiktivt PV-nummer. EJF Custom_PVOplys eksponerer
 * de specifikke felter, men endpoint-konfiguration kræver separate
 * grant. Denne side viser pt. data passed via URL-params fra ejerskabs-
 * listen + chain endpoint så brugeren kan se kontekst om parten.
 */
import PVOplysDetailPageClient from './PVOplysDetailPageClient';

export const dynamic = 'force-dynamic';

interface PVOplysDetailPageProps {
  params: Promise<{ fiktivtPVnummer: string }>;
  searchParams?: Promise<Record<string, string | string[]>>;
}

export default function PVOplysDetailPage(props: PVOplysDetailPageProps) {
  return <PVOplysDetailPageClient {...props} />;
}
