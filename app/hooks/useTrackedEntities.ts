'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './useAuth';

interface TrackedEntity {
  id: string;
  entity_id: string;
  label: string | null;
  entity_data: Record<string, unknown>;
  is_monitored: boolean;
  created_at: string;
}

/**
 * Hybrid hook for tracked/monitored entities.
 *
 * Uses Supabase (via /api/tracked or /api/tracked-companies) when
 * authenticated, falls back to localStorage.
 *
 * @param entityType - 'property' or 'company'
 * @param apiPath - API endpoint (e.g. '/api/tracked' or '/api/tracked-companies')
 * @param localStorageKey - localStorage key for fallback
 */
export function useTrackedEntities(
  entityType: 'property' | 'company',
  apiPath: string,
  localStorageKey: string
) {
  const { isAuthenticated, loading } = useAuth();
  const [items, setItems] = useState<TrackedEntity[]>([]);
  const hasFetched = useRef(false);

  /** Read from localStorage */
  const readLocal = useCallback((): TrackedEntity[] => {
    try {
      const raw = localStorage.getItem(localStorageKey);
      if (!raw) return [];
      return JSON.parse(raw) as TrackedEntity[];
    } catch {
      return [];
    }
  }, [localStorageKey]);

  /** Write to localStorage */
  const writeLocal = useCallback(
    (data: TrackedEntity[]) => {
      try {
        localStorage.setItem(localStorageKey, JSON.stringify(data));
      } catch {
        /* quota exceeded */
      }
    },
    [localStorageKey]
  );

  // Load initial data
  useEffect(() => {
    if (loading) return;

    const local = readLocal();
    setItems(local);

    if (!isAuthenticated || hasFetched.current) return;
    hasFetched.current = true;

    fetch(apiPath)
      .then((res) => res.json())
      .then((data) => {
        if (data.tracked && data.tracked.length > 0) {
          const mapped = data.tracked.map((e: TrackedEntity) => ({
            ...e,
            entity_data: e.entity_data ?? {},
          }));
          setItems(mapped);
          writeLocal(mapped);
        }
      })
      .catch(() => {
        /* keep localStorage */
      });
  }, [loading, isAuthenticated, apiPath, readLocal, writeLocal]);

  /** Check if an entity is tracked */
  const isTracked = useCallback(
    (entityId: string) => items.some((e) => e.entity_id === entityId && e.is_monitored),
    [items]
  );

  /** Track an entity */
  const track = useCallback(
    async (entityId: string, label: string, entityData?: Record<string, unknown>) => {
      const newItem: TrackedEntity = {
        id: entityId,
        entity_id: entityId,
        label,
        entity_data: entityData ?? {},
        is_monitored: true,
        created_at: new Date().toISOString(),
      };

      setItems((prev) => {
        const filtered = prev.filter((e) => e.entity_id !== entityId);
        const updated = [newItem, ...filtered];
        writeLocal(updated);
        return updated;
      });

      if (isAuthenticated) {
        try {
          await fetch(apiPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              entity_id: entityId,
              label,
              entity_data: entityData ?? {},
            }),
          });
        } catch {
          /* localStorage already updated */
        }
      }

      return true;
    },
    [isAuthenticated, apiPath, writeLocal]
  );

  /** Untrack an entity */
  const untrack = useCallback(
    async (entityId: string) => {
      setItems((prev) => {
        const updated = prev.filter((e) => e.entity_id !== entityId);
        writeLocal(updated);
        return updated;
      });

      if (isAuthenticated) {
        try {
          await fetch(`${apiPath}?id=${encodeURIComponent(entityId)}`, {
            method: 'DELETE',
          });
        } catch {
          /* localStorage already updated */
        }
      }

      return false;
    },
    [isAuthenticated, apiPath, writeLocal]
  );

  /** Toggle tracked state */
  const toggle = useCallback(
    async (entityId: string, label: string, entityData?: Record<string, unknown>) => {
      if (isTracked(entityId)) {
        return untrack(entityId);
      } else {
        return track(entityId, label, entityData);
      }
    },
    [isTracked, track, untrack]
  );

  return { items, isTracked, track, untrack, toggle };
}
