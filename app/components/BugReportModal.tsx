'use client';

import { useState } from 'react';
import {
  X,
  Bug,
  Lightbulb,
  MessageSquare,
  Send,
  CheckCircle,
  AlertCircle,
  ChevronDown,
} from 'lucide-react';
import type { BugReportPayload } from '@/app/api/report-bug/route';

interface Props {
  open: boolean;
  onClose: () => void;
  lang?: 'da' | 'en';
  currentPage?: string;
}

const text = {
  da: {
    title: 'Rapportér et problem',
    typeLabel: 'Hvad vil du rapportere?',
    types: [
      { value: 'bug', label: 'Fejl / Bug', icon: Bug },
      { value: 'feedback', label: 'Generel feedback', icon: MessageSquare },
      { value: 'feature', label: 'Funktionsønske', icon: Lightbulb },
    ],
    titleLabel: 'Titel',
    titlePlaceholder: 'Kort beskrivelse af problemet',
    descLabel: 'Beskrivelse',
    descPlaceholder: 'Beskriv problemet i detaljer — hvad skete der? Hvad forventede du?',
    severityLabel: 'Alvorlighed',
    severities: [
      { value: 'low', label: 'Lav — kosmetisk fejl' },
      { value: 'medium', label: 'Medium — funktion virker delvist' },
      { value: 'high', label: 'Høj — funktion virker ikke' },
      { value: 'critical', label: 'Kritisk — app er ubrugelig' },
    ],
    emailLabel: 'Din e-mail (valgfrit)',
    emailPlaceholder: 'jakob@bizzassist.dk',
    submit: 'Send rapport',
    sending: 'Sender...',
    successTitle: 'Rapport sendt!',
    successText: 'Tak! Din rapport er oprettet som en JIRA-sag. Vi kigger på det hurtigst muligt.',
    errorTitle: 'Noget gik galt',
    close: 'Luk',
    newReport: 'Send ny rapport',
  },
  en: {
    title: 'Report an issue',
    typeLabel: 'What would you like to report?',
    types: [
      { value: 'bug', label: 'Bug / Error', icon: Bug },
      { value: 'feedback', label: 'General feedback', icon: MessageSquare },
      { value: 'feature', label: 'Feature request', icon: Lightbulb },
    ],
    titleLabel: 'Title',
    titlePlaceholder: 'Short description of the issue',
    descLabel: 'Description',
    descPlaceholder: 'Describe the issue in detail — what happened? What did you expect?',
    severityLabel: 'Severity',
    severities: [
      { value: 'low', label: 'Low — cosmetic issue' },
      { value: 'medium', label: 'Medium — feature partially works' },
      { value: 'high', label: 'High — feature does not work' },
      { value: 'critical', label: 'Critical — app is unusable' },
    ],
    emailLabel: 'Your email (optional)',
    emailPlaceholder: 'jakob@bizzassist.dk',
    submit: 'Send report',
    sending: 'Sending...',
    successTitle: 'Report sent!',
    successText:
      'Thank you! Your report has been created as a JIRA issue. We will look into it as soon as possible.',
    errorTitle: 'Something went wrong',
    close: 'Close',
    newReport: 'Send new report',
  },
};

export default function BugReportModal({ open, onClose, lang = 'da', currentPage }: Props) {
  const t = text[lang];
  const [type, setType] = useState<'bug' | 'feedback' | 'feature'>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [issueKey, setIssueKey] = useState('');

  if (!open) return null;

  const reset = () => {
    setTitle('');
    setDescription('');
    setSeverity('medium');
    setEmail('');
    setStatus('idle');
    setErrorMsg('');
    setIssueKey('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');

    const payload: BugReportPayload = {
      type,
      title: title.trim(),
      description: description.trim(),
      severity,
      page: currentPage ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
      email: email.trim() || undefined,
    };

    try {
      const res = await fetch('/api/report-bug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Unknown error');
      setIssueKey(data.issueKey ?? '');
      setStatus('success');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center">
              <Bug size={16} className="text-red-500" />
            </div>
            <h2 className="font-bold text-slate-900">{t.title}</h2>
          </div>
          <button
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {status === 'success' ? (
          <div className="px-6 py-10 text-center">
            <div className="w-14 h-14 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle size={28} className="text-emerald-500" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">{t.successTitle}</h3>
            <p className="text-slate-500 text-sm mb-2">{t.successText}</p>
            {issueKey && (
              <span className="inline-block bg-blue-50 text-blue-700 text-xs font-mono font-semibold px-3 py-1.5 rounded-lg">
                {issueKey}
              </span>
            )}
            <div className="flex gap-3 justify-center mt-6">
              <button
                onClick={reset}
                className="border border-slate-200 text-slate-700 font-medium text-sm px-4 py-2.5 rounded-xl hover:bg-slate-50 transition-colors"
              >
                {t.newReport}
              </button>
              <button
                onClick={handleClose}
                className="bg-blue-600 text-white font-medium text-sm px-4 py-2.5 rounded-xl hover:bg-blue-500 transition-colors"
              >
                {t.close}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
            {/* Type selector */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">{t.typeLabel}</label>
              <div className="grid grid-cols-3 gap-2">
                {t.types.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setType(opt.value as typeof type)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-xl border text-xs font-medium transition-all ${
                        type === opt.value
                          ? 'bg-blue-50 border-blue-400 text-blue-700'
                          : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <Icon size={18} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Title */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                {t.titleLabel}
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t.titlePlaceholder}
                required
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-colors"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                {t.descLabel}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t.descPlaceholder}
                required
                rows={4}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-colors resize-none"
              />
            </div>

            {/* Severity (only for bugs) */}
            {type === 'bug' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  {t.severityLabel}
                </label>
                <div className="relative">
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as typeof severity)}
                    className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 focus:outline-none focus:border-blue-400 transition-colors appearance-none bg-white"
                  >
                    {t.severities.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={16}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                  />
                </div>
              </div>
            )}

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                {t.emailLabel}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.emailPlaceholder}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-colors"
              />
            </div>

            {/* Error */}
            {status === 'error' && (
              <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4">
                <AlertCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-700">{t.errorTitle}</p>
                  <p className="text-xs text-red-500 mt-0.5">{errorMsg}</p>
                </div>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={status === 'sending'}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {status === 'sending' ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t.sending}
                </>
              ) : (
                <>
                  <Send size={16} />
                  {t.submit}
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
