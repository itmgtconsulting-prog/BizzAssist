'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from './useAuth';

/**
 * Hook for syncing user preferences to Supabase.
 *
 * Works as a side-channel: reads/writes to /api/preferences when
 * authenticated, and always keeps localStorage as a local cache.
 *
 * Does NOT manage React state — that stays with the existing
 * LanguageContext and PropertyMap components. This hook just
 * syncs the server in the background.
 *
 * @returns {{ syncLanguage, syncMapStyle, loadPreferences }}
 */
export function usePreferences() {
  const { isAuthenticated, loading } = useAuth();
  const hasSynced = useRef(false);

  /**
   * Load preferences from server and return them.
   * Falls back to localStorage values if not authenticated.
   */
  const loadPreferences = useCallback(async () => {
    if (!isAuthenticated) return null;

    try {
      const res = await fetch('/api/preferences');
      if (!res.ok) return null;
      const data = await res.json();
      return {
        language: data.language as 'da' | 'en' | undefined,
        mapStyle: data.preferences?.mapStyle as string | undefined,
      };
    } catch {
      return null;
    }
  }, [isAuthenticated]);

  /**
   * Sync language preference to server (fire-and-forget).
   */
  const syncLanguage = useCallback(
    (lang: 'da' | 'en') => {
      if (!isAuthenticated) return;
      fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang }),
      }).catch(() => {
        /* silent — localStorage is the fallback */
      });
    },
    [isAuthenticated]
  );

  /**
   * Sync map style to server (fire-and-forget).
   */
  const syncMapStyle = useCallback(
    (style: string) => {
      if (!isAuthenticated) return;
      fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapStyle: style }),
      }).catch(() => {
        /* silent */
      });
    },
    [isAuthenticated]
  );

  // On first load when authenticated, pull server prefs into localStorage
  useEffect(() => {
    if (loading || !isAuthenticated || hasSynced.current) return;
    hasSynced.current = true;

    loadPreferences().then((prefs) => {
      if (!prefs) return;
      // Only overwrite localStorage if server has a value
      if (prefs.language) {
        const current = localStorage.getItem('ba-lang');
        if (!current || current !== prefs.language) {
          localStorage.setItem('ba-lang', prefs.language);
        }
      }
      if (prefs.mapStyle) {
        localStorage.setItem('bizzassist-map-style', prefs.mapStyle);
      }
    });
  }, [loading, isAuthenticated, loadPreferences]);

  return { syncLanguage, syncMapStyle, loadPreferences };
}
