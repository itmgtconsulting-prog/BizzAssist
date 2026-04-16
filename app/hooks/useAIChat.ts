'use client';

/**
 * Shared AI chat hook — used by both AIChatPanel (sidebar) and ChatPageClient (full page).
 *
 * BIZZ-227: Extracts the duplicated streaming/message logic (~400 lines per component)
 * into a single reusable hook. Handles:
 *   - SSE streaming from /api/ai/chat
 *   - Message state management
 *   - AbortController for stop/cancel
 *   - Tool status display
 *   - Token usage tracking via SubscriptionContext
 *   - Token sync to server (fire-and-forget)
 *
 * @module hooks/useAIChat
 */

import { useState, useRef, useCallback } from 'react';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { resolvePlan, isSubscriptionFunctional } from '@/app/lib/subscriptions';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SSEPayload {
  t?: string;
  error?: string;
  status?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

interface UseAIChatOptions {
  /** Optional context string sent alongside messages (e.g. page context) */
  context?: string;
  /** Called after streaming completes with the final assistant message */
  onMessageComplete?: (userMsg: ChatMessage, assistantMsg: ChatMessage) => void;
}

interface UseAIChatReturn {
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  streamText: string;
  toolStatus: string;
  isLoading: boolean;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  sendMessage: () => Promise<void>;
  stopStreaming: () => void;
  /** Returns a subscription error string, or null if sending is allowed */
  checkSubscriptionLimit: () => string | null;
  /** Clear all messages (e.g. new conversation) */
  clearMessages: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useAIChat(options: UseAIChatOptions = {}): UseAIChatReturn {
  const { context, onMessageComplete } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [toolStatus, setToolStatus] = useState('');

  const abortRef = useRef<AbortController | null>(null);

  // ── Subscription context ──
  const { subscription: ctxSub, addTokenUsage } = useSubscription();

  // ── Stop streaming ──
  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ── Clear messages ──
  const clearMessages = useCallback(() => {
    stopStreaming();
    setMessages([]);
    setStreamText('');
    setToolStatus('');
    setInput('');
  }, [stopStreaming]);

  // ── Subscription limit check ──
  const checkSubscriptionLimit = useCallback((): string | null => {
    if (!ctxSub) return null;
    const plan = resolvePlan(ctxSub.planId);

    if (ctxSub.status !== 'active') {
      return 'Dit abonnement er ikke aktivt.';
    }
    if (!isSubscriptionFunctional(ctxSub, plan)) {
      return 'Dit abonnement kræver betaling.';
    }
    if (!plan.aiEnabled) {
      return 'AI er ikke inkluderet i dit abonnement. Opgrader for at bruge AI Bizzness Assistent.';
    }
    const tokenLimit =
      plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
    if (tokenLimit > 0 && ctxSub.tokensUsedThisMonth >= tokenLimit) {
      const used = formatTokens(ctxSub.tokensUsedThisMonth);
      const limit = formatTokens(tokenLimit);
      return `Token-grænse nået (${used}/${limit}). Opgrader eller vent til næste måned.`;
    }
    return null;
  }, [ctxSub]);

  // ── Send message ──
  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    // Check subscription
    const subError = checkSubscriptionLimit();
    if (subError) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `⚠️ ${subError}` }]);
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: trimmed };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
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
          ...(context ? { context } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => 'Ukendt fejl');
        const errMsg: ChatMessage = {
          role: 'assistant',
          content: `⚠️ Fejl: ${res.status} — ${errBody}`,
        };
        setMessages((prev) => [...prev, errMsg]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;
            const payload = trimmedLine.slice(6);

            if (payload === '[DONE]') break;

            try {
              const parsed: SSEPayload = JSON.parse(payload);
              if (parsed.error) {
                accumulated += `\n⚠️ ${parsed.error}`;
                setStreamText(accumulated);
              } else if (parsed.usage) {
                addTokenUsage(parsed.usage.totalTokens);
                // Server already persists tokens in ai/chat/route.ts — no client sync needed
                // (previously caused double-counting via /api/subscription/track-tokens)
              } else if (parsed.status) {
                setToolStatus(parsed.status);
              } else if (parsed.t) {
                if (!accumulated) setToolStatus('');
                accumulated += parsed.t;
                setStreamText(accumulated);
              }
            } catch {
              // Ignore invalid JSON chunks
            }
          }
        }
      } finally {
        reader.releaseLock();
        reader.cancel().catch(() => {});
      }

      // Finalize: add the complete assistant message
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: accumulated || '*(tomt svar)*',
      };
      const finalMessages = [...newMessages, assistantMsg];
      setMessages(finalMessages);
      setStreamText('');
      setToolStatus('');

      // Notify caller (e.g. for persistence)
      onMessageComplete?.(userMsg, assistantMsg);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User stopped streaming
        const current = streamText || '*(stoppet)*';
        const stoppedMsg: ChatMessage = { role: 'assistant', content: current };
        setMessages((prev) => [...prev, stoppedMsg]);
        onMessageComplete?.(userMsg, stoppedMsg);
      } else {
        const errMsg: ChatMessage = {
          role: 'assistant',
          content: 'Der opstod en forbindelsesfejl. Prøv igen.',
        };
        setMessages((prev) => [...prev, errMsg]);
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [
    input,
    isLoading,
    messages,
    context,
    checkSubscriptionLimit,
    addTokenUsage,
    onMessageComplete,
    streamText,
  ]);

  return {
    messages,
    setMessages,
    streamText,
    toolStatus,
    isLoading,
    input,
    setInput,
    sendMessage,
    stopStreaming,
    checkSubscriptionLimit,
    clearMessages,
  };
}
