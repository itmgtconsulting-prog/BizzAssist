/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import EjendomDetaljeClient from './EjendomDetaljeClient';

export const dynamic = 'force-dynamic';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function EjendommeDetailPage(props: any) {
  return <EjendomDetaljeClient {...props} />;
}
