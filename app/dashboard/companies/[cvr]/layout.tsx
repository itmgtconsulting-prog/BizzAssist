import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Route-level layout for company detail pages (`/dashboard/companies/[cvr]`).
 *
 * The page component (`page.tsx`) is a Client Component (`'use client'`) so it
 * cannot export `generateMetadata` directly.  Next.js resolves metadata from
 * the nearest Server Component ancestor in the same route segment, making this
 * layout the correct place for dynamic OG meta.
 *
 * @param params - Route params injected by Next.js App Router
 * @param params.cvr - 8-digit CVR number from the URL segment
 * @param children - The page subtree rendered inside this layout
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ cvr: string }>;
}): Promise<Metadata> {
  const { cvr } = await params;

  // Attempt to resolve the company name so link previews show a real name
  // rather than just the CVR number.
  try {
    const res = await fetch(`https://cvrapi.dk/api?search=${cvr}&country=dk`, {
      headers: { 'User-Agent': 'BizzAssist/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { name?: string };
    const name = data?.name ?? `CVR ${cvr}`;
    return {
      title: `${name} — BizzAssist`,
      description: `Virksomhedsdetaljer for ${name} (CVR: ${cvr}). Ejere, regnskaber, produktionsenheder og mere.`,
      openGraph: {
        title: `${name} — BizzAssist`,
        description: `CVR: ${cvr}`,
      },
    };
  } catch {
    // Fall back to a minimal title if the upstream call fails.
    return { title: `CVR ${cvr} — BizzAssist` };
  }
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
export default function CompanyDetailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
