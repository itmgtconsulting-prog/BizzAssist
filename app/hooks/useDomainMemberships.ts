'use client';

/**
 * BIZZ-808: useDomainMemberships — henter og cacher den loggede brugers
 * domain-tilknytninger. Bruges af fx "Opret sag"-knappen på detail-sider
 * til at (a) afgøre om knappen skal vises overhovedet og (b) vælge hvilket
 * domain sagen oprettes i.
 *
 * API: GET /api/domain/mine (eksisterende endpoint fra BIZZ-711).
 * Fejler stille — tom liste ved fejl → knap skjules.
 */

import { useEffect, useState } from 'react';

export interface DomainMembership {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'member';
}

/** Session-scoped cache: fetched once, delt på tværs af komponenter. */
let cache: DomainMembership[] | null = null;
let inflight: Promise<DomainMembership[]> | null = null;

async function fetchMemberships(): Promise<DomainMembership[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch('/api/domain/mine', { cache: 'no-store' });
      if (!r.ok) return [];
      const data = (await r.json()) as DomainMembership[];
      cache = Array.isArray(data) ? data : [];
      return cache;
    } catch {
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Returnerer brugerens domain-memberships. `loading=true` indtil første
 * fetch er færdig. Efter første fetch cached i hele session.
 *
 * @returns { memberships, loading }
 */
export function useDomainMemberships(): {
  memberships: DomainMembership[];
  loading: boolean;
} {
  const [memberships, setMemberships] = useState<DomainMembership[]>(cache ?? []);
  const [loading, setLoading] = useState<boolean>(cache === null);

  useEffect(() => {
    if (cache !== null) {
      setMemberships(cache);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void fetchMemberships().then((data) => {
      if (!cancelled) {
        setMemberships(data);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { memberships, loading };
}
