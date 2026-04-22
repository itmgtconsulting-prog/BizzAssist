'use client';

/**
 * AI Feedback Dashboard — admin triage for unmet AI needs.
 *
 * BIZZ-231: Displays ai_feedback_log entries with filtering by feedback type,
 * date range, and frequency aggregation. Admins can review recurring gaps
 * and create JIRA tickets for missing features.
 *
 * Data source: tenant.ai_feedback_log (via /api/admin/ai-feedback)
 */

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/app/context/LanguageContext';
import {
  MessageSquareWarning,
  ThumbsDown,
  AlertTriangle,
  Database,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { AdminNavTabs } from '../AdminNavTabs';

// ─── Types ──────────────────────────────────────────────────────────────────

interface FeedbackEntry {
  id: number;
  feedback_type: 'tool_failure' | 'no_data' | 'user_thumbs_down' | 'missing_capability';
  question_text: string;
  ai_response_snippet: string | null;
  page_context: string | null;
  jira_ticket_id: string | null;
  created_at: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const FEEDBACK_TYPES = [
  { value: 'all', label: 'Alle', icon: MessageSquareWarning },
  { value: 'tool_failure', label: 'Tool-fejl', icon: AlertTriangle },
  { value: 'no_data', label: 'Manglende data', icon: Database },
  { value: 'user_thumbs_down', label: 'Thumbs down', icon: ThumbsDown },
  { value: 'missing_capability', label: 'Manglende funktion', icon: MessageSquareWarning },
] as const;

// ─── Component ──────────────────────────────────────────────────────────────

export default function AIFeedbackClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  /** Fetch feedback entries from admin API */
  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const url =
        filter === 'all' ? '/api/admin/ai-feedback' : `/api/admin/ai-feedback?type=${filter}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setEntries(data);
      }
    } catch {
      // Silent fail — admin will see empty state
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  /** Format relative time */
  const timeAgo = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}t`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  /** Type badge color */
  const typeBadge = (type: string) => {
    switch (type) {
      case 'tool_failure':
        return 'bg-red-500/20 text-red-400';
      case 'no_data':
        return 'bg-amber-500/20 text-amber-400';
      case 'user_thumbs_down':
        return 'bg-purple-500/20 text-purple-400';
      case 'missing_capability':
        return 'bg-blue-500/20 text-blue-400';
      default:
        return 'bg-slate-500/20 text-slate-400';
    }
  };

  // ── Frequency aggregation: top 5 most common question patterns ──
  const topPatterns = entries
    .reduce(
      (acc, e) => {
        // Simple grouping by first 50 chars of question
        const key = e.question_text.slice(0, 50).toLowerCase();
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    )
    .valueOf();

  const sortedPatterns = Object.entries(topPatterns)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* BIZZ-749: shared admin tab-bar — activeTab points at a non-existing
          id so no tab is highlighted; users can still navigate out. */}
      <AdminNavTabs activeTab="ai-feedback" da={da} className="flex gap-1 -mb-px overflow-x-auto" />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">
            {da ? 'AI Feedback Triage' : 'AI Feedback Triage'}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            {da
              ? 'Gennemg\u00e5 ubesvarede sp\u00f8rgsm\u00e5l og manglende funktioner'
              : 'Review unanswered questions and missing capabilities'}
          </p>
        </div>
        <button
          onClick={fetchEntries}
          className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {da ? 'Opdater' : 'Refresh'}
        </button>
      </div>

      {/* Top recurring patterns */}
      {sortedPatterns.length > 0 && (
        <div className="bg-slate-800/50 border border-slate-700/40 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-white mb-3">
            {da ? 'Hyppigste ubesvarede emner' : 'Most frequent unanswered topics'}
          </h2>
          <div className="space-y-2">
            {sortedPatterns.map(([pattern, count]) => (
              <div key={pattern} className="flex items-center gap-3">
                <span className="text-xs font-mono bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                  {count}x
                </span>
                <span className="text-sm text-slate-300 truncate">{pattern}...</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {FEEDBACK_TYPES.map((ft) => {
          const Icon = ft.icon;
          return (
            <button
              key={ft.value}
              onClick={() => setFilter(ft.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === ft.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              <Icon size={12} />
              {ft.label}
            </button>
          );
        })}
      </div>

      {/* Feedback entries table */}
      {loading ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          {da ? 'Indl\u00e6ser...' : 'Loading...'}
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          {da ? 'Ingen feedback-entries endnu' : 'No feedback entries yet'}
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200 leading-relaxed">{entry.question_text}</p>
                  {entry.ai_response_snippet && (
                    <p className="text-xs text-slate-500 mt-1 italic truncate">
                      AI: {entry.ai_response_snippet}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${typeBadge(entry.feedback_type)}`}
                  >
                    {entry.feedback_type.replace('_', ' ')}
                  </span>
                  <span className="text-[10px] text-slate-500">{timeAgo(entry.created_at)}</span>
                </div>
              </div>
              {entry.page_context && (
                <p className="text-[10px] text-slate-600 flex items-center gap-1">
                  <ExternalLink size={10} />
                  {entry.page_context}
                </p>
              )}
              {entry.jira_ticket_id && (
                <span className="text-[10px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full">
                  {entry.jira_ticket_id}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
