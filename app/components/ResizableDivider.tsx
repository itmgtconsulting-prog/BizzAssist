'use client';

/**
 * ResizableDivider — vertical drag-handle mellem to kolonner.
 *
 * Bruges i `/dashboard/search` (BIZZ-786) til at resize filter-panelet
 * mellem 280 og 600px bredde. Komponenten renderer en smal vertikal bar
 * som kan trækkes med mus/pointer. Bredden eksponeres via onChange —
 * parent-komponenten står selv for at persistere den (fx til localStorage).
 *
 * Keyboard-support og mobile bottom-sheet fallback er parkeret til iter 2
 * (BIZZ-786a/b).
 */

import { useCallback, useEffect, useRef } from 'react';

interface ResizableDividerProps {
  /** Nuværende bredde i pixels af panelet til højre for divideren. */
  width: number;
  /** Minimum bredde (clamp-lower). */
  minWidth: number;
  /** Maksimum bredde (clamp-upper). */
  maxWidth: number;
  /** Callback der fyres når brugeren trækker divideren. */
  onChange: (width: number) => void;
  /** ARIA-label (bilingual). */
  ariaLabel: string;
}

/**
 * Vertical drag-handle. Brugeren trækker for at ændre bredden af
 * søsterelementet (filter-panel). Width-state eje'es af parent.
 *
 * @param props - Width, min/max, onChange callback
 * @returns Tynd vertikal bar med col-resize cursor
 */
export default function ResizableDivider({
  width,
  minWidth,
  maxWidth,
  onChange,
  ariaLabel,
}: ResizableDividerProps) {
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  /**
   * Starter drag. Registrerer start-position og -bredde, binder
   * window-level pointer listeners så drag fortsætter også hvis musen
   * kortvarigt forlader divideren.
   */
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      // Capture så vi får pointer events selv udenfor divideren
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width]
  );

  /**
   * Beregner ny bredde fra cursor-delta. Bredden vokser når brugeren
   * trækker mod venstre (panelet er i højre side).
   */
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const delta = startXRef.current - e.clientX; // venstre-træk = større panel
      const next = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + delta));
      onChange(next);
    },
    [minWidth, maxWidth, onChange]
  );

  /** Slutter drag og nulstiller body-cursor. */
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // releasePointerCapture kan fejle hvis pointer allerede er frigivet
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  // Defensivt: sørg for at body-cursor altid nulstilles hvis komponenten
  // unmount'es midt i et drag.
  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={-1}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="w-1.5 shrink-0 bg-slate-700/30 hover:bg-blue-500/40 active:bg-blue-500/60 cursor-col-resize transition-colors"
    />
  );
}
