'use client';

import { useEffect } from 'react';

/**
 * Registrerer service worker i produktion, afregistrerer i dev.
 * I dev-mode forårsager SW cache-first strategi stale Turbopack chunks
 * der crasher med "module factory is not available" runtime errors.
 */
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const isDev =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (isDev) {
      // Afregistrer alle SW'er i dev — forhindrer stale chunk-caching
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      });
    } else {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  return null;
}
