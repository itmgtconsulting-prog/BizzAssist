'use client';

/**
 * AI Bizzness Assistent — chat-panel placeret nederst i sidenavigationen.
 *
 * Panelet er åbent som standard og fylder al tilgængelig plads nedenfor
 * navigationsmenuen (flex-1 min-h-0). Kan lukkes/åbnes via header-klik.
 *
 * Streamer svar fra /api/ai/chat (Claude API) via SSE.
 * Kontekst-bevidst: sender den aktuelle pathname som kontekst til Claude.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronDown, Send, Bot, Sparkles, Square } from 'lucide-react';
import {
  getSubscription,
  saveSubscription,
  getAllSubscriptions,
  saveAllSubscriptions,
  PLANS,
  formatTokens,
  type UserSubscription,
} from '@/app/lib/subscriptions';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Højde når panelet er lukket (kun header synlig) */
const COLLAPSED_HEIGHT = 48;

// ─── Token usage tracking ────────────────────────────────────────────────────

/**
 * Get the current user's subscription, synced between local and global list.
 * Ensures both localStorage keys stay in sync — uses the higher tokensUsedThisMonth
 * and merges bonusTokens from the global list (set by admin).
 *
 * @returns Synced subscription or null
 */
function getSyncedSubscription(): UserSubscription | null {
  const local = getSubscription();
  if (!local) return null;

  // Find the same user in the global admin list
  const allSubs = getAllSubscriptions();
  const global = allSubs.find((s) => s.email === local.email);

  if (global) {
    // Sync: use highest tokensUsedThisMonth (covers any write that only hit one key)
    const maxUsed = Math.max(local.tokensUsedThisMonth, global.tokensUsedThisMonth);
    // Sync bonusTokens from global list (admin sets it there)
    const bonusTokens = global.bonusTokens ?? local.bonusTokens ?? 0;

    if (local.tokensUsedThisMonth !== maxUsed || (local.bonusTokens ?? 0) !== bonusTokens) {
      local.tokensUsedThisMonth = maxUsed;
      local.bonusTokens = bonusTokens;
      saveSubscription(local);
    }

    if (global.tokensUsedThisMonth !== maxUsed) {
      global.tokensUsedThisMonth = maxUsed;
      const idx = allSubs.findIndex((s) => s.email === local.email);
      if (idx >= 0) allSubs[idx] = global;
      saveAllSubscriptions(allSubs);
    }

    // Also sync plan changes made by admin
    if (global.planId !== local.planId) {
      local.planId = global.planId;
      saveSubscription(local);
    }

    // Sync status changes made by admin
    if (global.status !== local.status) {
      local.status = global.status;
      local.approvedAt = global.approvedAt;
      saveSubscription(local);
    }
  }

  return local;
}

/**
 * Update the current user's token usage in localStorage after an AI chat response.
 * Updates both the user's own subscription and the global admin list.
 *
 * @param tokensUsed - Number of tokens consumed in this request
 */
