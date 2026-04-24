'use client';

/**
 * AcceptClient — accept team invitation flow.
 *
 * BIZZ-271: Bruger lander her fra invitation-email. Hvis ikke logget ind
 * redirectes til /login?next=/team/accept?token=... — efter login kommer
 * user tilbage og POST /api/team/accept kaldes med token.
 *
 * @module app/team/accept/AcceptClient
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface AcceptClientProps {
  token: string;
}

type Status = 'idle' | 'accepting' | 'success' | 'error' | 'need_login';

export default function AcceptClient({ token }: AcceptClientProps) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const accept = useCallback(async () => {
    if (!token) {
      setStatus('error');
      setErrorMsg('Ingen invitation-token i URL.');
      return;
    }
    setStatus('accepting');
    try {
      const r = await fetch('/api/team/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (r.status === 401) {
        setStatus('need_login');
        return;
      }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus('error');
        setErrorMsg(body.error ?? 'Ukendt fejl');
        return;
      }
      setStatus('success');
      // Redirect til dashboard efter 1.5 sekund
      setTimeout(() => router.push('/dashboard'), 1500);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Netværksfejl');
    }
  }, [token, router]);

  useEffect(() => {
    // Tjek om user er logget ind — hvis ikke, redirect til login med return-URL
    void (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        const next = encodeURIComponent(`/team/accept?token=${encodeURIComponent(token)}`);
        router.push(`/login?next=${next}`);
        return;
      }
      void accept();
    })();
  }, [accept, router, token]);

  return (
    <div className="min-h-screen bg-[#0a1020] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#0f172a] border border-slate-700/50 rounded-xl p-6 text-center">
        {status === 'idle' || status === 'accepting' ? (
          <>
            <Loader2 size={32} className="mx-auto text-blue-400 animate-spin mb-3" />
            <h1 className="text-white text-lg font-semibold mb-1">Accepterer invitation…</h1>
            <p className="text-slate-400 text-sm">
              Vi tilføjer dig til teamet. Dette tager kun et øjeblik.
            </p>
          </>
        ) : status === 'success' ? (
          <>
            <CheckCircle2 size={32} className="mx-auto text-emerald-400 mb-3" />
            <h1 className="text-white text-lg font-semibold mb-1">Velkommen!</h1>
            <p className="text-slate-400 text-sm">
              Du er nu en del af teamet. Viderestiller til dit dashboard…
            </p>
          </>
        ) : status === 'need_login' ? (
          <>
            <AlertTriangle size={32} className="mx-auto text-amber-400 mb-3" />
            <h1 className="text-white text-lg font-semibold mb-1">Log ind for at fortsætte</h1>
            <p className="text-slate-400 text-sm mb-4">
              Du skal være logget ind for at acceptere invitationen.
            </p>
            <Link
              href={`/login?next=${encodeURIComponent(`/team/accept?token=${encodeURIComponent(token)}`)}`}
              className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium"
            >
              Log ind
            </Link>
          </>
        ) : (
          <>
            <AlertTriangle size={32} className="mx-auto text-rose-400 mb-3" />
            <h1 className="text-white text-lg font-semibold mb-1">
              Kunne ikke acceptere invitation
            </h1>
            <p className="text-slate-400 text-sm mb-4">{errorMsg}</p>
            <Link
              href="/dashboard"
              className="inline-block px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm"
            >
              Til dashboard
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
