'use client';

import { Building2, Briefcase, Users, Sparkles } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

const iconMap: Record<string, React.ElementType> = {
  building: Building2,
  briefcase: Briefcase,
  users: Users,
  sparkles: Sparkles,
};

/**
 * Color scheme matching the dashboard quick-action cards:
 * - Ejendomsdata → emerald (properties)
 * - Virksomhedsdata → blue (companies)
 * - Ejerdata → purple (owners)
 * - AI-analyse → amber (AI/map)
 */
const colorMap = [
  {
    icon: 'text-emerald-400',
    glow: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    hover: 'hover:border-emerald-500/40',
  },
  {
    icon: 'text-blue-400',
    glow: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    hover: 'hover:border-blue-500/40',
  },
  {
    icon: 'text-purple-400',
    glow: 'bg-purple-500/10',
    border: 'border-purple-500/20',
    hover: 'hover:border-purple-500/40',
  },
  {
    icon: 'text-amber-400',
    glow: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    hover: 'hover:border-amber-500/40',
  },
];

export default function Features() {
  const { lang } = useLanguage();
  const { title, subtitle, items } = translations[lang].features;

  return (
    <section id="features" className="py-24 bg-[#0f172a]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">{title}</h2>
          <p className="text-xl text-slate-400">{subtitle}</p>
        </div>

        {/* Feature grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
          {items.map((item, i) => {
            const Icon = iconMap[item.icon];
            const color = colorMap[i];
            return (
              <div
                key={item.title}
                className={`rounded-2xl border ${color.border} ${color.hover} bg-white/[0.03] p-6 hover:bg-white/[0.06] transition-all`}
              >
                <div
                  className={`w-11 h-11 rounded-xl ${color.glow} flex items-center justify-center mb-4`}
                >
                  <Icon className={color.icon} size={22} />
                </div>
                <h3 className="text-base font-bold text-white mb-2">{item.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{item.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
