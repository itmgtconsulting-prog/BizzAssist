'use client';

import { useState, useEffect } from 'react';
import { createBrowserClient } from '@supabase/ssr';

/**
 * Lightweight hook that checks if the user is authenticated.
 * Used by hybrid hooks to decide Supabase vs localStorage path.
 *
 * @returns {{ isAuthenticated: boolean, userId: string | null, loading: boolean }}
 */
export function useAuth() {
  const [state, setState] = useState<{
    isAuthenticated: boolean;
    userId: string | null;
    loading: boolean;
  }>({ isAuthenticated: false, userId: null, loading: true });

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    supabase.auth.getUser().then(({ data: { user } }) => {
      setState({
        isAuthenticated: !!user,
        userId: user?.id ?? null,
        loading: false,
      });
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({
        isAuthenticated: !!session?.user,
        userId: session?.user?.id ?? null,
        loading: false,
      });
    });

    return () => subscription.unsubscribe();
  }, []);

  return state;
}
