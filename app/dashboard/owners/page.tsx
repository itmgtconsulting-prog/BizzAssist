/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import PersonerListesideClient from './PersonerListesideClient';

export const dynamic = 'force-dynamic';

export default function PersonerListeside() {
  return <PersonerListesideClient />;
}
