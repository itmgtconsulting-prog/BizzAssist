/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import OrganisationPageClient from './OrganisationPageClient';

export const dynamic = 'force-dynamic';

export default function OrganisationPage() {
  return <OrganisationPageClient />;
}
