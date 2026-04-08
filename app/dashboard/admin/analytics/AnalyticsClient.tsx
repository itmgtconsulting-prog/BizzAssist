'use client';

/**
 * Admin support analytics — /dashboard/admin/analytics
 *
 * Displays aggregated statistics from the support chatbot:
 *   - Total questions, match rate, language split
 *   - Daily question volume chart (bar chart via divs)
 *   - Top unmatched questions (FAQ gaps)
 *   - Top pages generating questions
 *   - Recent unmatched questions for quick review
 *
 * Data fetched from /api/admin/support-analytics.
 * Only accessible by admin user.
 *
 * @see app/api/admin/support-analytics/route.ts — data source
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  BarChart3,
  MessageCircleQuestion,
  CheckCircle,
  XCircle,
  Globe,
  FileText,
  RefreshCw,
  Users,
  CreditCard,
  Settings,
  Bot,
  ShieldCheck,
  Wrench,
  Activity,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

// ─── Types ──────────────────────────────────────────────────────────────────

interface AnalyticsData {
  total: number;
  matched: number;
  unmatched: number;
  matchRate: number;
  langSplit: { da: number; en: number };
  dailyCounts: Record<string, { total: number; matched: number }>;
  topUnmatched: { question: string; count: number }[];
  topPages: { page: string; count: number }[];
  recentUnmatched: {
    question: string;
    lang: string;
    page: string | null;
    createdAt: string;
  }[];
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function AnalyticsClient() {
  const { lang } = useLanguage();
  const router = useRouter();
  const da = lang === 'da';

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Fetch analytics data from API. */
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/support-analytics');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // ── Translations ──
  const t = {
    back: da ? 'Tilbage' : 'Back',
    title: da ? 'Support-analyse' : 'Support Analytics',
    subtitle: da
      ? 'Chatbot-spørgsmål de seneste 30 dage'
      : 'Chatbot questions from the last 30 days',
    refresh: da ? 'Opdater' : 'Refresh',
    totalQuestions: da ? 'Spørgsmål i alt' : 'Total questions',
    matchedQuestions: da ? 'Matchede' : 'Matched',
    unmatchedQuestions: da ? 'Umatchede' : 'Unmatched',
    matchRate: da ? 'Match-rate' : 'Match rate',
    langSplit: da ? 'Sprogfordeling' : 'Language split',
    dailyVolume: da ? 'Dagligt volumen (14 dage)' : 'Daily volume (14 days)',
    topUnmatched: da ? 'Top umatchede spørgsmål' : 'Top unmatched questions',
    topPages: da ? 'Sider med flest spørgsmål' : 'Pages with most questions',
    recentUnmatched: da ? 'Seneste umatchede spørgsmål' : 'Recent unmatched questions',
    noData: da ? 'Ingen data endnu' : 'No data yet',
    loading: da ? 'Henter data…' : 'Loading data…',
    errorMsg: da ? 'Fejl ved hentning' : 'Error fetching data',
    questions: da ? 'spørgsmål' : 'questions',
    matched: da ? 'Matchet' : 'Matched',
    total: da ? 'Total' : 'Total',
  };

  // ── Daily chart data (last 14 days) ──
  const dailyEntries = data
    ? Object.entries(data.dailyCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-14)
    : [];
  const maxDaily = Math.max(1, ...dailyEntries.map(([, v]) => v.total));

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Sticky Header ─── */}
      <div className="sticky top-0 z-20 px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {t.back}
          </button>
        </div>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <BarChart3 size={22} className="text-blue-400" />
            <div>
              <h1 className="text-white text-xl font-bold">{t.title}</h1>
              <p className="text-slate-400 text-sm">{t.subtitle}</p>
            </div>
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors px-3 py-1.5 rounded-lg hover:bg-white/5 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> {t.refresh}
          </button>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 -mb-px overflow-x-auto mt-4">
          <Link
            href="/dashboard/admin/users"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Users size={14} /> {da ? 'Brugere' : 'Users'}
          </Link>
          <Link
            href="/dashboard/admin/billing"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <CreditCard size={14} /> {da ? 'Fakturering' : 'Billing'}
          </Link>
          <Link
            href="/dashboard/admin/plans"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Settings size={14} /> {da ? 'Planer' : 'Plans'}
          </Link>
          <span className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default">
            <BarChart3 size={14} /> {da ? 'Analyse' : 'Analytics'}
          </span>
          <Link
            href="/dashboard/admin/ai-media-agents"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Bot size={14} /> {da ? 'AI-agenter' : 'AI Agents'}
          </Link>
          <Link
            href="/dashboard/admin/security"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <ShieldCheck size={14} /> {da ? 'Sikkerhed' : 'Security'}
          </Link>
          <Link
            href="/dashboard/admin/service-manager"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Wrench size={14} /> Service Manager
          </Link>
          <Link
            href="/dashboard/admin/service-management"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Activity size={14} /> {da ? 'Infrastruktur' : 'Infrastructure'}
          </Link>
        </div>
      </div>

      {/* ─── Content ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-6">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* Loading state */}
          {loading && !data && (
            <div className="text-center py-20">
              <RefreshCw size={24} className="animate-spin text-blue-400 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">{t.loading}</p>
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              <p className="text-red-400 text-sm">
                {t.errorMsg}: {error}
              </p>
            </div>
          )}

          {data && (
            <>
              {/* KPI cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2 text-blue-400 opacity-70">
                    <MessageCircleQuestion size={18} />
                  </div>
                  <p className="text-2xl font-bold text-white">{data.total}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.totalQuestions}</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2 text-emerald-400 opacity-70">
                    <CheckCircle size={18} />
                  </div>
                  <p className="text-2xl font-bold text-white">{data.matched}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.matchedQuestions}</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2 text-red-400 opacity-70">
                    <XCircle size={18} />
                  </div>
                  <p className="text-2xl font-bold text-white">{data.unmatched}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.unmatchedQuestions}</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-700/40 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2 text-purple-400 opacity-70">
                    <BarChart3 size={18} />
                  </div>
                  <p className="text-2xl font-bold text-white">{data.matchRate}%</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.matchRate}</p>
                </div>
              </div>

              {/* Language split */}
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <Globe size={15} className="text-blue-400" /> {t.langSplit}
                </h3>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>Dansk</span>
                      <span>{data.langSplit.da}</span>
                    </div>
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all"
                        style={{
                          width: `${data.total > 0 ? (data.langSplit.da / data.total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>English</span>
                      <span>{data.langSplit.en}</span>
                    </div>
                    <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-all"
                        style={{
                          width: `${data.total > 0 ? (data.langSplit.en / data.total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Daily volume chart */}
              {dailyEntries.length > 0 && (
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                    <BarChart3 size={15} className="text-blue-400" /> {t.dailyVolume}
                  </h3>
                  <div className="flex items-end gap-1.5 h-32">
                    {dailyEntries.map(([day, counts]) => (
                      <div key={day} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full relative" style={{ height: '100px' }}>
                          {/* Total bar */}
                          <div
                            className="absolute bottom-0 left-0 right-0 bg-slate-600/50 rounded-t transition-all"
                            style={{ height: `${(counts.total / maxDaily) * 100}%` }}
                          />
                          {/* Matched overlay */}
                          <div
                            className="absolute bottom-0 left-0 right-0 bg-blue-500/60 rounded-t transition-all"
                            style={{ height: `${(counts.matched / maxDaily) * 100}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-slate-600 whitespace-nowrap">
                          {day.slice(5)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-4 mt-3 text-xs text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 bg-slate-600/50 rounded" /> {t.total}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 bg-blue-500/60 rounded" /> {t.matched}
                    </span>
                  </div>
                </div>
              )}

              {/* Two-column: top unmatched + top pages */}
              <div className="grid md:grid-cols-2 gap-6">
                {/* Top unmatched questions */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                    <XCircle size={15} className="text-red-400" /> {t.topUnmatched}
                  </h3>
                  {data.topUnmatched.length === 0 ? (
                    <p className="text-slate-600 text-xs">{t.noData}</p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {data.topUnmatched.map((item, i) => (
                        <div key={i} className="flex items-start justify-between gap-3">
                          <p className="text-slate-300 text-xs leading-relaxed flex-1 line-clamp-2">
                            {item.question}
                          </p>
                          <span className="text-xs text-slate-500 whitespace-nowrap font-mono">
                            {item.count}x
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Top pages */}
                <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                    <FileText size={15} className="text-amber-400" /> {t.topPages}
                  </h3>
                  {data.topPages.length === 0 ? (
                    <p className="text-slate-600 text-xs">{t.noData}</p>
                  ) : (
                    <div className="space-y-2">
                      {data.topPages.map((item, i) => (
                        <div key={i} className="flex items-center justify-between gap-3">
                          <span className="text-slate-300 text-xs truncate flex-1">
                            {item.page}
                          </span>
                          <span className="text-xs text-slate-500 whitespace-nowrap font-mono">
                            {item.count}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Recent unmatched */}
              <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                  <MessageCircleQuestion size={15} className="text-amber-400" /> {t.recentUnmatched}
                </h3>
                {data.recentUnmatched.length === 0 ? (
                  <p className="text-slate-600 text-xs">{t.noData}</p>
                ) : (
                  <div className="space-y-3">
                    {data.recentUnmatched.map((item, i) => (
                      <div key={i} className="flex items-start gap-3 text-xs">
                        <span className="text-slate-600 whitespace-nowrap font-mono">
                          {new Date(item.createdAt).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 uppercase text-[10px]">
                          {item.lang}
                        </span>
                        <p className="text-slate-300 leading-relaxed flex-1">{item.question}</p>
                        {item.page && (
                          <span className="text-slate-600 truncate max-w-[120px]">{item.page}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
