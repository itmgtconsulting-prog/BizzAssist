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

import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, Send, Bot, Sparkles, Square, Maximize2, Minimize2 } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { resolvePlan, isSubscriptionFunctional, formatTokens } from '@/app/lib/subscriptions';
import { useSubscriptionAccess } from '@/app/components/SubscriptionGate';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { useAIPageContext } from '@/app/context/AIPageContext';
import { Lock } from 'lucide-react';

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
 * Fetch with automatic retry on network failure.
 *
 * @param url - The URL to fetch
 * @param options - Standard fetch options
 * @param retries - Number of remaining retries (default 2)
 * @returns The successful Response
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return fetchWithRetry(url, options, retries - 1);
  }
}

/**
 * Sync token usage to Supabase in background (fire-and-forget).
 * Retries up to 2 times on network failure before giving up.
 * In-memory state is updated via SubscriptionContext.addTokenUsage().
 *
 * @param tokensUsed - Number of tokens consumed in this request
 */
function syncTokenUsageToServer(tokensUsed: number) {
  if (tokensUsed <= 0) return;

  // Sync to Supabase in background (fire-and-forget) with retry
  fetchWithRetry('/api/subscription/track-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokensUsed }),
  }).catch((err) => {
    console.error('[token-sync] Failed after retries:', err);
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * AI Chat-panel til sidebar. Sender beskeder til /api/ai/chat og
 * streamer Claude-svar i realtid via SSE.
 * Tæller tokens fra Claude API-svar og opdaterer brugerens abonnement.
 */
function AIChatPanel() {
  const { lang } = useLanguage();
  const a = translations[lang].ai;
  const pathname = usePathname();
  const router = useRouter();
  /** Struktureret side-data fra den aktuelle page (BFE, CVR, enhedsNummer osv.) */
  const { pageData } = useAIPageContext();
  /** Subscription gate — disables AI when user has no active plan */
  const { isActive: subActive } = useSubscriptionAccess('ai');
  /** Subscription context — server-authoritative, no localStorage */
  const { subscription: ctxSub, addTokenUsage } = useSubscription();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  /** Om chattet vises som et stort pop-out modal */
  const [isExpanded, setIsExpanded] = useState(false);
  /** Streamet tekst for den aktuelle assistent-besked */
  const [streamText, setStreamText] = useState('');
  /** Status-besked under tool-kald (f.eks. "Henter BBR-data…") */
  const [toolStatus, setToolStatus] = useState('');
  /** Token usage state — refreshed after each AI response */
  const [tokenInfo, setTokenInfo] = useState<{ used: number; limit: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modalMessagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalInputRef = useRef<HTMLInputElement>(null);
  /** AbortController for at kunne stoppe streaming */
  const abortRef = useRef<AbortController | null>(null);
  /** Om vi er mounted på client (nødvendigt for createPortal) */
  const [isMounted, setIsMounted] = useState(false);

  /** Marker som mounted efter første render så createPortal virker */
  useEffect(() => {
    setIsMounted(true);
  }, []);

  /** Refresh token info from subscription context (server-authoritative) */
  const refreshTokenInfo = useCallback(() => {
    if (!ctxSub) {
      setTokenInfo(null);
      return;
    }
    const plan = resolvePlan(ctxSub.planId);
    if (!plan.aiEnabled) {
      setTokenInfo(null);
      return;
    }
    // -1 means unlimited tokens
    const limit =
      plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
    setTokenInfo({ used: ctxSub.tokensUsedThisMonth, limit });
  }, [ctxSub]);

  /** Load token info on mount and when panel opens */
  useEffect(() => {
    refreshTokenInfo();
  }, [refreshTokenInfo, isOpen]);

  /** Scroll til bunden ved nye beskeder eller stream-opdatering */
  useEffect(() => {
    if (isExpanded) {
      modalMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamText, isOpen, isExpanded]);

  /** Fokuser input første gang panelet åbnes eller modal pop-out åbnes */
  useEffect(() => {
    // Capture timer id so it can be cleared if the component unmounts before the delay fires
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (isExpanded) {
      timerId = setTimeout(() => modalInputRef.current?.focus(), 150);
    } else if (isOpen) {
      timerId = setTimeout(() => inputRef.current?.focus(), 150);
    }
    return () => clearTimeout(timerId);
  }, [isOpen, isExpanded]);

  /** Luk modal med Escape-tasten */
  useEffect(() => {
    if (!isExpanded) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsExpanded(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isExpanded]);

  /** Åbn/luk panelet (sidebar-tilstand) */
  const togglePanel = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  /** Åbn/luk pop-out modal */
  const toggleExpanded = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Forhindre at header-klik lukker panelet
    setIsExpanded((prev) => !prev);
    // Sørg for at panelet er åbent i sidebar-tilstand som fallback
    setIsOpen(true);
  }, []);

  /** Stop streaming */
  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /**
   * Byg kontekst-streng fra pathname + struktureret side-data.
   * Inkluderer konkrete ID'er (BFE, CVR, enhedsNummer) så AI'en kan
   * kalde tools direkte uden at gætte eller søge efter dem.
   */
  const buildContext = useCallback((): string | undefined => {
    const parts: string[] = [];

    // Pathname-baseret beskrivelse
    if (pathname) {
      if (pathname.startsWith('/dashboard/ejendomme/')) {
        const id = pathname.split('/').pop();
        parts.push(a.contextProperty.replace('{id}', id ?? ''));
      } else if (pathname === '/dashboard/kort') {
        parts.push(a.contextMap);
      } else if (pathname === '/dashboard/ejendomme') {
        parts.push(a.contextPropertySearch);
      } else if (pathname.startsWith('/dashboard/companies')) {
        parts.push(a.contextCompanies);
      } else if (pathname.startsWith('/dashboard/owners')) {
        parts.push(a.contextOwners);
      } else if (pathname === '/dashboard') {
        parts.push(a.contextDashboard);
      } else {
        parts.push(a.contextPage.replace('{path}', pathname));
      }
    }

    // Strukturerede ID'er fra siden — AI'en kan bruge dem direkte i tool-kald
    if (pageData) {
      const fields: string[] = [];
      if (pageData.adresse) fields.push(`Adresse: ${pageData.adresse}`);
      if (pageData.bfeNummer) fields.push(`BFE-nummer: ${pageData.bfeNummer}`);
      if (pageData.adresseId) fields.push(`DAWA adresse-ID: ${pageData.adresseId}`);
      if (pageData.kommunekode) fields.push(`Kommunekode: ${pageData.kommunekode}`);
      if (pageData.matrikelnr) fields.push(`Matrikelnr: ${pageData.matrikelnr}`);
      if (pageData.ejerlavKode) fields.push(`Ejerlavkode: ${pageData.ejerlavKode}`);
      if (pageData.cvrNummer) fields.push(`CVR-nummer: ${pageData.cvrNummer}`);
      if (pageData.virksomhedNavn) fields.push(`Virksomhed: ${pageData.virksomhedNavn}`);
      if (pageData.enhedsNummer) fields.push(`CVR enhedsnummer (person): ${pageData.enhedsNummer}`);
      if (pageData.personNavn) fields.push(`Person: ${pageData.personNavn}`);
      if (fields.length > 0) {
        parts.push(
          "Tilgængelige ID'er (brug direkte i tool-kald — ingen yderligere søgning nødvendig):\n" +
            fields.join('\n')
        );
      }

      // Send virksomhedstilknytninger i to separate lister:
      // 1. Ejede selskaber (med ejerandel) — bruges til formue/værdispørgsmål
      // 2. Funktionsroller uden ejerandel — bruges til spørgsmål om netværk, bestyrelser osv.
      if (pageData.personVirksomheder && pageData.personVirksomheder.length > 0) {
        const aktive = pageData.personVirksomheder.filter((v) => v.aktiv);
        const ejerSelskaber = aktive.filter((v) => v.ejerandel !== null);
        const funktionsRoller = aktive.filter((v) => v.ejerandel === null);

        if (ejerSelskaber.length > 0) {
          const lines = [
            `\n[EJERSKAB] Personens ejede selskaber med registreret ejerandel (${ejerSelskaber.length} stk) — brug KUN disse til formue- og værdiopgørelser:`,
          ];
          for (const v of ejerSelskaber) {
            const branche = v.branche ? ` | ${v.branche}` : '';
            lines.push(`- ${v.navn} (CVR: ${v.cvr}) | Ejerandel: ${v.ejerandel}${branche}`);
          }
          parts.push(lines.join('\n'));
        }

        if (funktionsRoller.length > 0) {
          const lines = [
            `\n[FUNKTIONSROLLER] Selskaber hvor personen er direktør/bestyrelsesmedlem uden registreret ejerandel (${funktionsRoller.length} stk) — brug til netværks-, bestyrelses- og tilknytningsspørgsmål, IKKE til formueberegning:`,
          ];
          for (const v of funktionsRoller.slice(0, 15)) {
            const roller = v.roller.length > 0 ? ` | ${v.roller.join(', ')}` : '';
            const branche = v.branche ? ` | ${v.branche}` : '';
            lines.push(`- ${v.navn} (CVR: ${v.cvr})${roller}${branche}`);
          }
          if (funktionsRoller.length > 15) {
            lines.push(`(+ ${funktionsRoller.length - 15} yderligere)`);
          }
          parts.push(lines.join('\n'));
        }
      }
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }, [pathname, pageData, a]);

  /** Send besked til AI og stream svar — blokerer hvis token-grænsen er nået */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // ── Token limit check (uses in-memory subscription context) ──
    const sub = ctxSub;
    if (sub) {
      const plan = resolvePlan(sub.planId);

      // Block if user's subscription is not active
      if (sub.status !== 'active') {
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: text },
          {
            role: 'assistant',
            content: sub.status === 'pending' ? a.subPending : a.subInactive,
          },
        ]);
        setInput('');
        return;
      }

      // Block if subscription is not functional (unpaid, no trial)
      if (!isSubscriptionFunctional(sub, plan)) {
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: text },
          {
            role: 'assistant',
            content:
              lang === 'da'
                ? 'Dit abonnement mangler betaling. Gå til indstillinger for at gennemføre betalingen.'
                : 'Your subscription requires payment. Go to settings to complete payment.',
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
            content: a.aiNotIncluded,
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
            content: a.tokensExhausted.replace('{used}', used).replace('{limit}', limit),
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
        const err = await res.json().catch(() => ({ error: a.serverError }));
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: err.error ?? a.genericError },
        ]);
        setIsLoading(false);
        return;
      }

      // ── Parse SSE stream ──
      const reader = res.body?.getReader();
      if (!reader) throw new Error(a.noStream);

      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      try {
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
                // Update token usage in-memory + sync to server
                addTokenUsage(parsed.usage.totalTokens);
                syncTokenUsageToServer(parsed.usage.totalTokens);
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
      } finally {
        // Frigør ReadableStream-ressourcen eksplicit (BIZZ-126)
        reader.releaseLock();
        reader.cancel().catch(() => {});
      }

      // Flyt streamed tekst til message-array
      if (accumulated) {
        setMessages((prev) => [...prev, { role: 'assistant', content: accumulated }]);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Brugeren stoppede streaming — gem hvad vi har
        const current = streamText || a.stopped;
        setMessages((prev) => [...prev, { role: 'assistant', content: current }]);
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: a.connectionError }]);
      }
    } finally {
      setStreamText('');
      setToolStatus('');
      setIsLoading(false);
      abortRef.current = null;
      refreshTokenInfo();
    }
  }, [
    input,
    isLoading,
    messages,
    buildContext,
    streamText,
    refreshTokenInfo,
    a,
    addTokenUsage,
    ctxSub,
    lang,
  ]);

  return (
    <div
      className={`border-t border-white/10 bg-[#0f172a] flex flex-col overflow-hidden transition-[flex] duration-200 ${
        isOpen ? 'flex-1 min-h-0' : 'shrink-0'
      }`}
      style={isOpen ? undefined : { height: COLLAPSED_HEIGHT }}
    >
      {/* ── Header / toggle ──────────────────────────────────────────────── */}
      <div className="shrink-0">
        <button
          onClick={togglePanel}
          aria-expanded={isOpen}
          aria-label={isOpen ? 'Luk AI-assistent' : 'Åbn AI-assistent'}
          className="w-full flex items-center justify-between px-4 py-3 cursor-pointer select-none hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-blue-600/25 rounded-md flex items-center justify-center shrink-0">
              <Sparkles size={11} className="text-blue-400" />
            </div>
            <span className="text-slate-300 text-sm font-medium">{a.title}</span>
            {messages.length > 0 && !isOpen && (
              <span className="w-1.5 h-1.5 bg-blue-500 rounded-full shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Pop-out knap — åbner modal */}
            <button
              onClick={toggleExpanded}
              className="text-slate-500 hover:text-slate-300 transition-colors shrink-0 p-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label={isExpanded ? 'Luk pop-out' : 'Åbn i større vindue'}
              title={isExpanded ? 'Luk pop-out' : 'Åbn i større vindue'}
            >
              {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <ChevronDown
              size={14}
              className={`text-slate-500 transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`}
            />
          </div>
        </button>

        {/* ── Token status — mini bar under overskriften ── */}
        {tokenInfo &&
          (tokenInfo.limit > 0 || tokenInfo.limit === -1) &&
          (() => {
            const isRed = tokenInfo.limit > 0 && tokenInfo.used / tokenInfo.limit > 0.9;
            const Wrapper = isRed ? 'button' : 'div';
            return (
              <Wrapper
                className={`flex items-center gap-2 px-4 pb-2 w-full ${isRed ? 'cursor-pointer hover:bg-white/5 rounded-lg transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset' : ''}`}
                {...(isRed
                  ? {
                      onClick: () => router.push('/dashboard/tokens'),
                      title: lang === 'da' ? 'Køb flere tokens' : 'Buy more tokens',
                    }
                  : {})}
              >
                <span className="text-[10px] text-slate-400 whitespace-nowrap">
                  {a.tokenStatus}
                </span>
                {tokenInfo.limit === -1 ? (
                  <>
                    <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-purple-500 w-full" />
                    </div>
                    <span className="text-[10px] font-medium text-purple-400 whitespace-nowrap">
                      ∞
                    </span>
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
                        style={{
                          width: `${Math.min(100, (tokenInfo.used / tokenInfo.limit) * 100)}%`,
                        }}
                      />
                    </div>
                    <span
                      className={`text-[10px] font-medium whitespace-nowrap ${
                        tokenInfo.used / tokenInfo.limit > 0.9
                          ? 'text-red-400'
                          : tokenInfo.used / tokenInfo.limit > 0.7
                            ? 'text-amber-400'
                            : 'text-slate-400'
                      }`}
                    >
                      {Math.min(100, Math.round((tokenInfo.used / tokenInfo.limit) * 100))}%
                    </span>
                    {isRed && (
                      <span className="text-[9px] text-red-400 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                        {lang === 'da' ? 'Køb mere →' : 'Buy more →'}
                      </span>
                    )}
                  </>
                )}
              </Wrapper>
            );
          })()}
        {/* AI disclaimer */}
        <p className="px-4 pb-2 text-xs text-slate-500">
          ⚠️ Svar genereret af AI er ikke nødvendigvis korrekte. Verificér altid vigtig information.
        </p>
      </div>

      {/* ── Chat-indhold ─────────────────────────────────────────────────── */}
      {isOpen && !subActive && (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-6">
          <div className="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center mb-3">
            <Lock size={18} className="text-amber-400" />
          </div>
          <p className="text-slate-400 text-xs leading-relaxed max-w-[180px]">
            {lang === 'da'
              ? 'AI-assistenten kræver et aktivt abonnement.'
              : 'The AI assistant requires an active subscription.'}
          </p>
        </div>
      )}
      {isOpen && subActive && (
        <>
          {/* Beskeder */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5 min-h-0">
            {messages.length === 0 && !streamText ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-4">
                <div className="w-10 h-10 bg-blue-600/20 rounded-xl flex items-center justify-center mb-3">
                  <Bot size={20} className="text-blue-400" />
                </div>
                <p className="text-slate-400 text-xs leading-relaxed max-w-[180px]">
                  {a.emptyPrompt}
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

          {/* Input-felt (sidebar) */}
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
                placeholder={a.inputPlaceholder}
                className="flex-1 bg-transparent text-slate-300 text-xs placeholder-slate-600 focus:outline-none"
              />
              {isLoading ? (
                <button
                  onClick={stopStreaming}
                  className="text-red-400 hover:text-red-300 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded"
                  aria-label={a.stopLabel}
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  onClick={sendMessage}
                  disabled={!input.trim()}
                  className="text-blue-400 hover:text-blue-300 disabled:text-slate-600 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                  aria-label={a.sendLabel}
                >
                  <Send size={13} />
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Pop-out modal via portal ──────────────────────────────────────── */}
      {isMounted &&
        isExpanded &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center p-4"
            style={{ backgroundColor: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
            onClick={(e) => {
              // Luk ved klik på backdrop
              if (e.target === e.currentTarget) setIsExpanded(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="ai-modal-title"
              className="flex flex-col w-full max-w-3xl bg-[#0f172a] border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden"
              style={{ height: 'min(80vh, 720px)' }}
            >
              {/* Modal header */}
              <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-slate-700/50">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 bg-blue-600/25 rounded-lg flex items-center justify-center">
                    <Sparkles size={13} className="text-blue-400" />
                  </div>
                  <span id="ai-modal-title" className="text-slate-200 text-sm font-semibold">
                    {a.title}
                  </span>
                  {isLoading && toolStatus && (
                    <span className="text-[11px] text-blue-400/80 font-medium">{toolStatus}</span>
                  )}
                </div>
                <button
                  onClick={() => setIsExpanded(false)}
                  className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded-lg hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  aria-label="Luk pop-out"
                >
                  <Minimize2 size={15} />
                </button>
              </div>

              {/* Token bar + disclaimer */}
              {tokenInfo && (tokenInfo.limit > 0 || tokenInfo.limit === -1) && (
                <div className="shrink-0 flex items-center gap-2 px-5 py-2 border-b border-slate-700/30">
                  <span className="text-[10px] text-slate-400 whitespace-nowrap">
                    {a.tokenStatus}
                  </span>
                  <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                    {tokenInfo.limit === -1 ? (
                      <div className="h-full rounded-full bg-purple-500 w-full" />
                    ) : (
                      <div
                        className={`h-full rounded-full transition-all ${
                          tokenInfo.used / tokenInfo.limit > 0.9
                            ? 'bg-red-500'
                            : tokenInfo.used / tokenInfo.limit > 0.7
                              ? 'bg-amber-500'
                              : 'bg-blue-500'
                        }`}
                        style={{
                          width: `${Math.min(100, (tokenInfo.used / tokenInfo.limit) * 100)}%`,
                        }}
                      />
                    )}
                  </div>
                  <span className="text-[10px] font-medium text-slate-400 whitespace-nowrap">
                    {tokenInfo.limit === -1
                      ? '∞'
                      : `${Math.min(100, Math.round((tokenInfo.used / tokenInfo.limit) * 100))}%`}
                  </span>
                </div>
              )}

              {/* Locked state */}
              {!subActive && (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
                  <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center mb-4">
                    <Lock size={22} className="text-amber-400" />
                  </div>
                  <p className="text-slate-400 text-sm leading-relaxed max-w-xs">
                    {lang === 'da'
                      ? 'AI-assistenten kræver et aktivt abonnement.'
                      : 'The AI assistant requires an active subscription.'}
                  </p>
                </div>
              )}

              {/* Chat body */}
              {subActive && (
                <>
                  <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
                    {messages.length === 0 && !streamText ? (
                      <div className="flex flex-col items-center justify-center h-full text-center py-8">
                        <div className="w-12 h-12 bg-blue-600/20 rounded-xl flex items-center justify-center mb-4">
                          <Bot size={24} className="text-blue-400" />
                        </div>
                        <p className="text-slate-400 text-sm leading-relaxed max-w-xs">
                          {a.emptyPrompt}
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
                              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                                msg.role === 'user'
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-slate-800/80 text-slate-200 border border-slate-700/40'
                              }`}
                            >
                              {msg.content}
                            </div>
                          </div>
                        ))}

                        {/* Live streaming-tekst */}
                        {streamText && (
                          <div className="flex justify-start">
                            <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-slate-800/80 text-slate-200 border border-slate-700/40">
                              {streamText}
                              <span className="inline-block w-1.5 h-4 bg-blue-400/70 ml-0.5 animate-pulse rounded-sm" />
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {/* Tænke-animation */}
                    {isLoading && !streamText && (
                      <div className="flex justify-start">
                        <div className="bg-slate-800/80 border border-slate-700/40 rounded-2xl px-4 py-3 flex flex-col gap-2">
                          <div className="flex gap-1.5">
                            <span
                              className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"
                              style={{ animationDelay: '0ms' }}
                            />
                            <span
                              className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"
                              style={{ animationDelay: '140ms' }}
                            />
                            <span
                              className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"
                              style={{ animationDelay: '280ms' }}
                            />
                          </div>
                          {toolStatus && (
                            <span className="text-xs text-blue-400/80 font-medium">
                              {toolStatus}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    <div ref={modalMessagesEndRef} />
                  </div>

                  {/* AI disclaimer */}
                  <p className="shrink-0 px-5 pb-1 text-xs text-slate-500">
                    ⚠️ Svar genereret af AI er ikke nødvendigvis korrekte. Verificér altid vigtig
                    information.
                  </p>

                  {/* Modal input-felt */}
                  <div className="shrink-0 px-5 pb-5 pt-2">
                    <div className="flex items-center gap-3 bg-slate-800/60 border border-slate-700/40 rounded-xl px-4 py-3 focus-within:border-blue-500/50 transition-colors">
                      <input
                        ref={modalInputRef}
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                          }
                        }}
                        placeholder={a.inputPlaceholder}
                        className="flex-1 bg-transparent text-slate-200 text-sm placeholder-slate-600 focus:outline-none"
                      />
                      {isLoading ? (
                        <button
                          onClick={stopStreaming}
                          className="text-red-400 hover:text-red-300 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded"
                          aria-label={a.stopLabel}
                        >
                          <Square size={16} />
                        </button>
                      ) : (
                        <button
                          onClick={sendMessage}
                          disabled={!input.trim()}
                          className="text-blue-400 hover:text-blue-300 disabled:text-slate-600 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                          aria-label={a.sendLabel}
                        >
                          <Send size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

export default memo(AIChatPanel);
