'use client';

/**
 * Full AI Chat page — /dashboard/chat
 *
 * Full-page layout replacing the sidebar AIChatPanel for deep-dive conversations.
 * Conversations are persisted in localStorage (ba-chat-history) as a session-local
 * fallback until a server-side store is wired up.
 *
 * Layout:
 *   - Left sidebar: conversation history list grouped by date
 *   - Main area: message thread + fixed input bar at the bottom
 *
 * Features:
 *   - Same streaming AI via /api/ai/chat (reuses existing endpoint + SSE protocol)
 *   - Persistent conversation history stored in localStorage
 *   - Auto-title from first 40 chars of the first user message
 *   - @-mention entity prefill (URL query param: ?context=<text>)
 *   - "Ny samtale" button
 *   - "Slet samtale" on each history item
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { MessageSquare, Plus, Trash2, Send, Square, Bot, Sparkles, Loader2 } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { useAIPageContext } from '@/app/context/AIPageContext';
import { resolvePlan, isSubscriptionFunctional, formatTokens } from '@/app/lib/subscriptions';

// ─── Token sync helper ──────────────────────────────────────────────────────

/** Fire-and-forget token sync with 3 retries and exponential backoff */
function syncTokenUsageToServer(tokensUsed: number): void {
  if (tokensUsed <= 0) return;
  const attempt = (retries: number) => {
    fetch('/api/subscription/track-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokensUsed }),
    }).catch(() => {
      if (retries > 0) setTimeout(() => attempt(retries - 1), 2000);
    });
  };
  attempt(2);
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single chat message */
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A persisted conversation stored in localStorage */
interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ba-chat-history';
const MAX_TITLE_LENGTH = 40;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a unique conversation ID.
 *
 * @returns A random alphanumeric string prefixed with timestamp
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Load all conversations from localStorage.
 *
 * @returns Array of conversations, newest first
 */
function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Conversation[];
  } catch {
    return [];
  }
}

/**
 * Save conversations array to localStorage.
 *
 * @param conversations - Full list of conversations to persist
 */
function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Derive conversation title from first user message.
 *
 * @param firstMessage - The first user message text
 * @returns Truncated title string
 */
function deriveTitle(firstMessage: string): string {
  const clean = firstMessage.trim().replace(/\n/g, ' ');
  return clean.length > MAX_TITLE_LENGTH ? clean.slice(0, MAX_TITLE_LENGTH) + '…' : clean;
}

/**
 * Format a date string for the conversation history sidebar.
 *
 * @param isoString - ISO 8601 date string
 * @returns Formatted date label (e.g. "I dag", "I går", or "7. apr.")
 */
