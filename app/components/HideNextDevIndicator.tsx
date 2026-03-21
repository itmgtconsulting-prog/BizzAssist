'use client';

import { useEffect } from 'react';

/**
 * Removes the Next.js "N" dev toolbar button injected into the DOM in development.
 * Distinguishes between the indicator (small button, no dialog) and error overlays
 * (contain role="dialog" or h1/h2) so error messages are never hidden.
 * Has no effect in production (NODE_ENV guard).
 */
export default function HideNextDevIndicator() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    /**
     * Checks a nextjs-portal element and hides it if it is the dev indicator
     * (small floating button) rather than an error overlay.
     * @param portal - The nextjs-portal HTMLElement to inspect
     */
    const tryHide = (portal: HTMLElement) => {
      // Allow shadow DOM to populate before inspecting
      setTimeout(() => {
        const shadow = portal.shadowRoot;
        if (!shadow) return;
        // Error overlays contain dialogs or headings — never hide those
        const isErrorOverlay = shadow.querySelector(
          '[role="dialog"], dialog, h1, h2, [data-nextjs-dialog], [data-nextjs-toast]'
        );
        if (!isErrorOverlay) {
          portal.style.setProperty('display', 'none', 'important');
        }
      }, 100);
    };

    // Hide any portals already in the DOM (the indicator renders on mount)
    document.querySelectorAll<HTMLElement>('nextjs-portal').forEach(tryHide);

    // Watch for portals added later (new error overlays should stay visible)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement && node.tagName.toLowerCase() === 'nextjs-portal') {
            tryHide(node);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