function updateTokenUsage(tokensUsed: number) {
  if (tokensUsed <= 0) return;

  // Update user's own subscription
  const sub = getSubscription();
  if (!sub) return;
  sub.tokensUsedThisMonth += tokensUsed;
  saveSubscription(sub);

  // Also update the global admin list so admin panel shows correct usage
  const allSubs = getAllSubscriptions();
  const idx = allSubs.findIndex((s) => s.email === sub.email);
  if (idx >= 0) {
    allSubs[idx].tokensUsedThisMonth = sub.tokensUsedThisMonth;
    saveAllSubscriptions(allSubs);
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * AI Chat-panel til sidebar. Sender beskeder til /api/ai/chat og
 * streamer Claude-svar i realtid via SSE.
 * Tæller tokens fra Claude API-svar og opdaterer brugerens abonnement.
 */
export default function AIChatPanel() {
  const pathname = usePathname();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  /** Streamet tekst for den aktuelle assistent-besked */
  const [streamText, setStreamText] = useState('');
  /** Status-besked under tool-kald (f.eks. "Henter BBR-data…") */
  const [toolStatus, setToolStatus] = useState('');
  /** Token usage state — refreshed after each AI response */
  const [tokenInfo, setTokenInfo] = useState<{ used: number; limit: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** AbortController for at kunne stoppe streaming */
  const abortRef = useRef<AbortController | null>(null);

  /** Refresh token info from localStorage */
  const refreshTokenInfo = useCallback(() => {
    const sub = getSyncedSubscription();
    if (!sub) {
      setTokenInfo(null);
      return;
    }
    const plan = PLANS[sub.planId];
    if (!plan.aiEnabled) {
      setTokenInfo(null);
      return;
    }
    // -1 means unlimited tokens
    const limit = plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (sub.bonusTokens ?? 0);
    setTokenInfo({ used: sub.tokensUsedThisMonth, limit });
  }, []);

  /** Load token info on mount and when panel opens */
  useEffect(() => {
    refreshTokenInfo();
  }, [refreshTokenInfo, isOpen]);

  /** Scroll til bunden ved nye beskeder eller stream-opdatering */
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamText, isOpen]);

  /** Fokuser input første gang panelet åbnes */
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  /** Åbn/luk panelet */
  const togglePanel = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  /** Stop streaming */
  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /** Byg kontekst-streng fra pathname */
  const buildContext = useCallback((): string | undefined => {
    if (!pathname) return undefined;
    if (pathname.startsWith('/dashboard/ejendomme/')) {
      const id = pathname.split('/').pop();
      return `Ejendomsside for DAWA-adresse ${id}`;
    }
    if (pathname === '/dashboard/kort') return 'Kortvisning (fuldt kort)';
    if (pathname === '/dashboard/ejendomme') return 'Ejendomsoversigt (søgning)';
    if (pathname.startsWith('/dashboard/companies')) return 'Virksomhedsoversigt';
    if (pathname.startsWith('/dashboard/owners')) return 'Ejeroversigt';
    if (pathname === '/dashboard') return 'Dashboard-oversigt';
    return `Side: ${pathname}`;
  }, [pathname]);

  /** Send besked til AI og stream svar — blokerer hvis token-grænsen er nået */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // ── Token limit check (syncs local + global localStorage before checking) ──
    const sub = getSyncedSubscription();
    if (sub) {
      const plan = PLANS[sub.planId];

      // Block if user's subscription is not active
      if (sub.status !== 'active') {
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: text },
          {
            role: 'assistant',
            content:
              sub.status === 'pending'
                ? 'Dit abonnement afventer godkendelse. Kontakt en administrator.'
                : 'Dit abonnement er ikke aktivt. Kontakt en administrator.',
          },
        ]);
        setInput('');
        return;
      }

      // Block if plan doesn't include AI
      if (!plan.aiEnabled) {
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: text },
          {
            role: 'assistant',
            content:
              'AI-assistenten er ikke inkluderet i dit abonnement. Opgrader til Professionel eller Enterprise for at bruge AI.',
          },
        ]);
        setInput('');
        return;
      }

      // Block if token limit exceeded (skip check if unlimited: -1)
      const tokenLimit =
        plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (sub.bonusTokens ?? 0);
      if (tokenLimit > 0 && sub.tokensUsedThisMonth >= tokenLimit) {
        const used = formatTokens(sub.tokensUsedThisMonth);
        const limit = formatTokens(tokenLimit);
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: text },
          {
            role: 'assistant',
            content: `Du har brugt alle dine AI-tokens denne måned (${used} / ${limit}). Kontakt en administrator for at få tildelt ekstra tokens, eller vent til næste måned.`,
          },
        ]);
        setInput('');
        return;
      }
    }

    const userMsg: Message = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];

    setInput('');
    setMessages(newMessages);
    setIsLoading(true);
    setStreamText('');
    setToolStatus('');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          context: buildContext(),
        }),
        signal: controller.signal,
      });

      // ── Ikke-streaming fejl (manglende API-nøgle etc.) ──
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Serverfejl' }));
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: err.error ?? 'Der opstod en fejl.' },
        ]);
        setIsLoading(false);
        return;
      }

      // ── Parse SSE stream ──
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Ingen stream');

      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Behold sidste ufuldstændige linje i buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);

          if (payload === '[DONE]') break;

          try {
            const parsed = JSON.parse(payload) as {
              t?: string;
              error?: string;
              status?: string;
              usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
            };
            if (parsed.error) {
              accumulated += `\n⚠️ ${parsed.error}`;
              setStreamText(accumulated);
            } else if (parsed.usage) {
              // Update subscription token usage in localStorage
              updateTokenUsage(parsed.usage.totalTokens);
            } else if (parsed.status) {
              setToolStatus(parsed.status);
            } else if (parsed.t) {
              // Første tekst-chunk → ryd status
              if (!accumulated) setToolStatus('');
              accumulated += parsed.t;
              setStreamText(accumulated);
            }
          } catch {
            // Ignorer ugyldige JSON-chunks
          }
        }
      }

      // Flyt streamed tekst til message-array
      if (accumulated) {
        setMessages((prev) => [...prev, { role: 'assistant', content: accumulated }]);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Brugeren stoppede streaming — gem hvad vi har
        const current = streamText || '*(stoppet)*';
        setMessages((prev) => [...prev, { role: 'assistant', content: current }]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'Der opstod en forbindelsesfejl. Prøv igen.' },
        ]);
      }
    } finally {
      setStreamText('');
      setToolStatus('');
      setIsLoading(false);
      abortRef.current = null;
      refreshTokenInfo();
    }
  }, [input, isLoading, messages, buildContext, streamText, refreshTokenInfo]);

  return (
    <div
      className={`border-t border-white/10 bg-[#0f172a] flex flex-col overflow-hidden transition-[flex] duration-200 ${
        isOpen ? 'flex-1 min-h-0' : 'shrink-0'
      }`}
      style={isOpen ? undefined : { height: COLLAPSED_HEIGHT }}
    >
      {/* ── Header / toggle ──────────────────────────────────────────────── */}
      <div className="shrink-0">
        <div
          onClick={togglePanel}
          className="flex items-center justify-between px-4 py-3 cursor-pointer select-none hover:bg-white/3 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-blue-600/25 rounded-md flex items-center justify-center shrink-0">
              <Sparkles size={11} className="text-blue-400" />
            </div>
            <span className="text-slate-300 text-sm font-medium">AI Bizzness Assistent</span>
            {messages.length > 0 && !isOpen && (
              <span className="w-1.5 h-1.5 bg-blue-500 rounded-full shrink-0" />
            )}
          </div>
          <ChevronDown
            size={14}
            className={`text-slate-500 transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`}
          />
        </div>

        {/* ── Token status — mini bar under overskriften ── */}
        {tokenInfo && (tokenInfo.limit > 0 || tokenInfo.limit === -1) && (
          <div className="flex items-center gap-2 px-4 pb-2">
            <span className="text-[10px] text-slate-600 whitespace-nowrap">Token status</span>
            {tokenInfo.limit === -1 ? (
              <>
                <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-purple-500 w-full" />
                </div>
                <span className="text-[10px] font-medium text-purple-400 whitespace-nowrap">∞</span>
              </>
            ) : (
              <>
                <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      tokenInfo.used / tokenInfo.limit > 0.9
                        ? 'bg-red-500'
                        : tokenInfo.used / tokenInfo.limit > 0.7
                          ? 'bg-amber-500'
                          : 'bg-blue-500'
                    }`}
                    style={{ width: `${Math.min(100, (tokenInfo.used / tokenInfo.limit) * 100)}%` }}
                  />
                </div>
                <span
                  className={`text-[10px] font-medium whitespace-nowrap ${
                    tokenInfo.used / tokenInfo.limit > 0.9
                      ? 'text-red-400'
                      : tokenInfo.used / tokenInfo.limit > 0.7
                        ? 'text-amber-400'
                        : 'text-slate-600'
                  }`}
                >
                  {Math.min(100, Math.round((tokenInfo.used / tokenInfo.limit) * 100))}%
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Chat-indhold ─────────────────────────────────────────────────── */}
      {isOpen && (
        <>
          {/* Beskeder */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5 min-h-0">
            {messages.length === 0 && !streamText ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-4">
                <div className="w-10 h-10 bg-blue-600/20 rounded-xl flex items-center justify-center mb-3">
                  <Bot size={20} className="text-blue-400" />
                </div>
                <p className="text-slate-400 text-xs leading-relaxed max-w-[180px]">
                  Spørg om den ejendom, virksomhed eller person du kigger på.
                </p>
              </div>
            ) : (
              <>
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                        msg.role === 'user'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800/80 text-slate-300 border border-slate-700/40'
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}

                {/* Live streaming-tekst */}
                {streamText && (
                  <div className="flex justify-start">
                    <div className="max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-slate-800/80 text-slate-300 border border-slate-700/40">
                      {streamText}
                      <span className="inline-block w-1.5 h-3.5 bg-blue-400/70 ml-0.5 animate-pulse rounded-sm" />
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Tænke-animation + tool-status (før streaming starter) */}
            {isLoading && !streamText && (
              <div className="flex justify-start">
                <div className="bg-slate-800/80 border border-slate-700/40 rounded-xl px-3 py-2.5 flex flex-col gap-1.5">
                  <div className="flex gap-1">
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
                  {toolStatus && (
                    <span className="text-[10px] text-blue-400/80 font-medium">{toolStatus}</span>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input-felt */}
          <div className="px-3 pb-3 pt-1 shrink-0">
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
                placeholder="Stil et spørgsmål…"
                className="flex-1 bg-transparent text-slate-300 text-xs placeholder-slate-600 focus:outline-none"
              />
              {isLoading ? (
                <button
                  onClick={stopStreaming}
                  className="text-red-400 hover:text-red-300 transition-colors shrink-0"
                  aria-label="Stop streaming"
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  className="text-blue-400 hover:text-blue-300 disabled:text-slate-600 transition-colors shrink-0"
                  aria-label="Send besked"
                >
                  <Send size={13} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