function formatHistoryDate(isoString: string): string {
  const d = new Date(isoString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const dateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (dateOnly.getTime() === today.getTime()) return 'I dag';
  if (dateOnly.getTime() === yesterday.getTime()) return 'I går';
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
}

/**
 * Group conversations by calendar date label.
 *
 * @param conversations - All conversations
 * @returns Map from date label to conversation list
 */
function groupByDate(conversations: Conversation[]): Map<string, Conversation[]> {
  const map = new Map<string, Conversation[]>();
  for (const conv of conversations) {
    const label = formatHistoryDate(conv.createdAt);
    const group = map.get(label) ?? [];
    group.push(conv);
    map.set(label, group);
  }
  return map;
}

// ─── Markdown renderer (lightweight) ─────────────────────────────────────────

/**
 * Render assistant message content with basic markdown support:
 * bold, italic, inline code, code blocks, and line breaks.
 *
 * @param text - Raw markdown text from the AI
 * @returns JSX with formatted content
 */
function MarkdownContent({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let keyCounter = 0;

  /**
   * Render inline markdown (bold, italic, code) within a text line.
   *
   * @param line - Single line of text with inline markdown
   * @returns Rendered JSX
   */
  const renderInline = (line: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    let rest = line;
    let i = 0;

    while (rest.length > 0) {
      // Bold **text**  ([\s\S] instead of dotall flag for ES2017 compat)
      const boldMatch = rest.match(/^([\s\S]*?)\*\*([\s\S]+?)\*\*([\s\S]*)/);
      // Italic *text*
      const italicMatch = rest.match(/^([\s\S]*?)\*([\s\S]+?)\*([\s\S]*)/);
      // Code `text`
      const codeMatch = rest.match(/^([\s\S]*?)`([\s\S]+?)`([\s\S]*)/);

      // Pick the earliest match
      const candidates: { idx: number; type: string; match: RegExpMatchArray }[] = [];
      if (boldMatch) candidates.push({ idx: boldMatch[1].length, type: 'bold', match: boldMatch });
      if (italicMatch)
        candidates.push({ idx: italicMatch[1].length, type: 'italic', match: italicMatch });
      if (codeMatch) candidates.push({ idx: codeMatch[1].length, type: 'code', match: codeMatch });

      if (candidates.length === 0) {
        parts.push(rest);
        break;
      }
      candidates.sort((a, b) => a.idx - b.idx);
      const winner = candidates[0];
      const { type, match } = winner;

      if (match[1]) parts.push(match[1]);
      if (type === 'bold') {
        parts.push(<strong key={`b-${i++}`}>{match[2]}</strong>);
      } else if (type === 'italic') {
        parts.push(<em key={`e-${i++}`}>{match[2]}</em>);
      } else {
        parts.push(
          <code
            key={`c-${i++}`}
            className="bg-slate-700/70 px-1 py-0.5 rounded text-xs font-mono text-blue-200"
          >
            {match[2]}
          </code>
        );
      }
      rest = match[3];
    }
    return <>{parts}</>;
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre
            key={`pre-${keyCounter++}`}
            className="bg-slate-900 border border-slate-700 rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono text-slate-300 whitespace-pre-wrap"
          >
            {codeLines.join('\n')}
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === '') {
      elements.push(<div key={`br-${keyCounter++}`} className="h-2" />);
      continue;
    }

    // Heading
    if (line.startsWith('### ')) {
      elements.push(
        <h3 key={`h3-${keyCounter++}`} className="text-white font-semibold text-sm mt-3 mb-1">
          {renderInline(line.slice(4))}
        </h3>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h2 key={`h2-${keyCounter++}`} className="text-white font-semibold text-base mt-4 mb-1">
          {renderInline(line.slice(3))}
        </h2>
      );
      continue;
    }

    // Bullet
    if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={`li-${keyCounter++}`} className="flex items-start gap-2 text-sm">
          <span className="text-slate-500 mt-0.5 shrink-0">•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>
      );
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      elements.push(
        <div key={`nl-${keyCounter++}`} className="flex items-start gap-2 text-sm">
          <span className="text-slate-500 mt-0.5 shrink-0 w-4 text-right">{numMatch[1]}.</span>
          <span>{renderInline(numMatch[2])}</span>
        </div>
      );
      continue;
    }

    elements.push(
      <p key={`p-${keyCounter++}`} className="text-sm leading-relaxed">
        {renderInline(line)}
      </p>
    );
  }

  return <div className="space-y-1 text-slate-200">{elements}</div>;
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Full-page AI Chat.
 *
 * Manages conversation history in localStorage and streams responses
 * from /api/ai/chat using the same SSE protocol as AIChatPanel.
 */
