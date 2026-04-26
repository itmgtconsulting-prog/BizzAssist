'use client';

/**
 * SupportChatWidget — AI-powered floating support chat.
 *
 * Fixed-position chat bubble in the bottom-left corner of the dashboard.
 * Opens a chat panel where users can ask questions about BizzAssist
 * features, subscriptions, data types, and troubleshooting.
 *
 * Streams responses from /api/support/chat (Claude AI, no tool use).
 * Handles lockout errors (403 permanently locked, 429 temporary lockout)
 * with localised Danish/English messages.
 *
 * Retains the same floating button design as the previous widget.
 * No tool status indicators — support chat has no tools.
 *
 * @returns Floating chat widget with streaming AI responses
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageCircle, X, Send, Loader2, Bot, Bug, ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { usePathname } from 'next/navigation';
import { companyInfo } from '@/app/lib/companyInfo';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single conversation message */
interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

/** Lockout state when the server returns 403 or 429 */
interface LockoutState {
  permanent: boolean;
  retryAfterMinutes?: number;
}

// ─── Translations ─────────────────────────────────────────────────────────────

const TRANSLATIONS = {
  da: {
    title: 'Support',
    subtitle: 'Stil et spørgsmål om BizzAssist',
    placeholder: 'Skriv dit spørgsmål…',
    send: 'Send',
    greeting:
      'Hej! Jeg er BizzAssists support-assistent. Hvad kan jeg hjælpe med?\n\nJeg kan svare på spørgsmål om:\n• Abonnementer og priser\n• Ejendomsdata og BBR\n• AI-assistenten\n• Eksport, rapporter og kort\n• GDPR og databeskyttelse',
    reportBug: 'Rapportér fejl',
    bugTitle: 'Beskriv fejlen',
    bugTitlePlaceholder: 'Kort beskrivelse af problemet',
    bugDescPlaceholder: 'Hvad skete der? Hvad forventede du?',
    bugSubmit: 'Opret fejlrapport',
    bugCancel: 'Annuller',
    sending: 'Sender…',
    error: 'Noget gik galt. Prøv igen.',
    permanentLock: `Din adgang til support-chat er spærret. Kontakt ${companyInfo.adminEmail}.`,
    tempLock: (mins: number) =>
      `For mange henvendelser. Prøv igen om ${mins} ${mins === 1 ? 'minut' : 'minutter'}.`,
  },
  en: {
    title: 'Support',
    subtitle: 'Ask a question about BizzAssist',
    placeholder: 'Type your question…',
    send: 'Send',
    greeting:
      "Hi! I'm the BizzAssist support assistant. How can I help?\n\nI can answer questions about:\n• Subscriptions and pricing\n• Property data and BBR\n• AI assistant\n• Export, reports, and maps\n• GDPR and data protection",
    reportBug: 'Report bug',
    bugTitle: 'Describe the bug',
    bugTitlePlaceholder: 'Short description of the issue',
    bugDescPlaceholder: 'What happened? What did you expect?',
    bugSubmit: 'Create bug report',
    bugCancel: 'Cancel',
    sending: 'Sending…',
    error: 'Something went wrong. Please try again.',
    permanentLock: `Your support chat access is blocked. Contact ${companyInfo.adminEmail}.`,
    tempLock: (mins: number) =>
      `Too many requests. Try again in ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`,
  },
} as const;

// ─── Component ────────────────────────────────────────────────────────────────

interface SupportChatWidgetProps {
  /**
   * BIZZ-808: controlled open state. Sidebar menu item toggles this.
   * When undefined (legacy call-sites), the widget falls back to
   * self-managed state so it can still render as a floating widget.
   */
  open?: boolean;
  onClose?: () => void;
  /**
   * When true, skip rendering the floating trigger button — we're
   * mounted from the dashboard sidebar which owns the trigger instead.
   */
  hideFloatingTrigger?: boolean;
  /**
   * Optional pixel offset from the left edge so the popup can be
   * anchored next to the sidebar instead of floating at left:16px.
   * Defaults to 16 (1rem) to preserve the original floating layout.
   */
  anchorLeftPx?: number;
}

