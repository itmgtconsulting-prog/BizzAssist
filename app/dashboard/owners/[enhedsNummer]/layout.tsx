import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Route-level layout for person/owner detail pages
 * (`/dashboard/owners/[enhedsNummer]`).
 *
 * The page component (`page.tsx`) is a Client Component (`'use client'`) so it
 * cannot export `generateMetadata` directly.  This Server Component layout is
 * the nearest ancestor in the same route segment and is therefore where
 * Next.js resolves dynamic metadata.
 *
 * @param params - Route params injected by Next.js App Router
 * @param params.enhedsNummer - CVR person unit number from the URL segment
 * @param children - The page subtree rendered inside this layout
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ enhedsNummer: string }>;
}): Promise<Metadata> {
  const { enhedsNummer } = await params;

  return {
    title: `Person ${enhedsNummer} — BizzAssist`,
    description: `Personprofil, virksomhedstilknytninger og ejendomme.`,
    openGraph: {
      title: `Person ${enhedsNummer} — BizzAssist`,
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
export default function OwnerDetailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
