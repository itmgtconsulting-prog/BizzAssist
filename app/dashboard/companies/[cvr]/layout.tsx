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

  // Resolve company name via Erhvervsstyrelsen CVR ES (system user) for OG meta.
  // Replaces cvrapi.dk which has rate limits on the free tier.
  try {
    const cvrUser = process.env.CVR_ES_USER ?? '';
    const cvrPass = process.env.CVR_ES_PASS ?? '';
    const auth = Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64');
    const res = await fetch('http://distribution.virk.dk/cvr-permanent/virksomhed/_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        query: { term: { 'Vrvirksomhed.cvrNummer': Number(cvr) } },
        _source: ['Vrvirksomhed.navne'],
        size: 1,
      }),
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 3600 },
    });
    const data = (await res.json()) as {
      hits?: {
        hits?: Array<{
          _source?: {
            Vrvirksomhed?: {
              navne?: Array<{ navn?: string; periode?: { gyldigTil?: string | null } }>;
            };
          };
        }>;
      };
    };
    const navne = data.hits?.hits?.[0]?._source?.Vrvirksomhed?.navne ?? [];
    const aktivtNavn = navne.find((n) => n.periode?.gyldigTil == null) ?? navne[navne.length - 1];
    const name = aktivtNavn?.navn ?? `CVR ${cvr}`;
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
