/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import VirksomhedDetaljeClient from './VirksomhedDetaljeClient';

export const dynamic = 'force-dynamic';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function CompaniesDetailPage(props: any) {
  return <VirksomhedDetaljeClient {...props} />;
}
