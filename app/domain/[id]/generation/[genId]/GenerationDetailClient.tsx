/**
 * GenerationDetailClient — status + download + re-try for a domain generation.
 *
 * BIZZ-717: Polls the /generation/:id endpoint when status is running; shows
 * download button when completed; shows error when failed.
 *
 * @module app/domain/[id]/generation/[genId]/GenerationDetailClient
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Download, Sparkles, CheckCircle2, AlertCircle } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

interface GenerationRow {
  id: string;
  case_id: string;
  template_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output_path: string | null;
  claude_tokens: number;
  user_prompt: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  preview_url: string | null;
}

export default function GenerationDetailClient({
  domainId,
  genId,
}: {
  domainId: string;
  genId: string;
}) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const [data, setData] = useState<GenerationRow | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/domain/${domainId}/generation/${genId}`);
      if (r.ok) setData((await r.json()) as GenerationRow);
    } finally {
      setLoading(false);
    }
  }, [domainId, genId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while running / pending
  useEffect(() => {
    if (!data || data.status === 'completed' || data.status === 'failed') return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [data, load]);

  const download = async () => {
    const r = await fetch(`/api/domain/${domainId}/generation/${genId}/download`);
    if (!r.ok) return;
    const { url } = (await r.json()) as { url: string };
    window.open(url, '_blank', 'noopener');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="text-center py-20 text-slate-400">
        {da ? 'Generation ikke fundet' : 'Generation not found'}
      </div>
    );
  }

  const statusColor =
    data.status === 'completed'
      ? 'text-emerald-400'
      : data.status === 'failed'
        ? 'text-rose-400'
        : 'text-amber-400';

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <Link
        href={`/domain/${domainId}/case/${data.case_id}`}
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage til sagen' : 'Back to case'}
      </Link>

      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Sparkles size={22} className="text-purple-400" />
          {da ? 'Dokumentgenerering' : 'Document generation'}
        </h1>
      </div>

      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4">
        {/* Status */}
        <div className="flex items-center gap-3">
          {data.status === 'completed' && <CheckCircle2 size={20} className="text-emerald-400" />}
          {data.status === 'failed' && <AlertCircle size={20} className="text-rose-400" />}
          {(data.status === 'running' || data.status === 'pending') && (
            <Loader2 size={20} className="text-amber-400 animate-spin" />
          )}
          <div>
            <p className={`text-sm font-medium ${statusColor}`}>
              {data.status === 'completed'
                ? da
                  ? 'Færdig'
                  : 'Completed'
                : data.status === 'failed'
                  ? da
                    ? 'Fejlede'
                    : 'Failed'
                  : data.status === 'running'
                    ? da
                      ? 'Kører…'
                      : 'Running…'
                    : da
                      ? 'Afventer'
                      : 'Pending'}
            </p>
            {data.completed_at && (
              <p className="text-slate-500 text-xs">
                {new Date(data.completed_at).toLocaleString(da ? 'da-DK' : 'en-GB')}
              </p>
            )}
          </div>
        </div>

        {/* Download */}
        {data.status === 'completed' && data.output_path && (
          <button
            onClick={download}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-md text-white text-sm font-medium"
          >
            <Download size={14} />
            {da ? 'Download dokument' : 'Download document'}
          </button>
        )}

        {/* Error */}
        {data.status === 'failed' && data.error_message && (
          <div className="px-3 py-2 bg-rose-900/20 border border-rose-700/40 rounded-md text-rose-300 text-xs font-mono">
            {data.error_message}
          </div>
        )}

        {/* Metadata */}
        <dl className="grid grid-cols-2 gap-3 text-xs text-slate-400">
          <div>
            <dt className="text-slate-500">{da ? 'Tokens brugt' : 'Tokens used'}</dt>
            <dd className="text-slate-300">{data.claude_tokens}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{da ? 'Startet' : 'Started'}</dt>
            <dd className="text-slate-300">
              {data.started_at
                ? new Date(data.started_at).toLocaleTimeString(da ? 'da-DK' : 'en-GB')
                : '—'}
            </dd>
          </div>
          {data.user_prompt && (
            <div className="col-span-2">
              <dt className="text-slate-500">{da ? 'Instruktioner' : 'Instructions'}</dt>
              <dd className="text-slate-300 whitespace-pre-wrap">{data.user_prompt}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
