'use client';

/**
 * useSessionTimeout — idle + absolute session timeout med advarsel.
 *
 * Tracker bruger-aktivitet (klik, scroll, tastatur, touch).
 * Henter timeout-indstillinger fra /api/session-settings ved mount.
 *
 * Logik:
 *   - Idle timeout: ingen aktivitet i `idleMinutes` minutter → advarsel vises
 *   - Advarsel: 5 minutters nedtælling → brugeren kan klikke "Fortsæt"
 *   - Absolut timeout: `absoluteHours` timer efter login → log ud uanset aktivitet
 *   - Kalder `onTimeout()` når sesionen udløber (typisk: signOut + redirect)
 *   - `onActivity()` kaldes når brugeren er aktiv (nulstil idle timer)
 *
 * @param onTimeout  - Callback der kaldes ved timeout (log ud)
 * @param onActivity - Valgfrit callback ved bruger-aktivitet
 * @returns { showWarning, secondsLeft, extendSession } — til UI-komponenten
 */

import { useEffect, useRef, useState, useCallback } from 'react';

/** Antal sekunder i advarselsvinduet inden timeout. */
const WARNING_SECONDS = 5 * 60;

interface SessionTimeoutOptions {
  onTimeout: () => void;
  onActivity?: () => void;
}

interface SessionTimeoutState {
  /** Vis advarselsdialog */
  showWarning: boolean;
  /** Sekunder tilbage inden automatisk logout */
  secondsLeft: number;
  /** Nulstil idle-timer og skjul advarsel */
  extendSession: () => void;
}

export function useSessionTimeout({
  onTimeout,
  onActivity,
}: SessionTimeoutOptions): SessionTimeoutState {
  const [idleMinutes, setIdleMinutes] = useState(60);
  const [absoluteHours, setAbsoluteHours] = useState(24);
  const [showWarning, setShowWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(WARNING_SECONDS);

  // Timestamps stored in refs to avoid stale closure issues.
  // Initialized to null and set on first tick (avoids impure Date.now() during render).
  const lastActivityRef = useRef<number | null>(null);
  const sessionStartRef = useRef<number | null>(null);
  const warningStartRef = useRef<number | null>(null);
  const timedOutRef = useRef(false);

  // Fetch session settings on mount
  useEffect(() => {
    fetch('/api/session-settings')
      .then((r) => r.json())
      .then((data: { idle_timeout_minutes?: number; absolute_timeout_hours?: number }) => {
        if (typeof data.idle_timeout_minutes === 'number') {
          setIdleMinutes(data.idle_timeout_minutes);
        }
        if (typeof data.absolute_timeout_hours === 'number') {
          setAbsoluteHours(data.absolute_timeout_hours);
        }
      })
      .catch(() => {
        /* use defaults */
      });
  }, []);

  /** Nulstil idle-timer og skjul advarsel. */
  const extendSession = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;
    warningStartRef.current = null;
    setShowWarning(false);
    setSecondsLeft(WARNING_SECONDS);
  }, []);

  /** Registrer bruger-aktivitet. */
  const handleActivity = useCallback(() => {
    if (timedOutRef.current) return;
    const now = Date.now();
    lastActivityRef.current = now;
    if (onActivity) onActivity();
    // Skjul advarsel og nulstil ved aktivitet (medmindre der er under 60 sek. tilbage)
    if (showWarning && secondsLeft > 60) {
      extendSession();
    }
  }, [onActivity, showWarning, secondsLeft, extendSession]);

  // Attach activity event listeners
  useEffect(() => {
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'] as const;
    events.forEach((e) => window.addEventListener(e, handleActivity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, handleActivity));
  }, [handleActivity]);

  // Main tick — check idle + absolute timeout every second
  useEffect(() => {
    if (timedOutRef.current) return;

    const interval = setInterval(() => {
      if (timedOutRef.current) return;

      const now = Date.now();
      // Lazy-initialise on first tick to avoid calling Date.now() during render
      if (lastActivityRef.current === null) lastActivityRef.current = now;
      if (sessionStartRef.current === null) sessionStartRef.current = now;

      const idleMs = idleMinutes * 60 * 1000;
      const absoluteMs = absoluteHours * 60 * 60 * 1000;
      const idleSince = now - lastActivityRef.current;
      const sessionAge = now - sessionStartRef.current;

      // Absolut timeout — log ud uanset aktivitet
      if (sessionAge >= absoluteMs) {
        timedOutRef.current = true;
        clearInterval(interval);
        onTimeout();
        return;
      }

      // Idle timeout — start nedtælling 5 min. før
      const timeToIdleTimeout = idleMs - idleSince;

      if (timeToIdleTimeout <= 0) {
        // Idle timeout nået
        timedOutRef.current = true;
        clearInterval(interval);
        onTimeout();
        return;
      }

      if (timeToIdleTimeout <= WARNING_SECONDS * 1000) {
        // Vis advarsel
        if (!showWarning) {
          warningStartRef.current = now;
          setShowWarning(true);
        }
        const secs = Math.ceil(timeToIdleTimeout / 1000);
        setSecondsLeft(Math.max(0, secs));
      } else if (showWarning) {
        // Bruger var aktiv, skjul advarsel
        setShowWarning(false);
        setSecondsLeft(WARNING_SECONDS);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [idleMinutes, absoluteHours, onTimeout, showWarning]);

  return { showWarning, secondsLeft, extendSession };
}
