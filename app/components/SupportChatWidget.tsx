'use client';

/**
 * Support chat widget — replaces the old FeedbackButton.
 *
 * Fixed-position chat bubble in the bottom-right corner.
 * Opens a chat panel where users can:
 *   - Ask questions about features, subscriptions, data
 *   - Report bugs (creates JIRA tickets automatically)
 *   - Get help with subscription/plan questions
 *
 * All questions are logged to /api/support for analytics.
 *
 * @returns Chat widget with floating trigger button
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageCircle, X, Send, Loader2, Bot, Bug, ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { usePathname } from 'next/navigation';

/** Chat message */
interface ChatMsg {
  role: 'user' | 'bot';
  content: string;
}

/** Translations for the widget */
const t = {
  da: {
    title: 'Support',
    subtitle: 'Stil et spørgsmål eller rapportér en fejl',
    placeholder: 'Skriv dit spørgsmål…',
    send: 'Send',
    greeting:
      'Hej! Jeg er BizzAssists support-assistent. Hvad kan jeg hjælpe med?\n\nJeg kan svare på spørgsmål om:\n• Abonnementer og priser\n• Ejendomsdata og BBR\n• AI-assistenten\n• Eksport, rapporter og kort\n\nHvis du har fundet en fejl, beskriv den så opretter jeg en rapport.',
    reportBug: 'Rapportér fejl',
    bugTitle: 'Beskriv fejlen',
    bugTitlePlaceholder: 'Kort beskrivelse af problemet',
    bugDescPlaceholder: 'Hvad skete der? Hvad forventede du?',
    bugSubmit: 'Opret fejlrapport',
    bugCancel: 'Annuller',
    sending: 'Sender…',
    error: 'Noget gik galt. Prøv igen.',
  },
  en: {
    title: 'Support',
    subtitle: 'Ask a question or report a bug',
    placeholder: 'Type your question…',
    send: 'Send',
    greeting:
      "Hi! I'm the BizzAssist support assistant. How can I help?\n\nI can answer questions about:\n• Subscriptions and pricing\n• Property data and BBR\n• AI assistant\n• Export, reports, and maps\n\nIf you found a bug, describe it and I'll create a report.",
    reportBug: 'Report bug',
    bugTitle: 'Describe the bug',
    bugTitlePlaceholder: 'Short description of the issue',
    bugDescPlaceholder: 'What happened? What did you expect?',
    bugSubmit: 'Create bug report',
    bugCancel: 'Cancel',
    sending: 'Sending…',
    error: 'Something went wrong. Please try again.',
  },
};

