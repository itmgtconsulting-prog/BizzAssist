'use client';

import { TrendingUp, Shield, Search, Truck, BarChart3, Home } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

const icons = [TrendingUp, Shield, Search, Truck, BarChart3, Home];

export default function UseCases() {
  const { lang } = useLanguage();
  const { title, subtitle, items } = translations[lang].useCases;

  return (
    <section id="use-cases" className="py-24 bg-[#0a1020]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">{title}</h2>
          <p className="text-xl text-slate-400">{subtitle}</p>
        </div>

        {/* Use case grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {items.map((item, i) => {
            const Icon = icons[i];
            return (
              <div
                key={item.title}
                className="group bg-white/[0.03] border border-white/8 rounded-2xl p-6 hover:border-blue-500/40 hover:bg-white/[0.06] transition-all cursor-pointer"
              >
                <div className="w-10 h-10 bg-blue-500/10 group-hover:bg-blue-500/20 rounded-xl flex items-center justify-center mb-4 transition-colors">
                  <Icon className="text-blue-400" size={20} />
                </div>
                <h3 className="text-base font-bold text-white mb-2">{item.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{item.description}</p>
              </div>
            );
          })}
        </div>

        {/* AI Chat preview */}
        <div className="mt-16 bg-white/[0.03] border border-white/8 rounded-3xl p-8 md:p-12">
          <div className="grid lg:grid-cols-2 gap-10 items-center">
            <div>
              <div className="inline-flex items-center gap-2 bg-blue-600/20 border border-blue-500/20 text-blue-400 text-sm font-medium px-3 py-1.5 rounded-full mb-4">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
                AI Copilot
              </div>
              <h3 className="text-3xl font-bold text-white mb-4">
                {lang === 'da'
                  ? 'Stil spørgsmål. Få svar med det samme.'
                  : 'Ask questions. Get answers instantly.'}
              </h3>
              <p className="text-slate-400 leading-relaxed">
                {lang === 'da'
                  ? 'Vores AI-assistent har adgang til alle data på platformen og kan besvare komplekse spørgsmål om virksomheder, ejendomme og personer på sekunder.'
                  : 'Our AI assistant has access to all data on the platform and can answer complex questions about companies, properties and individuals in seconds.'}
              </p>
            </div>
            {/* Chat mockup */}
            <div className="bg-[#0f172a] rounded-2xl p-5 space-y-4 border border-white/10">
              {[
                {
                  type: 'user',
                  text:
                    lang === 'da'
                      ? 'Analysér Novo Nordisks konkurrenter i Danmark'
                      : "Analyse Novo Nordisk's competitors in Denmark",
                },
                {
                  type: 'ai',
                  text:
                    lang === 'da'
                      ? 'Novo Nordisks primære danske konkurrenter inkluderer Leo Pharma (omsætning: 15 mia. DKK), Genmab, og Bavarian Nordic. Leo Pharma har den stærkeste vækst med +12% YoY...'
                      : "Novo Nordisk's primary Danish competitors include Leo Pharma (revenue: DKK 15bn), Genmab, and Bavarian Nordic. Leo Pharma has the strongest growth at +12% YoY...",
                },
                {
                  type: 'user',
                  text: lang === 'da' ? 'Hvem ejer Leo Pharma?' : 'Who owns Leo Pharma?',
                },
                {
                  type: 'ai',
                  text:
                    lang === 'da'
                      ? 'Leo Pharma er 100% ejet af LEO Fondet, som er en dansk erhvervsdrivende fond stiftet i 1984...'
                      : 'Leo Pharma is 100% owned by the LEO Foundation, a Danish business foundation established in 1984...',
                },
              ].map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                      msg.type === 'user' ? 'bg-blue-600 text-white' : 'bg-white/8 text-slate-300'
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
              <div className="flex gap-2 pt-2">
                <input
                  type="text"
                  placeholder={lang === 'da' ? 'Stil et spørgsmål...' : 'Ask a question...'}
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-slate-400 placeholder-slate-600 focus:outline-none"
                  readOnly
                />
                <button className="bg-blue-600 text-white rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-blue-500 transition-colors">
                  {lang === 'da' ? 'Send' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
