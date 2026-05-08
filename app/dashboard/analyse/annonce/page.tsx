/**
 * Server entry for boligannonce analyse-modul.
 * BIZZ-1239: Boligannonce via AI Chat i stedet for separat API route.
 */
import AnnonceClient from './AnnonceClient';

export const dynamic = 'force-dynamic';

export default function AnnoncePage() {
  return <AnnonceClient />;
}
