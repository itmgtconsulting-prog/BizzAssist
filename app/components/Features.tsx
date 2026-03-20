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

const colorMap = [
  {
    icon: 'text-blue-400',
    glow: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    hover: 'hover:border-blue-500/40',
  },
  {
    icon: 'text-indigo-400',
    glow: 'bg-indigo-500/10',
    border: 'border-indigo-500/20',
    hover: 'hover:border-indigo-500/40',
  },
  {
    icon: 'text-purple-400',
    glow: 'bg-purple-500/10',
    border: 'border-purple-500/20',
    hover: 'hover:border-purple-500/40',
  },
  {
    icon: 'text-sky-400',
    glow: 'bg-sky-500/10',
    border: 'border-sky-500/20',
    hover: 'hover:border-sky-500/40',
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

        {/* Data sources */}
        <div className="mt-20 bg-white/[0.03] rounded-3xl p-10 border border-white/8">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm font-medium px-3 py-1.5 rounded-full mb-4">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full" />
                {lang === 'da' ? 'Datakilder' : 'Data Sources'}
              </div>
              <h3 className="text-3xl font-bold text-white mb-4">
                {lang === 'da'
                  ? 'Data fra de vigtigste kilder i Danmark'
                  : 'Data from the most important sources in Denmark'}
              </h3>
              <p className="text-slate-400 leading-relaxed">
                {lang === 'da'
                  ? 'Vi integrerer løbende nye datakilder, så du altid har adgang til de mest komplette og opdaterede data.'
                  : 'We continuously integrate new data sources so you always have access to the most complete and up-to-date data.'}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                'CVR-registret',
                'Tinglysning',
                'BBR',
                'Erhvervsstyrelsen',
                'Danmarks Statistik',
                'SKAT',
                'Boligsiden',
                'Finans Danmark',
                'OECD',
              ].map((source) => (
                <div
                  key={source}
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-xs font-medium text-slate-400 text-center hover:border-blue-500/40 hover:text-blue-400 transition-colors cursor-default"
                >
                  {source}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