export default function SupportChatWidget({
  open: openProp,
  onClose,
  hideFloatingTrigger = false,
  anchorLeftPx = 16,
}: SupportChatWidgetProps = {}) {
  const { lang } = useLanguage();
  const pathname = usePathname();
  const txt = TRANSLATIONS[lang];

  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) => {
    if (openProp !== undefined) {
      // Controlled — parent owns state; only surface close via callback.
      const resolved = typeof next === 'function' ? (next as (o: boolean) => boolean)(open) : next;
      if (!resolved) onClose?.();
      return;
    }
    setOpenState((prev) =>
      typeof next === 'function' ? (next as (o: boolean) => boolean)(prev) : next
    );
  };
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [showBugForm, setShowBugForm] = useState(false);
  const [bugTitle, setBugTitle] = useState('');
  const [bugDesc, setBugDesc] = useState('');
  const [lockout, setLockout] = useState<LockoutState | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** AbortController for the active streaming request */
  const abortRef = useRef<AbortController | null>(null);

  /** Scroll to bottom whenever messages change or streaming starts/stops */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  /** Focus input when the chat panel opens (and not on the bug form) */
  useEffect(() => {
    if (open && !showBugForm) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [open, showBugForm]);

  /** Inject greeting on first open */
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ role: 'assistant', content: txt.greeting }]);
    }
  }, [open, messages.length, txt.greeting]);

  /** Abort any in-flight stream when the widget is closed */
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
    }
  }, [open]);

  /**
   * Sends the current input as a user message to /api/support/chat and
   * streams the assistant's response token-by-token into the messages state.
   *
   * Handles 403 (permanently locked) and 429 (temporary lockout) by
   * surfacing a localised lockout message instead of an assistant bubble.
   */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput('');
    setLockout(null);

    // Append user message and a placeholder assistant message for streaming
    const userMsg: ChatMsg = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '' }]);
    setStreaming(true);

    // Build the full conversation history to send (exclude the empty placeholder)
    const history: ChatMsg[] = messages.filter((m) => m.content.length > 0).concat(userMsg);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/support/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      });

      // ── Handle lockout responses before reading the stream ──
      if (res.status === 403) {
        const data = (await res.json()) as { error?: string };
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: 'assistant',
            content: data.error ?? txt.permanentLock,
          };
          return copy;
        });
        setLockout({ permanent: true });
        setStreaming(false);
        return;
      }

      if (res.status === 429) {
        const data = (await res.json()) as {
          error?: string;
          retryAfterMinutes?: number;
        };
        const mins = data.retryAfterMinutes ?? 30;
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            role: 'assistant',
            content: data.error ?? txt.tempLock(mins),
          };
          return copy;
        });
        setLockout({ permanent: false, retryAfterMinutes: mins });
        setStreaming(false);
        return;
      }

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      // ── Stream SSE events ──
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') break;

          try {
            const event = JSON.parse(payload) as { t: string } | { error: string };

            if ('t' in event) {
              // Append streamed text chunk to the last assistant message
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last?.role === 'assistant') {
                  copy[copy.length - 1] = {
                    ...last,
                    content: last.content + event.t,
                  };
                }
                return copy;
              });
            } else if ('error' in event) {
              setMessages((prev) => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  role: 'assistant',
                  content: event.error,
                };
                return copy;
              });
            }
          } catch {
            // Malformed SSE chunk — skip
          }
        }
      }
    } catch (err) {
      // Ignore abort errors (user closed the widget)
      if (err instanceof DOMException && err.name === 'AbortError') return;

      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant' && last.content === '') {
          copy[copy.length - 1] = { role: 'assistant', content: txt.error };
        }
        return copy;
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, messages, txt]);

  /**
   * Submits a bug report via the legacy /api/support route.
   * Pre-fills the bug description with whatever the user typed.
   */
  const submitBugReport = useCallback(async () => {
    if (!bugTitle.trim() || !bugDesc.trim()) return;
    setStreaming(true);

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

      const data = (await res.json()) as { reply?: string };
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply ?? txt.error }]);
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: txt.error }]);
    }

    setShowBugForm(false);
    setBugTitle('');
    setBugDesc('');
    setStreaming(false);
  }, [bugTitle, bugDesc, lang, pathname, txt]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Floating trigger button (skjult når parent leverer trigger) ── */}
      {!hideFloatingTrigger && (
        <button
          onClick={() => setOpen((o) => !o)}
          className={`fixed bottom-4 left-4 z-40 w-11 h-11 rounded-full shadow-lg hover:shadow-xl transition-all flex items-center justify-center ${
            open
              ? 'bg-slate-700 hover:bg-slate-600 text-white'
              : 'bg-blue-600 hover:bg-blue-500 text-white'
          }`}
          aria-label={txt.title}
        >
          {open ? <X size={18} /> : <MessageCircle size={18} />}
        </button>
      )}

      {/* ── Chat panel — forankret til sidebar-kanten via anchorLeftPx ── */}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="support-chat-title"
          className="fixed bottom-4 z-40 w-80 max-w-[calc(100vw-2rem)] bg-[#1e293b] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          style={{ left: `${anchorLeftPx}px`, maxHeight: 'min(520px, calc(100vh - 5rem))' }}
        >
          {/* ── Header ── */}
          <div className="px-4 py-3 border-b border-white/10 shrink-0 flex items-center gap-2">
            <div className="w-7 h-7 bg-blue-600/25 rounded-lg flex items-center justify-center shrink-0">
              <Bot size={14} className="text-blue-400" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 id="support-chat-title" className="text-white text-sm font-semibold truncate">
                {txt.title}
              </h3>
              <p className="text-slate-500 text-[10px] truncate">{txt.subtitle}</p>
            </div>
            {hideFloatingTrigger && (
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={lang === 'da' ? 'Luk support' : 'Close support'}
                className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/5 transition-colors shrink-0"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* ── Bug report form ── */}
          {showBugForm ? (
            <div className="flex-1 p-4 space-y-3 overflow-y-auto">
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => setShowBugForm(false)}
                  className="text-slate-400 hover:text-white transition-colors"
                  aria-label={txt.bugCancel}
                >
                  <ArrowLeft size={16} />
                </button>
                <h4 className="text-white text-sm font-medium flex items-center gap-2">
                  <Bug size={14} className="text-red-400" />
                  {txt.bugTitle}
                </h4>
              </div>
              <label htmlFor="bug-title" className="text-slate-400 text-[11px]">
                {txt.bugTitlePlaceholder}
              </label>
              <input
                id="bug-title"
                type="text"
                value={bugTitle}
                onChange={(e) => setBugTitle(e.target.value)}
                placeholder={txt.bugTitlePlaceholder}
                className="w-full bg-slate-800/60 border border-slate-700/40 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500/60"
              />
              <label htmlFor="bug-desc" className="text-slate-400 text-[11px]">
                {txt.bugDescPlaceholder}
              </label>
              <textarea
                id="bug-desc"
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
                  disabled={!bugTitle.trim() || !bugDesc.trim() || streaming}
                  className="flex-1 py-2 text-sm bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {streaming ? <Loader2 size={14} className="animate-spin" /> : <Bug size={14} />}
                  {streaming ? txt.sending : txt.bugSubmit}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* ── Messages list ── */}
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
                      {/* Blinking cursor on the last assistant message while streaming */}
                      {streaming && i === messages.length - 1 && msg.role === 'assistant' && (
                        <span className="inline-block w-0.5 h-3 bg-blue-400 ml-0.5 animate-pulse align-middle" />
                      )}
                    </div>
                  </div>
                ))}

                {/* Typing indicator — shown only before the first token arrives */}
                {streaming && messages[messages.length - 1]?.content === '' && (
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

                {/* Lockout banner */}
                {lockout && (
                  <div className="rounded-xl px-3 py-2 bg-red-900/30 border border-red-700/40 text-red-300 text-xs">
                    {lockout.permanent
                      ? txt.permanentLock
                      : txt.tempLock(lockout.retryAfterMinutes ?? 30)}
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* ── Input row ── */}
              <div className="px-3 pb-3 pt-1 shrink-0 space-y-2">
                <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/40 rounded-xl px-3 py-2 focus-within:border-blue-500/40 transition-colors">
                  <input
                    ref={inputRef}
                    id="support-chat-input"
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
                    disabled={lockout?.permanent === true}
                    className="flex-1 bg-transparent text-slate-300 text-xs placeholder-slate-600 focus:outline-none disabled:opacity-40"
                    aria-label={txt.placeholder}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={!input.trim() || streaming || lockout?.permanent === true}
                    className="text-blue-400 hover:text-blue-300 disabled:text-slate-600 transition-colors shrink-0"
                    aria-label={txt.send}
                  >
                    {streaming ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Send size={13} />
                    )}
                  </button>
                </div>

                {/* Bug report shortcut */}
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
