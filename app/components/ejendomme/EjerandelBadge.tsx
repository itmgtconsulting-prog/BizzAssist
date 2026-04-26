'use client';

/**
 * EjerandelBadge — client-component der lazy-loader ejerandels-data for
 * en enkelt BFE og viser den primære ejers andel som et kompakt badge.
 *
 * BIZZ-833 iter 2: SFE-side viste ikke ejerandele per lejlighed. Nu
 * fetcher vi /api/ejerskab?bfeNummer=X on-mount per unit-card og
 * renderer "X%" (primær ejer) eller "N ejere" når flere har lige dele.
 *
 * Performance: hver ejerlejlighed fyrer én fetch — browsers cap'er ved
 * 6 concurrent connections per host, så det serialiseres naturligt.
 * For SFE'er med mange lejligheder (>20) kan det give mærkbar load-
 * latency, men per-unit lazy-load holder TTFB lav. Iter 3 kan batche
 * via ny endpoint /api/ejerskab/batch?bfe=1,2,3 hvis UX-data viser
 * behov.
 */

import { useEffect, useState } from 'react';

interface Props {
  bfe: number;
  /** Styling-variant: 'inline' sidst i bread-crumb, 'badge' som pill. */
  variant?: 'inline' | 'badge';
}

interface EjerAndel {
  andel: number; // 0-1
  ejer: string;
  ejere_total: number;
}

/**
 * Parse ejerandel fra bror/nævner til decimal 0-1.
 */
function ejerandelPct(taeller: number | null, naevner: number | null): number | null {
  if (taeller == null || naevner == null || naevner === 0) return null;
  const pct = taeller / naevner;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(1, pct));
}

export default function EjerandelBadge({ bfe, variant = 'badge' }: Props) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; data: EjerAndel } | { status: 'missing' }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/ejerskab?bfeNummer=${bfe}`);
        if (!r.ok) {
          if (!cancelled) setState({ status: 'missing' });
          return;
        }
        const data = (await r.json()) as {
          ejere?: Array<{
            cvr: string | null;
            personNavn: string | null;
            virksomhedsnavn?: string | null;
            ejerandel_taeller: number | null;
            ejerandel_naevner: number | null;
            ejertype: string;
          }>;
        };
        const ejere = data.ejere ?? [];
        if (ejere.length === 0) {
          if (!cancelled) setState({ status: 'missing' });
          return;
        }
        // Find primær ejer: den med størst ejerandel (fallback første)
        const decorated = ejere.map((e) => ({
          ...e,
          pct: ejerandelPct(e.ejerandel_taeller, e.ejerandel_naevner),
        }));
        decorated.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
        const top = decorated[0];
        const name =
          top.virksomhedsnavn ?? top.personNavn ?? (top.cvr ? `CVR ${top.cvr}` : 'Ukendt ejer');
        if (!cancelled) {
          setState({
            status: 'ready',
            data: {
              andel: top.pct ?? 0,
              ejer: name,
              ejere_total: ejere.length,
            },
          });
        }
      } catch {
        if (!cancelled) setState({ status: 'missing' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bfe]);

  if (state.status === 'loading') {
    return (
      <span
        className={
          variant === 'inline'
            ? 'text-slate-600 text-[10px]'
            : 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-slate-800/60 text-slate-500 text-[10px]'
        }
        title="Henter ejerandel…"
      >
        …
      </span>
    );
  }
  if (state.status === 'missing') return null;

  const pct = Math.round(state.data.andel * 100);
  const label =
    state.data.ejere_total === 1
      ? `${pct}% · ${state.data.ejer}`
      : `${pct}% · ${state.data.ejer} (+${state.data.ejere_total - 1})`;

  if (variant === 'inline') {
    return (
      <span className="text-slate-500 text-[10px] ml-1" title={label}>
        · {pct}%
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px] max-w-[200px]"
      title={label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