export default function ChatPageClient() {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const searchParams = useSearchParams();
  const { subscription: ctxSub, addTokenUsage } = useSubscription();
  /** BIZZ-232: Page context from previous page (passed from sidebar AIChatPanel) */
  const { pageData } = useAIPageContext();

  // ── Conversation state ──
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [toolStatus, setToolStatus] = useState('');
  const [isMounted, setIsMounted] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Load from localStorage on mount ──
  useEffect(() => {
    setIsMounted(true);
    const stored = loadConversations();
    setConversations(stored);
    // Select most recent conversation if any
    if (stored.length > 0) {
      setActiveId(stored[0].id);
      setMessages(stored[0].messages);
    }
  }, []);

  // ── Pre-fill from URL query param (?context=…) ──
  useEffect(() => {
    const ctx = searchParams.get('context');
    if (ctx) {
      setInput(`@${ctx} `);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [searchParams]);

  // ── Scroll to bottom ──
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  /**
   * Persist the current active conversation back to localStorage.
   *
   * @param id - Conversation ID to update
   * @param updatedMessages - New message array
   * @param currentConvs - Current conversations snapshot
   */
  /**
   * BIZZ-240 fix: reads conversations from localStorage instead of using
   * a stale snapshot, so auto-derived titles are preserved after streaming.
   */
  const persistConversation = useCallback((id: string, updatedMessages: ChatMessage[]) => {
    const freshConvs = loadConversations();
    const updated = freshConvs.map((c) => (c.id === id ? { ...c, messages: updatedMessages } : c));
    saveConversations(updated);
    setConversations(updated);
  }, []);

  /**
   * Create a new empty conversation and select it.
   */
  const handleNewConversation = useCallback(() => {
    abortRef.current?.abort();
    const newConv: Conversation = {
      id: generateId(),
      title: da ? 'Ny samtale' : 'New conversation',
      messages: [],
      createdAt: new Date().toISOString(),
    };
    const updated = [newConv, ...conversations];
    saveConversations(updated);
    setConversations(updated);
    setActiveId(newConv.id);
    setMessages([]);
    setStreamText('');
    setToolStatus('');
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [conversations, da]);

  /**
   * Select a conversation from the history list.
   *
   * @param id - Conversation ID to load
   */
  const handleSelectConversation = useCallback(
    (id: string) => {
      abortRef.current?.abort();
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return;
      setActiveId(id);
      setMessages(conv.messages);
      setStreamText('');
      setToolStatus('');
    },
    [conversations]
  );

  /**
   * Delete a conversation from history.
   *
   * @param id - Conversation ID to remove
   */
  const handleDeleteConversation = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const updated = conversations.filter((c) => c.id !== id);
      saveConversations(updated);
      setConversations(updated);
      if (activeId === id) {
        if (updated.length > 0) {
          setActiveId(updated[0].id);
          setMessages(updated[0].messages);
        } else {
          setActiveId(null);
          setMessages([]);
        }
      }
    },
    [conversations, activeId]
  );

  /** Stop AI streaming */
  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Check subscription limits before sending.
   * Returns an error string if blocked, or null if OK.
   *
   * @returns Error message or null
   */
  const checkSubscriptionLimit = useCallback((): string | null => {
    if (!ctxSub) return null;
    const plan = resolvePlan(ctxSub.planId);

    if (ctxSub.status !== 'active') {
      return da
        ? 'Dit abonnement er ikke aktivt. Kontakt en administrator.'
        : 'Your subscription is not active. Contact an administrator.';
    }
    if (!isSubscriptionFunctional(ctxSub, plan)) {
      return da
        ? 'Dit abonnement mangler betaling. Gå til indstillinger for at gennemføre betalingen.'
        : 'Your subscription requires payment. Go to settings to complete payment.';
    }
    if (!plan.aiEnabled) {
      return da
        ? 'AI-assistenten er ikke inkluderet i dit abonnement.'
        : 'AI is not included in your subscription.';
    }
    const tokenLimit =
      plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
    if (tokenLimit > 0 && ctxSub.tokensUsedThisMonth >= tokenLimit) {
      const used = formatTokens(ctxSub.tokensUsedThisMonth);
      const limit = formatTokens(tokenLimit);
      return da
        ? `Du har brugt alle dine AI-tokens denne måned (${used} / ${limit}).`
        : `You have used all your AI tokens this month (${used} / ${limit}).`;
    }
    return null;
  }, [ctxSub, da]);

  /**
   * Send the current input to /api/ai/chat and stream the response.
   * Creates or updates the active conversation in localStorage.
   */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // Subscription check
    const blockReason = checkSubscriptionLimit();

    // Ensure there is an active conversation
    let convId = activeId;
    let currentConvs = conversations;

    if (!convId) {
      const newConv: Conversation = {
        id: generateId(),
        title: deriveTitle(text),
        messages: [],
        createdAt: new Date().toISOString(),
      };
      currentConvs = [newConv, ...conversations];
      saveConversations(currentConvs);
      setConversations(currentConvs);
      convId = newConv.id;
      setActiveId(convId);
    }

    const userMsg: ChatMessage = { role: 'user', content: text };
    const newMessages: ChatMessage[] = [...messages, userMsg];

    // Auto-title from first user message
    if (messages.length === 0) {
      const updated = currentConvs.map((c) =>
        c.id === convId ? { ...c, title: deriveTitle(text), messages: newMessages } : c
      );
      saveConversations(updated);
      setConversations(updated);
    }

    setInput('');
    setMessages(newMessages);
    setIsLoading(true);
    setStreamText('');
    setToolStatus('');

    // If blocked, show error as assistant message and return
    if (blockReason) {
      const errorMsg: ChatMessage = { role: 'assistant', content: blockReason };
      const withError = [...newMessages, errorMsg];
      setMessages(withError);
      persistConversation(convId, withError);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          // BIZZ-232: pass page context from sidebar if available
          ...(pageData?.bfeNummer || pageData?.cvrNummer
            ? {
                context: [
                  pageData.adresse && `Adresse: ${pageData.adresse}`,
                  pageData.bfeNummer && `BFE-nummer: ${pageData.bfeNummer}`,
                  pageData.adresseId && `adresseId: ${pageData.adresseId}`,
                  pageData.kommunekode && `kommunekode: ${pageData.kommunekode}`,
                  pageData.cvrNummer && `CVR: ${pageData.cvrNummer}`,
                  pageData.virksomhedNavn && `Virksomhed: ${pageData.virksomhedNavn}`,
                  pageData.enhedsNummer && `enhedsNummer: ${pageData.enhedsNummer}`,
                  pageData.personNavn && `Person: ${pageData.personNavn}`,
                ]
                  .filter(Boolean)
                  .join('\n'),
              }
            : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Serverfejl' }));
        const errMsg: ChatMessage = {
          role: 'assistant',
          content: (err as { error?: string }).error ?? 'Der opstod en fejl.',
        };
        const withErr = [...newMessages, errMsg];
        setMessages(withErr);
        persistConversation(convId, withErr);
        setIsLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('Ingen stream');

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
                addTokenUsage(parsed.usage.totalTokens);
                syncTokenUsageToServer(parsed.usage.totalTokens);
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
        reader.cancel().catch(() => {});
      }

      if (accumulated) {
        const assistantMsg: ChatMessage = { role: 'assistant', content: accumulated };
        const finalMessages = [...newMessages, assistantMsg];
        setMessages(finalMessages);
        persistConversation(convId, finalMessages);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        const current = streamText || '*(stoppet)*';
        const stoppedMsg: ChatMessage = { role: 'assistant', content: current };
        const finalMessages = [...newMessages, stoppedMsg];
        setMessages(finalMessages);
        persistConversation(convId, finalMessages);
      } else {
        const errMsg: ChatMessage = {
          role: 'assistant',
          content: 'Der opstod en forbindelsesfejl. Prøv igen.',
        };
        const withErr = [...newMessages, errMsg];
        setMessages(withErr);
        persistConversation(convId, withErr);
      }
    } finally {
      setStreamText('');
      setToolStatus('');
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [
    input,
    isLoading,
    messages,
    activeId,
    conversations,
    checkSubscriptionLimit,
    persistConversation,
    streamText,
    addTokenUsage,
  ]);

  /**
   * Handle Enter key in textarea (Shift+Enter = newline, Enter = send).
   *
   * @param e - Keyboard event
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const grouped = groupByDate(conversations);

  if (!isMounted) return null;

  return (
    <div className="flex-1 flex overflow-hidden bg-[#0a1020]">
      {/* ─── Left sidebar: conversation history ──────────────────────────────── */}
      <aside className="w-64 shrink-0 flex flex-col border-r border-white/8 bg-[#0f172a]">
        {/* Header */}
        <div className="px-4 pt-5 pb-3 border-b border-white/8">
          <h1 className="text-white font-bold text-base mb-3">{da ? 'AI Chat' : 'AI Chat'}</h1>
          <button
            onClick={handleNewConversation}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus size={14} />
            {da ? 'Ny samtale' : 'New conversation'}
          </button>
        </div>

        {/* History list */}
        <div className="flex-1 overflow-y-auto py-2">
          {conversations.length === 0 ? (
            <p className="text-slate-500 text-xs px-4 py-3">
              {da ? 'Ingen tidligere samtaler' : 'No previous conversations'}
            </p>
          ) : (
            Array.from(grouped.entries()).map(([dateLabel, convs]) => (
              <div key={dateLabel}>
                <p className="text-slate-600 text-xs font-medium px-4 py-2 uppercase tracking-wider">
                  {dateLabel}
                </p>
                {convs.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => handleSelectConversation(conv.id)}
                    className={`w-full text-left flex items-start justify-between gap-2 px-4 py-2.5 group transition-colors ${
                      activeId === conv.id
                        ? 'bg-blue-600/15 text-white'
                        : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                    }`}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <MessageSquare size={13} className="shrink-0 mt-0.5 text-slate-500" />
                      <span className="text-xs truncate leading-5">{conv.title}</span>
                    </div>
                    <button
                      onClick={(e) => handleDeleteConversation(conv.id, e)}
                      aria-label={da ? 'Slet samtale' : 'Delete conversation'}
                      className="shrink-0 opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all"
                    >
                      <Trash2 size={12} />
                    </button>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ─── Main chat area ───────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
          {messages.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center h-full text-center pt-12">
              <div className="w-14 h-14 bg-blue-600/20 rounded-2xl flex items-center justify-center mb-4">
                <Sparkles size={24} className="text-blue-400" />
              </div>
              <h2 className="text-white font-semibold text-lg mb-2">
                {da ? 'AI Bizzness Assistent' : 'AI Business Assistant'}
              </h2>
              <p className="text-slate-400 text-sm max-w-sm leading-relaxed">
                {da
                  ? 'Stil spørgsmål om ejendomme, virksomheder og ejerskab. Brug @-omtale for at nævne en enhed.'
                  : 'Ask about properties, companies and ownership. Use @-mentions to reference an entity.'}
              </p>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 rounded-full bg-blue-600/20 flex items-center justify-center shrink-0 mr-2 mt-0.5">
                  <Bot size={14} className="text-blue-400" />
                </div>
              )}
              <div
                className={`max-w-[70%] rounded-2xl px-4 py-3 ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white text-sm'
                    : 'bg-slate-800/80 border border-white/8'
                }`}
              >
                {msg.role === 'user' ? (
                  <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                ) : (
                  <MarkdownContent text={msg.content} />
                )}
              </div>
            </div>
          ))}

          {/* Streaming message */}
          {isLoading && (
            <div className="flex justify-start">
              <div className="w-7 h-7 rounded-full bg-blue-600/20 flex items-center justify-center shrink-0 mr-2 mt-0.5">
                <Bot size={14} className="text-blue-400" />
              </div>
              <div className="max-w-[70%] bg-slate-800/80 border border-white/8 rounded-2xl px-4 py-3">
                {toolStatus && !streamText && (
                  <div className="flex items-center gap-2 text-slate-400 text-sm">
                    <Loader2 size={13} className="animate-spin shrink-0" />
                    <span>{toolStatus}</span>
                  </div>
                )}
                {streamText ? (
                  <MarkdownContent text={streamText} />
                ) : (
                  !toolStatus && (
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="shrink-0 border-t border-white/8 bg-[#0f172a] px-4 py-3">
          <div className="flex items-end gap-2 max-w-4xl mx-auto">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  da
                    ? 'Stil et spørgsmål… (Enter for at sende, Shift+Enter for ny linje)'
                    : 'Ask a question… (Enter to send, Shift+Enter for newline)'
                }
                rows={1}
                className="w-full bg-slate-800/70 border border-white/10 focus:border-blue-500/60 rounded-xl px-4 py-3 text-white text-sm placeholder-slate-500 outline-none resize-none transition-colors max-h-40 overflow-y-auto"
                style={{ minHeight: '48px' }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = 'auto';
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                }}
                disabled={isLoading}
                aria-label={da ? 'Besked til AI-assistent' : 'Message to AI assistant'}
              />
            </div>

            {isLoading ? (
              <button
                onClick={stopStreaming}
                aria-label={da ? 'Stop streaming' : 'Stop streaming'}
                className="shrink-0 w-11 h-11 flex items-center justify-center bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 text-red-400 rounded-xl transition-colors"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                onClick={sendMessage}
                disabled={!input.trim()}
                aria-label={da ? 'Send besked' : 'Send message'}
                className="shrink-0 w-11 h-11 flex items-center justify-center bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-xl transition-colors"
              >
                <Send size={16} />
              </button>
            )}
          </div>

          {/* Disclaimer */}
          <p className="text-slate-600 text-xs text-center mt-2">
            {da
              ? 'AI kan lave fejl — verificér vigtige oplysninger.'
              : 'AI can make mistakes — verify important information.'}
          </p>
        </div>
      </div>
    </div>
  );
}
