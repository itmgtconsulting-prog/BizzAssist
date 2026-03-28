'use client';

/**
 * Følg-tooltip — info-popover der vises ved Følg-knappen.
 *
 * Forklarer brugeren hvad der overvåges og hvornår de får besked.
 * Vises som en pop-ned boks til højre for Følg-knappen.
 *
 * @param lang - Sprog ('da' | 'en')
 * @param visible - Om tooltippet er synligt
 */

import { Building2, TrendingUp, KeyRound, Clock } from 'lucide-react';

interface FoelgTooltipProps {
  /** Sprog */
  lang: 'da' | 'en';
  /** Om tooltippet er synligt */
  visible: boolean;
}

/**
 * Informations-popover for Følg-funktionen.
 * Viser hvilke dataændringer der udløser notifikationer.
 */
export default function FoelgTooltip({ lang, visible }: FoelgTooltipProps) {
  if (!visible) return null;

  const items =
    lang === 'da'
      ? [
          {
            icon: <Building2 size={13} />,
            titel: 'BBR-data',
            beskrivelse: 'Areal, byggeår, status, etager, anvendelse',
          },
          {
            icon: <TrendingUp size={13} />,
            titel: 'Vurdering',
            beskrivelse: 'Ny ejendomsværdi eller grundværdi',
          },
          {
            icon: <KeyRound size={13} />,
            titel: 'Ejerskifte',
            beskrivelse: 'Ny ejer registreret på ejendommen',
          },
        ]
      : [
          {
            icon: <Building2 size={13} />,
            titel: 'BBR data',
            beskrivelse: 'Area, build year, status, floors, usage',
          },
          {
            icon: <TrendingUp size={13} />,
            titel: 'Valuation',
            beskrivelse: 'New property or land value',
          },
          {
            icon: <KeyRound size={13} />,
            titel: 'Ownership',
            beskrivelse: 'New owner registered on the property',
          },
        ];

  return (
    <div className="absolute right-0 top-full mt-2 w-72 bg-[#1e293b] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 duration-200">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10">
        <p className="text-white text-sm font-semibold">
          {lang === 'da' ? 'Du får besked ved ændringer i:' : 'You will be notified of changes in:'}
        </p>
      </div>

      {/* Data-typer */}
      <div className="px-4 py-3 space-y-3">
        {items.map((item) => (
          <div key={item.titel} className="flex items-start gap-3">
            <div className="w-7 h-7 bg-blue-600/20 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-blue-400">{item.icon}</span>
            </div>
            <div>
              <p className="text-white text-xs font-medium">{item.titel}</p>
              <p className="text-slate-400 text-[11px] leading-relaxed">{item.beskrivelse}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Timing */}
      <div className="px-4 py-2.5 bg-slate-800/50 border-t border-white/5 flex items-center gap-2">
        <Clock size={12} className="text-slate-500" />
        <p className="text-slate-500 text-[11px]">
          {lang === 'da'
            ? 'Tjekkes automatisk hver nat kl. 03:00'
            : 'Checked automatically every night at 03:00'}
        </p>
      </div>
    </div>
  );
}
