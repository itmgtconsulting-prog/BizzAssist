/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import PersonDetailPageClient from './PersonDetailPageClient';

export const dynamic = 'force-dynamic';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function OwnersDetailPage(props: any) {
  return <PersonDetailPageClient {...props} />;
}
