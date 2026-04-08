/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import EjendommeListesideClient from './EjendommeListesideClient';

export const dynamic = 'force-dynamic';

export default function EjendommeListeside() {
  return <EjendommeListesideClient />;
}
