'use client';

/**
 * SessionTimeoutWarning — modal der vises 5 minutter inden idle-logout.
 *
 * Viser en nedtælling og en "Fortsæt session"-knap.
 * Kalder `onExtend()` når brugeren klikker for at nulstille timeren.
 * Kalder `onTimeout()` når nedtællingen rammer 0 (automatisk logout).
 *
 * @param show        - Vis/skjul dialogen
 * @param secondsLeft - Sekunder tilbage inden automatisk logout
 * @param onExtend    - Nulstil idle-timer og skjul dialogen
 * @param onTimeout   - Log brugeren ud (kaldes ved 0 sekunder)
 */

import React, { useEffect } from 'react';
import { Clock, LogOut } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface Props {
  show: boolean;
  secondsLeft: number;
  onExtend: () => void;
  onTimeout: () => void;
}

/**
 * Formaterer sekunder til mm:ss streng.
 *
 * @param secs - Antal sekunder
 * @returns Formateret streng, fx "04:32"
 */
function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** BIZZ-211: memoized to prevent re-renders from parent layout state changes */
const SessionTimeoutWarning = React.memo(function SessionTimeoutWarning({
  show,
  secondsLeft,
  onExtend,
  onTimeout,
}: Props) {
  const { lang } = useLanguage();

  // Automatisk log ud når nedtællingen rammer 0
  useEffect(() => {
    if (show && secondsLeft <= 0) {
      onTimeout();
    }
  }, [show, secondsLeft, onTimeout]);

  if (!show) return null;

  const da = lang === 'da';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl max-w-sm w-full mx-4">
        {/* Ikon */}
        <div className="flex justify-center mb-5">
          <div className="w-16 h-16 bg-amber-500/10 rounded-full flex items-center justify-center">
            <Clock size={32} className="text-amber-400" />
          </div>
        </div>

        {/* Titel */}
        <h2 className="text-xl font-bold text-white text-center mb-2">
          {da ? 'Din session udløber snart' : 'Your session is about to expire'}
        </h2>

        {/* Besked */}
        <p className="text-slate-400 text-sm text-center mb-6">
          {da ? 'Du logges automatisk ud om:' : 'You will be automatically signed out in:'}
        </p>

        {/* Nedtælling */}
        <div className="bg-black/30 rounded-xl py-4 px-6 text-center mb-6">
          <span className="text-4xl font-mono font-bold text-amber-400 tabular-nums">
            {formatTime(secondsLeft)}
          </span>
        </div>

        {/* Knapper */}
        <div className="flex flex-col gap-3">
          <button
            onClick={onExtend}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-colors"
          >
            {da ? 'Fortsæt session' : 'Continue session'}
          </button>
          <button
            onClick={onTimeout}
            className="w-full flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-slate-200 font-medium py-3 rounded-xl transition-colors text-sm"
          >
            <LogOut size={14} />
            {da ? 'Log ud nu' : 'Sign out now'}
          </button>
        </div>
      </div>
    </div>
  );
});

export default SessionTimeoutWarning;
