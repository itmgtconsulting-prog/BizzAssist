/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import VirksomhederListesideClient from './VirksomhederListesideClient';

export const dynamic = 'force-dynamic';

export default function VirksomhederListeside() {
  return <VirksomhederListesideClient />;
}
