'use client';

import { useEffect } from 'react';

/**
 * Removes the Next.js "N" dev toolbar button that is injected into the DOM
 * during development. Has no effect in production (NODE_ENV guard).
 */
export default function HideNextDevIndicator() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    const remove = () => {
      document.querySelectorAll<HTMLElement>('nextjs-portal').forEach((portal) => {
        const shadow = portal.shadowRoot;
        if (shadow && shadow.querySelector('button[data-nextjs-dev-tools-button]')) {
          portal.style.setProperty('display', 'none', 'important');
        }
      });
    };

    remove();
    const observer = new MutationObserver(remove);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
