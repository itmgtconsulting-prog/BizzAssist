'use client';

import { useState } from 'react';
import {
  Search,
  TrendingUp,
  Building2,
  Users,
  Briefcase,
  ArrowRight,
  Send,
  Sparkles,
  Clock,
  ChevronRight,
} from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';

const recentSearches = [
  { type: 'company', name: 'Novo Nordisk A/S', cvr: '24256790', info: '~65.000 ansatte' },
  { type: 'company', name: 'A.P. Møller - Mærsk A/S', cvr: '22756214', info: '~95.000 ansatte' },
  { type: 'person', name: 'Lars Fruergaard Jørgensen', info: 'CEO, Novo Nordisk' },
  { type: 'property', name: 'H.C. Andersens Boulevard 27', info: 'København V, 2.450 m²' },
];

const quickStats = [
  { labelDa: 'Søgninger i dag', labelEn: 'Searches today', value: '24', trend: '+8%' },
  { labelDa: 'Gemte rapporter', labelEn: 'Saved reports', value: '7', trend: '+2' },
  { labelDa: 'AI forespørgsler', labelEn: 'AI queries', value: '12', trend: '+5' },
  { labelDa: 'Overvågede enheder', labelEn: 'Monitored entities', value: '18', trend: '+1' },
];

/** A single message in the AI chat panel */
interface ChatMessage {
  role: 'ai' | 'user';
  text: { da: string; en: string };
}

const initialMessages: ChatMessage[] = [
  {
    role: 'ai',
    text: {
      da: 'Hej! Jeg er din BizzAssist AI-assistent. Jeg kan hjælpe dig med at analysere virksomheder, ejendomme og personer. Hvad vil du gerne vide?',
      en: "Hi! I'm your BizzAssist AI assistant. I can help you analyse companies, properties and individuals. What would you like to know?",
    },
  },
];

