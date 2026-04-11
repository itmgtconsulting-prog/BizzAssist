/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * KortPageClient is lazy-loaded with ssr:false because it depends on
 * mapbox-gl, a heavy browser-only library.
 */
import nextDynamic from 'next/dynamic';

export const dynamic = 'force-dynamic';

/** Lazy-loaded to keep mapbox-gl out of the server bundle */
const KortPageClient = nextDynamic(() => import('./KortPageClient'), { ssr: false });

export default function KortPage() {
  return <KortPageClient />;
}
