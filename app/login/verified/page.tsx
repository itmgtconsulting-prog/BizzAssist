/**
 * Email verification success page — app/login/verified/page.tsx
 *
 * Shown after the user clicks the verification link in their signup email
 * and Supabase successfully confirms their email address.
 *
 * Flow: signup → /login/verify-email (pending) → click email link
 *       → /auth/callback (exchanges code) → /login/verified (this page)
 *
 * @returns A confirmation screen with a login button.
 */

import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';

export default function VerifiedPage() {
  return (
    <div className="min-h-screen bg-[#0f172a] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl text-center">
          {/* Green checkmark icon */}
          <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 size={36} className="text-emerald-400" />
          </div>

          <h1 className="text-2xl font-bold text-white mb-3">Din e-mail er bekræftet!</h1>

          <p className="text-slate-400 text-sm leading-relaxed mb-8">
            Din konto er nu aktiveret. Du kan logge ind på BizzAssist.
          </p>

          <Link
            href="/login"
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Log ind
          </Link>
        </div>
      </div>
    </div>
  );
}
