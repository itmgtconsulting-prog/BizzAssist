/**
 * AiActionButton — reusable AI action button with pre-flight checks.
 *
 * BIZZ-2017: Wrapper that checks subscription status and token budget
 * BEFORE executing an AI action. Shows confirmation modal with token
 * estimate for expensive operations.
 *
 * @module app/components/AiActionButton
 */

'use client';

import { useState, useCallback } from 'react';
import { Sparkles, Loader2, AlertTriangle } from 'lucide-react';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { useLanguage } from '@/app/context/LanguageContext';

interface AiActionButtonProps {
  /** Callback executed after pre-flight checks pass */
  onConfirm: () => void | Promise<void>;
  /** Estimated token cost (shown in confirmation for large values) */
  estimatedTokens?: number;
  /** Button label */
  label?: string;
  /** Button variant */
  variant?: 'primary' | 'secondary';
  /** Disabled state */
  disabled?: boolean;
  /** Show confirmation modal for expensive operations (> threshold tokens) */
  confirmThreshold?: number;
  /** Additional CSS classes */
  className?: string;
  /** Icon size */
  iconSize?: number;
  /** Children override label */
  children?: React.ReactNode;
}

/**
 * AiActionButton — pre-flight subscription + token check before AI action.
 *
 * @param props - Button configuration
 * @returns Button with optional confirmation modal
 */
export default function AiActionButton({
  onConfirm,
  estimatedTokens,
  label,
  variant = 'primary',
  disabled = false,
  confirmThreshold = 10000,
  className = '',
  iconSize = 14,
  children,
}: AiActionButtonProps) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const { subscription: sub, isFunctional, isAdmin } = useSubscription();

  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Calculate available tokens */
  const tokensUsed = (sub?.tokensUsedThisMonth as number) ?? 0;
  const tokenLimit = (sub as unknown as Record<string, unknown> | null)?.aiTokensPerMonth as
    | number
    | undefined;
  const availableTokens =
    tokenLimit === -1 ? Infinity : tokenLimit != null ? Math.max(0, tokenLimit - tokensUsed) : 0;

  /** Pre-flight check + execute */
  const handleClick = useCallback(async () => {
    setError(null);

    // Check subscription is functional (admin bypasses)
    if (!isAdmin && !isFunctional) {
      setError(da ? 'Aktivt abonnement påkrævet' : 'Active subscription required');
      return;
    }

    // Check token budget (skip for admins and unlimited plans)
    if (
      !isAdmin &&
      availableTokens !== Infinity &&
      estimatedTokens &&
      estimatedTokens > availableTokens
    ) {
      setError(
        da
          ? `Ikke nok tokens (${availableTokens.toLocaleString('da-DK')} tilbage, estimeret ${estimatedTokens.toLocaleString('da-DK')} nødvendige)`
          : `Not enough tokens (${availableTokens.toLocaleString()} remaining, estimated ${estimatedTokens.toLocaleString()} needed)`
      );
      return;
    }

    // Show confirmation for expensive operations
    if (estimatedTokens && estimatedTokens > confirmThreshold && !showConfirm) {
      setShowConfirm(true);
      return;
    }

    // Execute
    setShowConfirm(false);
    setLoading(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ukendt fejl');
    } finally {
      setLoading(false);
    }
  }, [
    isAdmin,
    isFunctional,
    availableTokens,
    estimatedTokens,
    confirmThreshold,
    showConfirm,
    onConfirm,
    da,
  ]);

  const baseStyles =
    variant === 'primary'
      ? 'bg-blue-600 hover:bg-blue-500 text-white'
      : 'bg-white/10 hover:bg-white/15 text-slate-300';

  return (
    <div className="relative inline-flex flex-col items-start">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || loading}
        className={`inline-flex items-center gap-1.5 font-medium text-sm px-4 py-2 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${baseStyles} ${className}`}
      >
        {loading ? (
          <Loader2 size={iconSize} className="animate-spin" />
        ) : (
          <Sparkles size={iconSize} />
        )}
        {children || label || (da ? 'AI-handling' : 'AI action')}
      </button>

      {/* Error message */}
      {error && (
        <div className="mt-1.5 flex items-start gap-1.5 text-xs text-red-400 max-w-xs">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Confirmation modal for expensive operations */}
      {showConfirm && (
        <div className="absolute top-full left-0 mt-2 z-50 bg-[#1e293b] border border-white/10 rounded-xl p-4 shadow-2xl min-w-[280px]">
          <p className="text-white text-sm font-medium mb-2">
            {da ? 'Bekræft AI-handling' : 'Confirm AI action'}
          </p>
          <p className="text-slate-400 text-xs mb-3">
            {da
              ? `Denne handling bruger ca. ${estimatedTokens?.toLocaleString('da-DK')} tokens. Du har ${availableTokens === Infinity ? 'ubegrænset' : availableTokens.toLocaleString('da-DK')} tilbage.`
              : `This action uses approximately ${estimatedTokens?.toLocaleString()} tokens. You have ${availableTokens === Infinity ? 'unlimited' : availableTokens.toLocaleString()} remaining.`}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClick}
              className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg"
            >
              {da ? 'Bekræft' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => setShowConfirm(false)}
              className="text-slate-400 hover:text-white text-xs px-3 py-1.5"
            >
              {da ? 'Annullér' : 'Cancel'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
