'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';

/**
 * NProgress-style top loading bar for Next.js App Router route transitions.
 *
 * Listens for internal <a> link clicks to start the progress animation,
 * then auto-completes when the pathname changes (= navigation finished).
 * Works alongside loading.tsx skeleton files for seamless perceived performance.
 */
export default function TopProgressBar() {
  const pathname = usePathname();
  const [width, setWidth] = useState(0);
  const [opacity, setOpacity] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const navigating = useRef(false);
  const hasMounted = useRef(false);

  /** Clears all pending timers. */
  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  /**
   * Completes the progress bar — jumps to 100%, then fades out.
   * Called when pathname changes (navigation complete).
   */
  const finish = useCallback(() => {
    clearTimers();
    navigating.current = false;
    setWidth(100);
    setOpacity(1);
    timers.current.push(
      setTimeout(() => {
        setOpacity(0);
        timers.current.push(setTimeout(() => setWidth(0), 350));
      }, 250)
    );
  }, [clearTimers]);

  /**
   * Starts the progress bar — animates slowly from 10% toward ~88%
   * while waiting for navigation to complete.
   */
  const start = useCallback(() => {
    clearTimers();
    navigating.current = true;
    setOpacity(1);
    setWidth(10);
    timers.current.push(setTimeout(() => setWidth(30), 200));
    timers.current.push(setTimeout(() => setWidth(55), 700));
    timers.current.push(setTimeout(() => setWidth(75), 1500));
    timers.current.push(setTimeout(() => setWidth(88), 3000));
    // Safety fallback: auto-complete after 12s to prevent stuck bar
    timers.current.push(setTimeout(finish, 12000));
  }, [clearTimers, finish]);

  /** Pathname changed → navigation is done → finish the bar. */
  useEffect(() => {
    // Skip the very first render (page load) so we don't flash a bar on mount
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (navigating.current) {
      finish();
    }
  }, [pathname, finish]);

  /** Listen for internal <a> link clicks to start the bar immediately on click. */
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      const anchor = (e.target as Element).closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      // Only trigger for internal navigation — not external, not hash-only, not same page
      if (href.startsWith('/') && href !== pathname && !href.startsWith('//')) {
        start();
      }
    };
    // Capture phase so we catch clicks before they bubble away
    document.addEventListener('click', handle, true);
    return () => document.removeEventListener('click', handle, true);
  }, [pathname, start]);

  /** Cleanup timers on unmount. */
  useEffect(() => () => clearTimers(), [clearTimers]);

  return (
    <div
      aria-hidden="true"
      role="progressbar"
      aria-label="Indlæser side…"
      className="fixed top-0 left-0 right-0 z-[9999] h-[2px] pointer-events-none"
      style={{ opacity, transition: 'opacity 0.35s ease' }}
    >
      <div
        className="h-full bg-blue-500"
        style={{
          width: `${width}%`,
          transition: 'width 0.4s ease',
          boxShadow: '0 0 8px rgba(59, 130, 246, 0.7)',
        }}
      />
    </div>
  );
}
