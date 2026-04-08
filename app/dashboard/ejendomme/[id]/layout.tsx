import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Route-level layout for property detail pages (`/dashboard/ejendomme/[id]`).
 *
 * The page component (`page.tsx`) is a Client Component (`'use client'`) so it
 * cannot export `generateMetadata` directly.  This Server Component layout is
 * the nearest ancestor in the same route segment and is therefore where
 * Next.js resolves dynamic metadata.
 *
 * @param params - Route params injected by Next.js App Router
 * @param params.id - BFE number from the URL segment
 * @param children - The page subtree rendered inside this layout
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  return {
    title: `Ejendom ${id} — BizzAssist`,
    description: `Ejendomsdetaljer, BBR-data, ejerskab og vurdering for BFE ${id}.`,
    openGraph: {
      title: `Ejendom ${id} — BizzAssist`,
    },
  };
}

/**
 * Passthrough layout — renders children unchanged.
 *
 * All visual chrome (sidebar, topbar) is already provided by the parent
 * `app/dashboard/layout.tsx`; this layout exists solely to host
 * `generateMetadata`.
 *
 * @param children - Page subtree
 */
export default function PropertyDetailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