export default function SupportChatWidget() {
  const { lang } = useLanguage();
  const pathname = usePathname();
  const txt = t[lang];

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showBugForm, setShowBugForm] = useState(false);
  const [bugTitle, setBugTitle] = useState('');
  const [bugDesc, setBugDesc] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Scroll to bottom when new messages arrive */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  /** Focus input when panel opens */
  useEffect(() => {
    if (open && !showBugForm) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [open, showBugForm]);

  /** Add greeting on first open */
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ role: 'bot', content: txt.greeting }]);
    }
  }, [open, messages.length, txt.greeting]);

  /** Send a question to the support API */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setLoading(true);

    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          lang,
          context: { page: pathname },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => [...prev, { role: 'bot', content: data.reply }]);
        if (data.suggestTicket) {
          setShowBugForm(true);
          setBugDesc(text); // Pre-fill with the user's description
        }
      } else {
        setMessages((prev) => [...prev, { role: 'bot', content: txt.error }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'bot', content: txt.error }]);
    }

    setLoading(false);
  }, [input, loading, lang, pathname, txt.error]);

  /** Submit a bug report via the support API */
  const submitBugReport = useCallback(async () => {
    if (!bugTitle.trim() || !bugDesc.trim()) return;
    setLoading(true);

    try {
      const res = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '',
          lang,
          action: 'create_ticket',
          ticketData: {
            title: bugTitle.trim(),
            description: bugDesc.trim(),
            page: pathname,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => [...prev, { role: 'bot', content: data.reply }]);
      } else {
        setMessages((prev) => [...prev, { role: 'bot', content: txt.error }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'bot', content: txt.error }]);
    }

    setShowBugForm(false);
    setBugTitle('');
    setBugDesc('');
    setLoading(false);
  }, [bugTitle, bugDesc, lang, pathname, txt.error]);

  return (
    <>
      {/* ── Floating trigger button ── */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full shadow-lg hover:shadow-xl transition-all flex items-center justify-center ${
          open
            ? 'bg-slate-700 hover:bg-slate-600 text-white'
            : 'bg-blue-600 hover:bg-blue-500 text-white'
        }`}
        aria-label={txt.title}
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </button>

      {/* ── Chat panel ── */}
      {open && (
        <div
          className="fixed bottom-24 right-6 z-40 w-96 max-w-[calc(100vw-3rem)] bg-[#1e293b] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          style={{ maxHeight: 'min(520px, calc(100vh - 8rem))' }}
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-white/10 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-blue-600/25 rounded-lg flex items-center justify-center">
                <Bot size={14} className="text-blue-400" />
              </div>
              <div>
                <h3 className="text-white text-sm font-semibold">{txt.title}</h3>
                <p className="text-slate-500 text-[10px]">{txt.subtitle}</p>
              </div>
            </div>
          </div>

          {/* Bug report form */}
          {showBugForm ? (
            <div className="flex-1 p-4 space-y-3 overflow-y-auto">
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setShowBugForm(false)}
                  className="text-slate-400 hover:text-white transition-colors"
                >
                  <ArrowLeft size={16} />
                </button>
                <h4 className="text-white text-sm font-medium flex items-center gap-2">
                  <Bug size={14} className="text-red-400" />
                  {txt.bugTitle}
                </h4>
              </div>
              <input
                type="text"
                value={bugTitle}
                onChange={(e) => setBugTitle(e.target.value)}
                placeholder={txt.bugTitlePlaceholder}
                className="w-full bg-slate-800/60 border border-slate-700/40 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500/60"
              />
              <textarea
                value={bugDesc}
                onChange={(e) => setBugDesc(e.target.value)}
                placeholder={txt.bugDescPlaceholder}
                rows={4}
                className="w-full bg-slate-800/60 border border-slate-700/40 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500/60 resize-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowBugForm(false)}
                  className="flex-1 py-2 text-sm text-slate-400 hover:text-white border border-slate-700/40 rounded-lg transition-colors"
                >
                  {txt.bugCancel}
                </button>
                <button
                  onClick={submitBugReport}
                  disabled={!bugTitle.trim() || !bugDesc.trim() || loading}
                  className="flex-1 py-2 text-sm bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Bug size={14} />}
                  {loading ? txt.sending : txt.bugSubmit}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 min-h-0">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                        msg.role === 'user'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800/80 text-slate-300 border border-slate-700/40'
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="bg-slate-800/80 border border-slate-700/40 rounded-xl px-3 py-2.5 flex gap-1">
                      <span
                        className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                        style={{ animationDelay: '0ms' }}
                      />
                      <span
                        className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                        style={{ animationDelay: '140ms' }}
                      />
                      <span
                        className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                        style={{ animationDelay: '280ms' }}
                      />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input + bug report shortcut */}
              <div className="px-3 pb-3 pt-1 shrink-0 space-y-2">
                <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/40 rounded-xl px-3 py-2 focus-within:border-blue-500/40 transition-colors">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder={txt.placeholder}
                    className="flex-1 bg-transparent text-slate-300 text-xs placeholder-slate-600 focus:outline-none"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={!input.trim() || loading}
                    className="text-blue-400 hover:text-blue-300 disabled:text-slate-600 transition-colors shrink-0"
                    aria-label={txt.send}
                  >
                    <Send size={13} />
                  </button>
                </div>
                <button
                  onClick={() => setShowBugForm(true)}
                  className="w-full flex items-center justify-center gap-2 py-1.5 text-[11px] text-red-400/70 hover:text-red-400 transition-colors"
                >
                  <Bug size={11} />
                  {txt.reportBug}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
