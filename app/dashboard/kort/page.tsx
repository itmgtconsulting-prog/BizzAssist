/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * The actual lazy-load with ssr:false lives in KortDynamicLoader (a Client
 * Component) because Turbopack disallows next/dynamic ssr:false in Server
 * Components.
 */
import KortDynamicLoader from './KortDynamicLoader';

export const dynamic = 'force-dynamic';

/** @returns Server shell that delegates rendering to the client-side loader */
export default function KortPage() {
  return <KortDynamicLoader />;
}