export default function DashboardPage() {
  const { lang } = useLanguage();
  const [chatInput, setChatInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [isTyping, setIsTyping] = useState(false);

  const sendMessage = () => {
    if (!chatInput.trim()) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setMessages((prev) => [...prev, { role: 'user', text: { da: userMsg, en: userMsg } }]);
    setIsTyping(true);
    setTimeout(() => {
      setIsTyping(false);
      setMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          text: {
            da: 'Jeg analyserer din forespørgsel og henter relevante data fra vores databaser. I en fuldt implementeret version ville jeg give dig detaljerede, datadrevne svar baseret på CVR, regnskaber, ejendomsdata og meget mere.',
            en: "I'm analysing your query and fetching relevant data from our databases. In a fully implemented version, I'd give you detailed, data-driven answers based on CVR, financial statements, property data and much more.",
          },
        },
      ]);
    }, 1500);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-bold text-white">
          {lang === 'da' ? 'God morgen, Jakob' : 'Good morning, Jakob'}
        </h1>
        <p className="text-slate-400 mt-1">
          {lang === 'da'
            ? 'Her er et overblik over din aktivitet og de seneste data.'
            : "Here's an overview of your activity and the latest data."}
        </p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {quickStats.map((stat) => (
          <div key={stat.labelDa} className="bg-white/5 border border-white/8 rounded-2xl p-5">
            <div className="text-sm text-slate-400 mb-1">
              {lang === 'da' ? stat.labelDa : stat.labelEn}
            </div>
            <div className="flex items-end justify-between">
              <span className="text-3xl font-bold text-white">{stat.value}</span>
              <span className="text-xs text-emerald-400 font-medium bg-emerald-500/10 px-2 py-1 rounded-full">
                {stat.trend}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Main grid */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Recent searches (2/3) */}
        <div className="lg:col-span-2 space-y-4">
          {/* Search bar */}
          <div className="bg-white/5 border border-white/8 rounded-2xl p-4">
            <div className="relative flex items-center">
              <Search className="absolute left-4 text-slate-500" size={18} />
              <input
                type="text"
                placeholder={
                  lang === 'da'
                    ? 'Søg på virksomhed, CVR-nummer, person eller adresse...'
                    : 'Search company, CVR number, person or address...'
                }
                className="w-full pl-12 pr-32 py-3.5 bg-white/5 border border-white/10 rounded-xl text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500 text-sm transition-colors"
              />
              <Link
                href="/dashboard/search"
                className="absolute right-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5"
              >
                {lang === 'da' ? 'Søg' : 'Search'}
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>

          {/* Recent searches */}
          <div className="bg-white/5 border border-white/8 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/8">
              <div className="flex items-center gap-2">
                <Clock size={16} className="text-slate-500" />
                <h2 className="font-semibold text-white text-sm">
                  {lang === 'da' ? 'Seneste søgninger' : 'Recent searches'}
                </h2>
              </div>
              <Link
                href="/dashboard/search"
                className="text-blue-400 text-xs font-medium hover:text-blue-300"
              >
                {lang === 'da' ? 'Se alle' : 'View all'}
              </Link>
            </div>
            <div className="divide-y divide-white/5">
              {recentSearches.map((item, i) => {
                const Icon =
                  item.type === 'company' ? Briefcase : item.type === 'person' ? Users : Building2;
                const color =
                  item.type === 'company'
                    ? 'bg-blue-500/10 text-blue-400'
                    : item.type === 'person'
                      ? 'bg-purple-500/10 text-purple-400'
                      : 'bg-emerald-500/10 text-emerald-400';
                return (
                  <div
                    key={i}
                    className="flex items-center gap-4 px-6 py-4 hover:bg-white/5 cursor-pointer transition-colors group"
                  >
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${color}`}
                    >
                      <Icon size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-slate-200 text-sm truncate">{item.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {item.cvr ? `CVR: ${item.cvr} · ` : ''}
                        {item.info}
                      </div>
                    </div>
                    <ChevronRight
                      size={16}
                      className="text-slate-600 group-hover:text-slate-400 transition-colors shrink-0"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quick actions */}
          <div className="grid grid-cols-3 gap-4">
            {[
              {
                icon: Briefcase,
                labelDa: 'Virksomheder',
                labelEn: 'Companies',
                href: '/dashboard/companies',
                color: 'bg-blue-500/10 text-blue-400',
              },
              {
                icon: Users,
                labelDa: 'Personer',
                labelEn: 'People',
                href: '/dashboard/people',
                color: 'bg-purple-500/10 text-purple-400',
              },
              {
                icon: Building2,
                labelDa: 'Ejendomme',
                labelEn: 'Properties',
                href: '/dashboard/properties',
                color: 'bg-emerald-500/10 text-emerald-400',
              },
            ].map((action) => {
              const Icon = action.icon;
              return (
                <Link
                  key={action.href}
                  href={action.href}
                  className="bg-white/5 border border-white/8 hover:border-blue-500/40 hover:bg-white/8 rounded-2xl p-5 flex flex-col items-center gap-3 transition-all group"
                >
                  <div
                    className={`w-12 h-12 rounded-xl flex items-center justify-center ${action.color}`}
                  >
                    <Icon size={22} />
                  </div>
                  <span className="text-sm font-medium text-slate-400 group-hover:text-white transition-colors">
                    {lang === 'da' ? action.labelDa : action.labelEn}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* AI Chat (1/3) */}
        <div
          className="bg-[#0f172a] border border-white/8 rounded-2xl flex flex-col overflow-hidden"
          style={{ height: '520px' }}
        >
          <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
            <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
              <Sparkles size={16} className="text-white" />
            </div>
            <div>
              <div className="text-white text-sm font-semibold">AI Assistent</div>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full" />
                <span className="text-xs text-slate-500">{lang === 'da' ? 'Aktiv' : 'Active'}</span>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white/10 text-slate-300'
                  }`}
                >
                  {msg.text[lang]}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-white/10 rounded-2xl px-4 py-3 flex gap-1">
                  <span
                    className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                    style={{ animationDelay: '0ms' }}
                  />
                  <span
                    className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                    style={{ animationDelay: '150ms' }}
                  />
                  <span
                    className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"
                    style={{ animationDelay: '300ms' }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="px-4 pb-2 flex gap-2 overflow-x-auto">
            {[
              lang === 'da' ? 'Analysér Maersk' : 'Analyse Maersk',
              lang === 'da' ? 'Top 5 vækstvirksomheder' : 'Top 5 growth companies',
              lang === 'da' ? 'Ejendomspriser i KBH' : 'Property prices in CPH',
            ].map((prompt) => (
              <button
                key={prompt}
                onClick={() => setChatInput(prompt)}
                className="shrink-0 text-xs text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-full transition-all whitespace-nowrap"
              >
                {prompt}
              </button>
            ))}
          </div>

          <div className="px-4 pb-4 pt-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder={lang === 'da' ? 'Stil et spørgsmål...' : 'Ask a question...'}
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                onClick={sendMessage}
                className="bg-blue-600 hover:bg-blue-500 text-white rounded-xl px-3 py-2.5 transition-colors"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Market trends */}
      <div className="bg-white/5 border border-white/8 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <TrendingUp size={18} className="text-blue-400" />
            <h2 className="font-semibold text-white">
              {lang === 'da' ? 'Markedsoverblik' : 'Market Overview'}
            </h2>
          </div>
          <span className="text-xs text-slate-500">
            {lang === 'da' ? 'Opdateret: i dag' : 'Updated: today'}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {[
            { sector: lang === 'da' ? 'Teknologi' : 'Technology', growth: '+14.2%', trend: 'up' },
            { sector: lang === 'da' ? 'Sundhed' : 'Healthcare', growth: '+8.7%', trend: 'up' },
            { sector: lang === 'da' ? 'Ejendomme' : 'Real Estate', growth: '+3.1%', trend: 'up' },
            { sector: lang === 'da' ? 'Energi' : 'Energy', growth: '-2.4%', trend: 'down' },
          ].map((item) => (
            <div key={item.sector} className="space-y-2">
              <div className="text-sm font-medium text-slate-400">{item.sector}</div>
              <div
                className={`text-2xl font-bold ${item.trend === 'up' ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {item.growth}
              </div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${item.trend === 'up' ? 'bg-emerald-500' : 'bg-red-500'}`}
                  style={{ width: item.trend === 'up' ? '70%' : '30%' }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
