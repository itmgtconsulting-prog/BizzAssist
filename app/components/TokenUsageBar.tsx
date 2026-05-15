/**
 * TokenUsageBar — genbrugelig komponent der viser AI token-forbrug.
 *
 * Bruges i AIChatPanel og forsikringsmodulet (BIZZ-1447).
 * Viser en progressbar med farve-koding:
 *   - Emerald: 0-70%
 *   - Amber: 70-90%
 *   - Red: 90%+
 *
 * @module app/components/TokenUsageBar
 */

'use client';

import { useSubscription } from '@/app/context/SubscriptionContext';
import { useMemo } from 'react';

/**
 * Format et tal med dansk tusind-separator.
 *
 * @param n - Tal der skal formateres
 */
function formatTokens(n: number): string {
  return n.toLocaleString('da-DK');
}

interface TokenUsageBarProps {
  /** Ekstra klasse-navne til wrapper-div. */
  className?: string;
  /** Kompakt mode — kun bar, ingen tekst. */
  compact?: boolean;
}

/**
 * Viser AI token-forbrug som en progressbar med farve-koding.
 * Henter data fra SubscriptionContext.
 */
export default function TokenUsageBar({
  className = '',
  compact = false,
}: TokenUsageBarProps): React.ReactElement | null {
  const { subscription } = useSubscription();

  const info = useMemo(() => {
    if (!subscription) return null;
    const used = subscription.tokensUsedThisMonth ?? 0;
    const limit = subscription.aiTokensPerMonth ?? 0;
    if (limit <= 0 && limit !== -1) return null;
    const isUnlimited = limit === -1;
    const pct = isUnlimited ? 0 : Math.min((used / limit) * 100, 100);
    return { used, limit, pct, isUnlimited };
  }, [subscription]);

  if (!info) return null;

  const barColor =
    info.pct >= 90 ? 'bg-red-500' : info.pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {!compact && (
        <span className="text-xs text-slate-400 whitespace-nowrap">
          {formatTokens(info.used)}
          {info.isUnlimited ? ' tokens' : ` / ${formatTokens(info.limit)}`}
        </span>
      )}
      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden min-w-[60px]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: info.isUnlimited ? '0%' : `${info.pct}%` }}
        />
      </div>
      {!compact && info.pct >= 90 && (
        <a
          href="/dashboard/tokens"
          className="text-xs text-red-400 hover:text-red-300 whitespace-nowrap"
        >
          Køb mere
        </a>
      )}
    </div>
  );
}
