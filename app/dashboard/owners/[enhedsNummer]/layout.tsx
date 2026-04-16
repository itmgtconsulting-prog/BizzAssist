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
 * Fetches the person's name directly from CVR ES so the browser tab shows
 * the real name instead of the raw enhedsNummer (BIZZ-400).
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

  // Attempt to resolve the person's display name from CVR ES.
  // Falls back to the enhedsNummer if the lookup fails or credentials are absent.
  const personNavn = await fetchPersonNavn(enhedsNummer);
  const displayTitle = personNavn
    ? `${personNavn} — BizzAssist`
    : `Person ${enhedsNummer} — BizzAssist`;

  return {
    title: displayTitle,
    description: `Personprofil, virksomhedstilknytninger og ejendomme.`,
    openGraph: {
      title: displayTitle,
    },
  };
}

// ─── CVR ES name lookup ───────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';

type CvrEsHit = {
  _source?: {
    Vrvirksomhed?: {
      deltagerRelation?: Array<{
        deltager?: {
          enhedsNummer?: number;
          navne?: Array<{ navn?: string; periode?: { gyldigTil?: string | null } }>;
        };
      }>;
    };
  };
};

/**
 * Looks up a person's name in CVR Elasticsearch by enhedsNummer.
 *
 * Makes a lightweight ES query that only fetches deltagerRelation navne so the
 * metadata response is fast. Returns `null` if the lookup fails for any reason
 * (missing credentials, network error, person not found) — the caller falls
 * back to the raw enhedsNummer in that case.
 *
 * @param enhedsNummer - The person's CVR enhedsNummer as a string
 * @returns The person's current name, or null on failure
 */
async function fetchPersonNavn(enhedsNummer: string): Promise<string | null> {
  const user = process.env.CVR_ES_USER;
  const pass = process.env.CVR_ES_PASS;
  if (!user || !pass) return null;

  const enhedsNr = Number(enhedsNummer);
  if (!Number.isFinite(enhedsNr)) return null;

  try {
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const esQuery = {
      query: {
        bool: {
          must: [{ term: { 'Vrvirksomhed.deltagerRelation.deltager.enhedsNummer': enhedsNr } }],
        },
      },
      // Only fetch the fields we need for the name lookup
      _source: ['Vrvirksomhed.deltagerRelation'],
      size: 1,
    };

    const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(5000),
      // Cache for 1 hour — same as the full person route
      next: { revalidate: 3600 },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { hits?: { hits?: CvrEsHit[] } };
    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) return null;

    // Walk through deltagerRelation entries to find the matching participant's name
    const relationer = hits[0]._source?.Vrvirksomhed?.deltagerRelation ?? [];

    for (const rel of relationer) {
      const deltager = rel.deltager;
      if (!deltager || deltager.enhedsNummer !== enhedsNr) continue;

      const navne = deltager.navne ?? [];
      // Prefer an entry with no gyldigTil (still valid), otherwise take the last one
      const current = navne.find((n) => n.periode?.gyldigTil == null) ?? navne[navne.length - 1];
      return current?.navn ?? null;
    }

    return null;
  } catch {
    // Never let a metadata fetch failure break page rendering
    return null;
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
export default function OwnerDetailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
