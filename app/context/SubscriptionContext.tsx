'use client';

/**
 * SubscriptionContext — server-authoritative subscription state.
 *
 * Replaces all localStorage-based subscription storage with an in-memory
 * React Context populated exclusively from the server (/api/subscription).
 * This is enterprise-compliant: no sensitive subscription data persists
 * in the browser beyond the session.
 *
 * Populated by DashboardLayout after authenticating with Supabase.
 * Consumed by SubscriptionGate, AIChatPanel, Settings, etc.
 *
 * @module app/context/SubscriptionContext
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { UserSubscription } from '@/app/lib/subscriptions';

// ─── Context shape ──────────────────────────────────────────────────────────

interface SubscriptionContextValue {
  /** Current subscription (null = not loaded or no subscription) */
  subscription: UserSubscription | null;
  /** Whether the subscription has been checked (loading gate) */
  checked: boolean;
  /** Whether the user is an admin (bypasses subscription gates) */
  isAdmin: boolean;
  /** Whether the subscription is functionally active (paid/trial/free) */
  isFunctional: boolean;
  /** Update subscription in-memory (e.g. after token usage) */
  setSubscription: (sub: UserSubscription | null) => void;
  /** Update token usage count after AI chat */
  addTokenUsage: (tokens: number) => void;
  /** Full initialization from dashboard layout */
  initialize: (opts: {
    subscription: UserSubscription | null;
    isAdmin: boolean;
    isFunctional: boolean;
  }) => void;
}

const SubscriptionContext = createContext<SubscriptionContextValue>({
  subscription: null,
  checked: false,
  isAdmin: false,
  isFunctional: false,
  setSubscription: () => {},
  addTokenUsage: () => {},
  initialize: () => {},
});

// ─── Provider ───────────────────────────────────────────────────────────────

/**
 * Provides subscription state to the component tree.
 * Must wrap all dashboard content.
 *
 * @param children - Child components
 */
export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const [subscription, setSubscription] = useState<UserSubscription | null>(null);
  const [checked, setChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isFunctional, setIsFunctional] = useState(false);

  /** Initialize all subscription state at once (called by dashboard layout) */
  const initialize = useCallback(
    (opts: { subscription: UserSubscription | null; isAdmin: boolean; isFunctional: boolean }) => {
      setSubscription(opts.subscription);
      setIsAdmin(opts.isAdmin);
      setIsFunctional(opts.isFunctional);
      setChecked(true);
    },
    []
  );

  /** Increment token usage counter in-memory */
  const addTokenUsage = useCallback((tokens: number) => {
    if (tokens <= 0) return;
    setSubscription((prev) => {
      if (!prev) return prev;
      return { ...prev, tokensUsedThisMonth: prev.tokensUsedThisMonth + tokens };
    });
  }, []);

  return (
    <SubscriptionContext.Provider
      value={{
        subscription,
        checked,
        isAdmin,
        isFunctional,
        setSubscription,
        addTokenUsage,
        initialize,
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Access subscription state from any component inside DashboardLayout.
 *
 * @returns SubscriptionContextValue
 */
export function useSubscription(): SubscriptionContextValue {
  return useContext(SubscriptionContext);
}
