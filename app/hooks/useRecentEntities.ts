'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './useAuth';

interface RecentEntity {
  entity_id: string;
  display_name: string;
  entity_data: Record<string, unknown>;
  visited_at: string | number;
}

/**
 * Hybrid hook for recent entities (properties or companies).
 *
 * Reads from Supabase when authenticated, falls back to localStorage.
 * Always writes to both Supabase and localStorage for instant local updates.
 *
 * @param entityType - 'property' or 'company'
 * @param localStorageKey - localStorage key (e.g. 'ba-seneste-ejendomme')
 * @param maxItems - maximum number of recent items
 */
export function useRecentEntities(
  entityType: 'property' | 'company',
  localStorageKey: string,
  maxItems: number
) {
  const { isAuthenticated, loading } = useAuth();
  const [items, setItems] = useState<RecentEntity[]>([]);
  const hasFetched = useRef(false);

  /** Read from localStorage */
  const readLocal = useCallback((): RecentEntity[] => {
    try {
      const raw = localStorage.getItem(localStorageKey);
      if (!raw) return [];
      return JSON.parse(raw) as RecentEntity[];
    } catch {
      return [];
    }
  }, [localStorageKey]);

  /** Write to localStorage */
  const writeLocal = useCallback(
    (data: RecentEntity[]) => {
      try {
        localStorage.setItem(localStorageKey, JSON.stringify(data.slice(0, maxItems)));
      } catch {
        /* quota exceeded */
      }
    },
    [localStorageKey, maxItems]
  );

  // Load initial data
  useEffect(() => {
    if (loading) return;

    // Always start with localStorage for instant render
    const local = readLocal();
    setItems(local);

    if (!isAuthenticated || hasFetched.current) return;
    hasFetched.current = true;

    // Fetch from server in background
    fetch(`/api/recents?type=${entityType}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.recents && data.recents.length > 0) {
          setItems(data.recents);
          // Update localStorage with server data
          writeLocal(data.recents);
        }
      })
      .catch(() => {
        /* keep localStorage data */
      });
  }, [loading, isAuthenticated, entityType, readLocal, writeLocal]);

  /** Add a recently viewed entity */
  const addRecent = useCallback(
    (entity: RecentEntity) => {
      // Update local state immediately
      setItems((prev) => {
        const filtered = prev.filter((e) => e.entity_id !== entity.entity_id);
        const updated = [{ ...entity, visited_at: Date.now() }, ...filtered].slice(0, maxItems);
        writeLocal(updated);
        return updated;
      });

      // Sync to server in background
      if (isAuthenticated) {
        fetch('/api/recents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_type: entityType,
            entity_id: entity.entity_id,
            display_name: entity.display_name,
            entity_data: entity.entity_data,
          }),
        }).catch(() => {
          /* silent */
        });
      }
    },
    [isAuthenticated, entityType, maxItems, writeLocal]
  );

  /** Clear all recents of this type */
  const clearRecents = useCallback(() => {
    setItems([]);
    writeLocal([]);

    if (isAuthenticated) {
      fetch(`/api/recents?type=${entityType}`, { method: 'DELETE' }).catch(() => {
        /* silent */
      });
    }
  }, [isAuthenticated, entityType, writeLocal]);

  return { items, addRecent, clearRecents };
}
