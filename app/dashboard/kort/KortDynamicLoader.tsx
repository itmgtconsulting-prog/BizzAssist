/**
 * Client-side dynamic loader for KortPageClient.
 *
 * next/dynamic with ssr:false must live in a Client Component — Turbopack
 * rejects it in Server Components. This thin wrapper satisfies that constraint
 * while keeping the Server Component entry (page.tsx) for force-dynamic.
 *
 * @returns The lazy-loaded KortPageClient, rendered client-side only
 */
'use client';

import nextDynamic from 'next/dynamic';

/** Lazy-loaded to keep mapbox-gl out of the server bundle */
const KortPageClient = nextDynamic(() => import('./KortPageClient'), { ssr: false });

/**
 * Thin client wrapper that renders the dynamically imported map page.
 */
export default function KortDynamicLoader() {
  return <KortPageClient />;
}
