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
import { usePathname, useRouter } from 'next/navigation';
import {
  Send,
  Bot,
  Sparkles,
  Square,
  Maximize2,
  X,
  Plus,
  CreditCard,
  AlertTriangle,
  Paperclip,
  FileText,
  Loader2,
  Eye,
} from 'lucide-react';
import MarkdownContent from '@/app/components/MarkdownContent';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { resolvePlan, isSubscriptionFunctional, formatTokens } from '@/app/lib/subscriptions';
import { useSubscriptionAccess } from '@/app/components/SubscriptionGate';
import { useSubscription } from '@/app/context/SubscriptionContext';
import { useAIPageContext } from '@/app/context/AIPageContext';
import { useAIChatContext } from '@/app/context/AIChatContext';
import { useDocPreview } from '@/app/context/DocPreviewContext';
// BIZZ-820: Chat-historik flyttet fra localStorage til Supabase via
// /api/ai/sessions. Context-context.messages bærer nu den aktive session.
import { Lock } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** BIZZ-812: Attached files (metadata only — extracted text lives in content). */
  attachments?: Array<{
    name: string;
    file_type: string;
    size: number;
    truncated?: boolean;
  }>;
  /**
   * BIZZ-814: AI-genererede filer fra generate_document tool-use.
   * Rendres som klikbare chips under assistant-beskeden med download-link
   * + eye-ikon for at åbne DocPreview (BIZZ-815).
   */
  generatedFiles?: Array<{
    file_id: string;
    file_name: string;
    download_url: string;
    preview_text: string;
    bytes: number;
    format: string;
    /** BIZZ-815: binary-aware preview */
    preview_kind?: 'text' | 'table' | 'html';
    preview_columns?: string[];
    preview_rows?: string[][];
    /** BIZZ-868: sanitiseret html-preview for docx-filer */
    preview_html?: string;
  }>;
}

/**
 * BIZZ-806: In-memory attachment held by the chat UI between the user
 * picking a file and pressing Send. The extracted text is prepended to
 * the next user message so Claude receives it as context; the `preview`
 * powers the chip + modal in the input area.
 */
interface ChatAttachment {
  id: string;
  name: string;
  file_type: string;
  size: number;
  extracted_text: string;
  preview: string;
  truncated: boolean;
  /**
   * BIZZ-812: Server-side persistens-reference til ai_file row. Sendes
   * med i chat-request så tool-use kan reference binæret. Null hvis
   * persistens fejlede.
   */
  file_id?: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Højde når panelet er lukket (kun header synlig) */

// ─── Token usage tracking ────────────────────────────────────────────────────

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
  /** Shared conversation context — syncs with fullpage chat */
  const chatCtx = useAIChatContext();
  /** BIZZ-807: Global right-side document preview panel */
  const docPreview = useDocPreview();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  /** Streamet tekst for den aktuelle assistent-besked */
  const [streamText, setStreamText] = useState('');
  /** Status-besked under tool-kald (f.eks. "Henter BBR-data…") */
  const [toolStatus, setToolStatus] = useState('');
  /** Token usage state — refreshed after each AI response */
  const [tokenInfo, setTokenInfo] = useState<{ used: number; limit: number } | null>(null);
  /**
   * BIZZ-642: Trial-gate banner. Sættes når /api/ai/chat returnerer 402 med
   * code='trial_ai_blocked' — brugeren er i free trial uden token-pakke.
   * Nul = ingen banner. Når sat, rendres CTA-banner øverst i chat-panelet.
   */
  const [trialBlocked, setTrialBlocked] = useState<{ message: string } | null>(null);
  /**
   * BIZZ-643: Per-kilde token-balance efter hvert AI-kald.
   * Serveren sender planRemaining + bonusRemaining + topUpRemaining med
   * usage-event. Rendres som linje "Plan: X, Bonus: Y, Købt: Z" i chat-UI
   * så brugeren kan se præcis hvor deres tokens kommer fra.
   */
  const [tokenBalance, setTokenBalance] = useState<{
    plan: number;
    bonus: number;
    topUp: number;
  } | null>(null);
  /** BIZZ-806: attachments queued for the next message */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** AbortController for at kunne stoppe streaming */
  const abortRef = useRef<AbortController | null>(null);
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
  }, [refreshTokenInfo]);

  /** Sync local messages when:
   *  1. Active conversation changes (e.g. fullpage "Ny samtale")
   *  2. Drawer becomes visible (user navigates away from /dashboard/chat)
   *  Does NOT sync during active streaming to avoid overwriting. */
  const prevActiveIdRef = useRef<string | null>(null);
  const prevDrawerOpenRef = useRef(chatCtx.drawerOpen);
  useEffect(() => {
    const activeChanged = chatCtx.activeId !== prevActiveIdRef.current;
    const drawerJustOpened = chatCtx.drawerOpen && !prevDrawerOpenRef.current;

    prevActiveIdRef.current = chatCtx.activeId;
    prevDrawerOpenRef.current = chatCtx.drawerOpen;

    if ((activeChanged || drawerJustOpened) && !isLoading) {
      // BIZZ-820: Context.messages er allerede loaded via API når fuldpage
      // eller drawer åbner — adoptér state-of-truth uden at kalde
      // localStorage direkte. selectConversation hydrerer selv via API.
      setMessages(chatCtx.messages);
      setStreamText('');
      setToolStatus('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatCtx.activeId, chatCtx.drawerOpen, isLoading]);

  /** BIZZ-810: Keep drawer in sync with fullpage while the app is running.
   *  When context messages grow past our local copy (because the other
   *  surface persisted a new turn), adopt them as-is. Guarded by
   *  !isLoading so we don't clobber our own in-flight compose. */
  useEffect(() => {
    if (isLoading) return;
    if (chatCtx.messages.length > messages.length) {
      setMessages(chatCtx.messages);
    }
  }, [chatCtx.messages, isLoading, messages.length]);

  /** Scroll til bunden ved nye beskeder eller stream-opdatering */
  useEffect(() => {
    {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamText]);

  /** Fokuser input første gang panelet åbnes */
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    {
      timerId = setTimeout(() => inputRef.current?.focus(), 150);
    }
    return () => clearTimeout(timerId);
  }, []);

  /** BIZZ-222: Navigate to full-page chat with current conversation */
  const openFullPageChat = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const convId = chatCtx.activeId;
      router.push(convId ? `/dashboard/chat?conversationId=${convId}` : '/dashboard/chat');
    },
    [router, chatCtx.activeId]
  );

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
      // BIZZ-874: pageType + activeTab så AI kan matche "oversigt tab"/
      // "ejendomme tab"-referencer til rigtige tools.
      if (pageData.pageType) fields.push(`Side-type: ${pageData.pageType}`);
      if (pageData.activeTab) fields.push(`Aktivt tab: ${pageData.activeTab}`);
      if (fields.length > 0) {
        parts.push(
          "Tilgængelige ID'er (brug direkte i tool-kald — ingen yderligere søgning nødvendig):\n" +
            fields.join('\n')
        );
      }

      // BIZZ-902: Domain-sag-kontekst — når bruger har en sag åben og
      // har valgt dokumenter, injicér navne + IDs så AI direkte kan
      // referere dem via hent_dokument_indhold(docId). AI ved fra
      // system-prompt at brugeren allerede har valgt dokumenterne og
      // behøver ikke bede om dem igen.
      if (pageData.currentCaseId && pageData.currentCaseName) {
        const lines = [
          `\n[DOMAIN-SAG] Bruger arbejder i sagen "${pageData.currentCaseName}" (ID: ${pageData.currentCaseId}).`,
        ];
        if (pageData.caseStatus) lines.push(`Sags-status: ${pageData.caseStatus}.`);
        if (pageData.caseClientRef) lines.push(`Klient-reference: ${pageData.caseClientRef}.`);
        if (pageData.caseTags && pageData.caseTags.length > 0)
          lines.push(`Tags: ${pageData.caseTags.join(', ')}.`);
        // BIZZ-937: Klient-kontekst — AI skal kende den linkede kunde
        if (pageData.caseClient) {
          const c = pageData.caseClient;
          const id = c.kind === 'person' ? `enhedsNummer: ${c.enhedsNummer}` : `CVR: ${c.cvr}`;
          lines.push(
            `Linket klient: ${c.name} (${c.kind === 'person' ? 'PERSON' : 'VIRKSOMHED'}, ${id}). ` +
              'Du KENDER allerede klienten — bed IKKE brugeren om CVR eller navn. ' +
              (c.kind === 'person' && c.enhedsNummer
                ? `Brug enhedsNummer=${c.enhedsNummer} til hent_ejendomme_for_person og andre person-tools.`
                : c.kind === 'company' && c.cvr
                  ? `Brug CVR=${c.cvr} til hent_ejendomme_for_virksomhed og andre virksomheds-tools.`
                  : '')
          );
        }
        if (pageData.selectedDocuments && pageData.selectedDocuments.length > 0) {
          lines.push(
            `Brugeren har VALGT ${pageData.selectedDocuments.length} dokument${pageData.selectedDocuments.length === 1 ? '' : 'er'} som AI-kontekst — brug disse som primær reference. Kald hent_dokument_indhold(docId) for at læse indholdet. Bed IKKE brugeren om at vælge dokumenter igen.`
          );
          for (const d of pageData.selectedDocuments) {
            lines.push(`- ${d.name} (docId: ${d.id})`);
          }
        }
        // BIZZ-930: Skabelon-kontekst — AI ved hvilke skabeloner der er valgt
        if (pageData.selectedTemplates && pageData.selectedTemplates.length > 0) {
          lines.push(
            `Brugeren har valgt ${pageData.selectedTemplates.length} skabelon${pageData.selectedTemplates.length === 1 ? '' : 'er'} til denne sag:`
          );
          for (const t of pageData.selectedTemplates) {
            lines.push(`- ${t.name} (templateId: ${t.id})`);
          }
          lines.push(
            'Du kan hjælpe brugeren med at udfylde skabelon-felter baseret på sags-dokumenter og BizzAssist-data.'
          );
        }
        parts.push(lines.join('\n'));
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

      // BIZZ-941: Pre-loaded ejendomme — AI behøver ikke re-fetche
      if (pageData.preloadedEjendomme && pageData.preloadedEjendomme.length > 0) {
        const personlige = pageData.preloadedEjendomme.filter((e) => e.personligtEjet);
        const viaVirk = pageData.preloadedEjendomme.filter((e) => !e.personligtEjet);
        const lines = [
          `\n[EJENDOMME PRE-LOADED] ${pageData.preloadedEjendomme.length} ejendomme allerede loaded (total: ${pageData.ejendommeTotal ?? pageData.preloadedEjendomme.length}). Brug disse data direkte — kald IKKE hent_ejendomme_for_person medmindre du har brug for yderligere detaljer.`,
        ];
        if (personlige.length > 0) {
          lines.push(`Personligt ejede (${personlige.length}):`);
          for (const e of personlige.slice(0, 20)) {
            lines.push(
              `- BFE ${e.bfe}: ${e.adresse ?? 'Ukendt'} (${e.type ?? '?'})${e.ejerandel ? ` [${e.ejerandel}]` : ''}`
            );
          }
          if (personlige.length > 20) lines.push(`  (+ ${personlige.length - 20} flere)`);
        }
        if (viaVirk.length > 0) {
          lines.push(`Via virksomheder (${viaVirk.length}):`);
          for (const e of viaVirk.slice(0, 30)) {
            lines.push(
              `- BFE ${e.bfe}: ${e.adresse ?? 'Ukendt'} (${e.type ?? '?'})${e.ejerandel ? ` [${e.ejerandel}]` : ''}`
            );
          }
          if (viaVirk.length > 30) lines.push(`  (+ ${viaVirk.length - 30} flere)`);
        }
        parts.push(lines.join('\n'));
      }

      // BIZZ-941: Pre-loaded datterselskaber
      if (pageData.preloadedDatterselskaber && pageData.preloadedDatterselskaber.length > 0) {
        const aktive = pageData.preloadedDatterselskaber.filter((d) => d.aktiv);
        const lines = [
          `\n[DATTERSELSKABER PRE-LOADED] ${aktive.length} aktive datterselskaber. Brug disse data direkte — kald IKKE hent_datterselskaber medmindre du har brug for yderligere detaljer.`,
        ];
        for (const d of aktive.slice(0, 20)) {
          lines.push(`- ${d.navn} (CVR: ${d.cvr})${d.branche ? ` — ${d.branche}` : ''}`);
        }
        if (aktive.length > 20) lines.push(`  (+ ${aktive.length - 20} flere)`);
        parts.push(lines.join('\n'));
      }
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }, [pathname, pageData, a]);

  /**
   * BIZZ-806: Upload one or more files to /api/ai/attach. Each file gets
   * its text extracted server-side and stored as a ChatAttachment in
   * local state — the content is folded into the next sendMessage().
   */
  const uploadAttachments = useCallback(
    async (files: FileList | File[]) => {
      if (files.length === 0) return;
      setAttachBusy(true);
      setAttachError(null);
      try {
        for (const f of Array.from(files)) {
          const fd = new FormData();
          fd.append('file', f);
          const r = await fetch('/api/ai/attach', { method: 'POST', body: fd });
          if (!r.ok) {
            const j = (await r.json().catch(() => ({ error: 'Ukendt' }))) as { error?: string };
            setAttachError(j.error ?? (lang === 'da' ? 'Upload fejlede' : 'Upload failed'));
            continue;
          }
          const j = (await r.json()) as Omit<ChatAttachment, 'id'>;
          setAttachments((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              ...j,
            },
          ]);
        }
      } finally {
        setAttachBusy(false);
      }
    },
    [lang]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /**
   * BIZZ-867: Window-event listener så eksterne komponenter (diagram,
   * reports osv.) kan sende filer + åbne chat-drawer som én handling.
   * Event-payload: { files: File[] | FileList, prompt?: string }.
   * prompt fylder input-feltet så brugeren kan tilpasse før send.
   */
  useEffect(() => {
    const handler = async (event: Event) => {
      const ce = event as CustomEvent<{
        files?: File[] | FileList;
        prompt?: string;
      }>;
      const files = ce.detail?.files;
      const prompt = ce.detail?.prompt;
      if (files && (files as ArrayLike<File>).length > 0) {
        await uploadAttachments(files);
      }
      if (typeof prompt === 'string' && prompt.length > 0) {
        setInput(prompt);
      }
      chatCtx.setDrawerOpen(true);
    };
    window.addEventListener('bizz:ai-attach-files', handler);
    return () => window.removeEventListener('bizz:ai-attach-files', handler);
  }, [uploadAttachments, chatCtx]);

  /** Send besked til AI og stream svar — blokerer hvis token-grænsen er nået */
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isLoading) return;

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

    // BIZZ-806: Fold any attached files into the user message content so
    // Claude receives the extracted text as part of this turn. We block
    // each attachment with a header+type label, then the user's prompt.
    const attachmentBlock = attachments.length
      ? attachments
          .map(
            (att) =>
              `[Vedhæftet fil: ${att.name} — ${att.file_type.toUpperCase()}, ${Math.round(
                att.size / 1024
              )} KB${att.truncated ? ', beskåret' : ''}]\n${att.extracted_text}`
          )
          .join('\n\n---\n\n')
      : '';
    const composedContent = attachmentBlock
      ? `${attachmentBlock}\n\n---\n\n${text || '(ingen prompt — brug vedhæftede filer som kontekst)'}`
      : text;
    // BIZZ-812: also persist lightweight metadata so chips render in
    // chat history (the full extracted_text lives in content so the AI
    // keeps its context, but we hide that block from the bubble view).
    const attachmentsMeta = attachments.map((att) => ({
      name: att.name,
      file_type: att.file_type,
      size: att.size,
      truncated: att.truncated,
    }));
    const userMsg: Message = {
      role: 'user',
      content: composedContent,
      ...(attachmentsMeta.length > 0 ? { attachments: attachmentsMeta } : {}),
    };
    // Clear the chat attachments now — they're baked into this turn's
    // content.
    setAttachments([]);
    const newMessages = [...messages, userMsg];

    // BIZZ-820/839: Best-effort session-creation via /api/ai/sessions.
    // Hvis API fejler (401/403/500/tenant-memberships missing) → fortsæt
    // uden session_id i stateless-mode. Chat fungerer stadig ende-til-ende
    // via /api/ai/chat; kun cross-device persistens preller af. Tidligere
    // afbrød vi stille her og brugeren så ingen feedback — BIZZ-839 bug.
    const convId = await chatCtx.ensureConversation(lang as 'da' | 'en');
    if (convId) {
      // Auto-title from first user message (non-blocking)
      if (messages.length === 0) {
        void chatCtx.titleConversation(convId, text);
      }
      // persistConversation er no-op i API-versionen — server persisterer
      // via session_id-hook i /api/ai/chat. Beholdt for bagudkompat.
      chatCtx.persistConversation(convId, newMessages);
    }

    setInput('');
    setMessages(newMessages);
    chatCtx.setMessages(newMessages);
    setIsLoading(true);
    chatCtx.setIsStreaming(true);
    setStreamText('');
    chatCtx.setStreamText('');
    setToolStatus('');
    chatCtx.setToolStatus('');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // BIZZ-812: inkluder attachment file_id-array så tool-dispatcher
      // (BIZZ-813) kan slå op i ai_file + hente binær til template-fill.
      const attachmentRefs = attachments
        .filter((a) => a.file_id != null)
        .map((a) => ({
          file_id: a.file_id as string,
          name: a.name,
          file_type: a.file_type,
        }));
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          context: buildContext(),
          attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
          // BIZZ-820/839: Bind turn til aktiv session (persist-hook). Når
          // ensureConversation fejlede (convId null) springer vi
          // session_id over — server kører stateless-mode.
          ...(convId ? { session_id: convId } : {}),
        }),
        signal: controller.signal,
      });

      // ── Ikke-streaming fejl (manglende API-nøgle etc.) ──
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: a.serverError }));
        // BIZZ-642: Trial-gate — vis dedikeret banner med købs-CTA i stedet
        // for generisk fejl-besked. Brugeren har en fair action (køb
        // token-pakke) som løser blokeringen med det samme.
        // BIZZ-642/651: Alle AI-blokeringer (402 trial_ai_blocked, 503
        // ai_unavailable) viser samme buy-tokens-banner. Uniformt CTA
        // uanset årsag (trial / kvote / key missing / abonnement paused).
        if (
          (res.status === 402 && err.code === 'trial_ai_blocked') ||
          (res.status === 503 && err.code === 'ai_unavailable')
        ) {
          setTrialBlocked({ message: err.error ?? a.trialBlockedBody });
          setIsLoading(false);
          // Fjern den optimistisk-tilføjede user-besked fra UI fordi den
          // ikke blev besvaret — brugeren kan prøve igen efter køb.
          setMessages((prev) => prev.slice(0, -1));
          chatCtx.setMessages(newMessages.slice(0, -1));
          return;
        }
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: err.error ?? a.genericError },
        ]);
        setIsLoading(false);
        return;
      }
      // Ryd banner ved vellykket respons (fx efter bruger har købt pakke)
      setTrialBlocked(null);

      // ── Parse SSE stream ──
      const reader = res.body?.getReader();
      if (!reader) throw new Error(a.noStream);

      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';
      // BIZZ-814: accumulate generated-files fra SSE så de kan attachees
      // til final assistant-besked. Multi-file per tur (fx AI kalder tool
      // to gange i samme tur) understøttet.
      const generatedFiles: NonNullable<Message['generatedFiles']> = [];

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
                usage?: {
                  inputTokens: number;
                  outputTokens: number;
                  totalTokens: number;
                  /** BIZZ-643: Per-kilde-balance efter dette AI-kald */
                  planRemaining?: number;
                  bonusRemaining?: number;
                  topUpRemaining?: number;
                };
                /**
                 * BIZZ-814: generate_document tool-call resultat. Emittes
                 * før tool_result sendes tilbage til Claude så klienten
                 * kan vise chippen straks.
                 */
                generated_file?: {
                  file_id: string;
                  file_name: string;
                  download_url: string;
                  preview_text: string;
                  bytes: number;
                  format: string;
                  preview_kind?: 'text' | 'table' | 'html';
                  preview_columns?: string[];
                  preview_rows?: string[][];
                  preview_html?: string;
                };
              };
              // Only update UI if user is still viewing this conversation
              const isActive = chatCtx.activeId === convId;
              if (parsed.error) {
                accumulated += `\n⚠️ ${parsed.error}`;
                if (isActive) {
                  setStreamText(accumulated);
                  chatCtx.setStreamText(accumulated);
                }
              } else if (parsed.usage) {
                addTokenUsage(parsed.usage.totalTokens);
                // Server already persists tokens — removed to prevent double-counting (BIZZ-343)
                // syncTokenUsageToServer(parsed.usage.totalTokens);
                // BIZZ-643: Opdatér per-kilde-balance hvis serveren sendte den.
                if (
                  parsed.usage.planRemaining != null ||
                  parsed.usage.bonusRemaining != null ||
                  parsed.usage.topUpRemaining != null
                ) {
                  setTokenBalance({
                    plan: parsed.usage.planRemaining ?? 0,
                    bonus: parsed.usage.bonusRemaining ?? 0,
                    topUp: parsed.usage.topUpRemaining ?? 0,
                  });
                }
              } else if (parsed.status) {
                if (isActive) {
                  setToolStatus(parsed.status);
                  chatCtx.setToolStatus(parsed.status);
                }
              } else if (parsed.generated_file) {
                // BIZZ-814: buffer til senere attach på final message.
                // Vis status så brugeren ser progress mens Claude formulerer
                // sit opfølgende tekst-svar.
                generatedFiles.push(parsed.generated_file);
                if (isActive) {
                  setToolStatus(
                    `${lang === 'da' ? 'Fil genereret:' : 'File generated:'} ${parsed.generated_file.file_name}`
                  );
                  chatCtx.setToolStatus(
                    `${lang === 'da' ? 'Fil genereret:' : 'File generated:'} ${parsed.generated_file.file_name}`
                  );
                }
              } else if (parsed.t) {
                accumulated += parsed.t;
                if (isActive) {
                  if (accumulated === parsed.t) {
                    setToolStatus('');
                    chatCtx.setToolStatus('');
                  }
                  setStreamText(accumulated);
                  chatCtx.setStreamText(accumulated);
                }
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

      // Flyt streamed tekst til message-array + persist
      if (accumulated || generatedFiles.length > 0) {
        const finalAssistant: Message = {
          role: 'assistant',
          content: accumulated,
          // BIZZ-814: attach AI-genererede filer til messagen så chips
          // renderes under svaret og persisteres i localStorage.
          ...(generatedFiles.length > 0 ? { generatedFiles: [...generatedFiles] } : {}),
        };
        const finalMsgs = [...newMessages, finalAssistant];
        chatCtx.persistConversation(convId, finalMsgs);
        // BIZZ-839: Update local state if we're still on the same conversation,
        // OR if convId is null (stateless fallback — always update).
        if (!convId || chatCtx.activeId === convId) {
          setMessages(finalMsgs);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User aborted (e.g. clicked "Ny samtale") — persist partial response
        // to the ORIGINAL conversation but don't update local messages state
        // (which may now belong to a different conversation).
        const current = streamText || a.stopped;
        const finalMsgs = [...newMessages, { role: 'assistant' as const, content: current }];
        chatCtx.persistConversation(convId, finalMsgs);
        // BIZZ-839: Same fix — always update if stateless mode (convId null)
        if (!convId || chatCtx.activeId === convId) {
          setMessages(finalMsgs);
        }
      } else {
        const finalMsgs = [
          ...newMessages,
          { role: 'assistant' as const, content: a.connectionError },
        ];
        setMessages(finalMsgs);
        chatCtx.persistConversation(convId, finalMsgs);
      }
    } finally {
      setStreamText('');
      setToolStatus('');
      setIsLoading(false);
      chatCtx.setStreamText('');
      chatCtx.setToolStatus('');
      chatCtx.setIsStreaming(false);
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
    attachments,
    chatCtx,
  ]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0f172a]">
      {/* ── Drawer header ────────────────────────────────────────────────── */}
      <div className="shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-blue-600/25 rounded-lg flex items-center justify-center shrink-0">
              <Sparkles size={13} className="text-blue-400" />
            </div>
            <span className="text-slate-200 text-sm font-semibold">{a.title}</span>
            {isLoading && toolStatus && (
              <span className="text-[11px] text-blue-400/80 font-medium">{toolStatus}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* New conversation button — does NOT abort streaming; lets it finish in background */}
            <button
              onClick={() => {
                // Don't abort — let the old conversation's streaming finish
                // in background. Serveren persisterer den via session_id.
                abortRef.current = null;
                // BIZZ-820: createConversation er async (POST /api/ai/sessions)
                // — kør fire-and-forget; UI rydder straks.
                void chatCtx.createConversation(lang as 'da' | 'en');
                setMessages([]);
                // BIZZ-871: Ryd OGSÅ chatCtx.messages — ellers restores
                // sync-useEffect (line 208-213) de gamle messages fra context
                // lige efter lokal clear, så + knappen ikke har visuel effekt.
                chatCtx.setMessages([]);
                setStreamText('');
                setToolStatus('');
                setIsLoading(false);
                chatCtx.setStreamText('');
                chatCtx.setToolStatus('');
                chatCtx.setIsStreaming(false);
                setInput('');
                // Focus input så brugeren kan skrive med det samme
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
              className="text-slate-500 hover:text-slate-300 transition-colors shrink-0 p-1 rounded hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label={lang === 'da' ? 'Ny samtale' : 'New conversation'}
              title={lang === 'da' ? 'Ny samtale' : 'New conversation'}
            >
              <Plus size={14} />
            </button>
            <button
              onClick={openFullPageChat}
              className="text-slate-500 hover:text-slate-300 transition-colors shrink-0 p-1 rounded hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label={lang === 'da' ? 'Åbn fuld AI Chat' : 'Open full AI Chat'}
              title={lang === 'da' ? 'Åbn fuld AI Chat' : 'Open full AI Chat'}
            >
              <Maximize2 size={14} />
            </button>
            <button
              onClick={() => chatCtx.setDrawerOpen(false)}
              className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label={lang === 'da' ? 'Luk chat' : 'Close chat'}
            >
              <X size={16} />
            </button>
          </div>
        </div>

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
        {/* BIZZ-642: Trial-gate banner — vises når /api/ai/chat returnerer
            402 trial_ai_blocked. Dedikeret CTA lader brugeren købe en
            token-pakke uden at forlade chat-konteksten. */}
        {trialBlocked && (
          <div className="mx-4 mb-2 flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
            <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-amber-300 text-xs font-semibold mb-0.5">{a.trialBlockedTitle}</p>
              <p className="text-amber-400/80 text-[11px] leading-relaxed mb-2">
                {trialBlocked.message}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => router.push('/dashboard/tokens')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-[11px] font-medium transition-colors"
                >
                  <CreditCard size={11} />
                  {a.trialBlockedBuyCta}
                </button>
                <button
                  onClick={() => router.push('/dashboard/settings?tab=abonnement')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-700/40 hover:bg-slate-700/60 text-slate-300 text-[11px] transition-colors"
                >
                  {a.trialBlockedUpgradeCta}
                </button>
              </div>
            </div>
            <button
              onClick={() => setTrialBlocked(null)}
              className="text-amber-400/60 hover:text-amber-400 shrink-0 p-0.5"
              aria-label={lang === 'da' ? 'Luk banner' : 'Close banner'}
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* BIZZ-642: Vis top-up-balance når bruger har købt token-pakke,
            så de kan se præcis hvor mange tokens der er tilbage. */}
        {ctxSub?.topUpTokens != null && ctxSub.topUpTokens > 0 && (
          <p className="px-4 pb-2 text-[10px] text-emerald-400/80">
            {a.topUpBalance.replace(
              '{amount}',
              ctxSub.topUpTokens.toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB')
            )}
          </p>
        )}

        {/* BIZZ-643: Per-kilde-balance efter seneste AI-kald.
            Serveren sender planRemaining/bonusRemaining/topUpRemaining
            med usage-event og vi viser dem her så brugeren kan se
            hvor tokens kommer fra. Skjules hvis alle 3 er 0 (første
            load inden svar). */}
        {tokenBalance &&
          (tokenBalance.plan > 0 || tokenBalance.bonus > 0 || tokenBalance.topUp > 0) && (
            <p
              className="px-4 pb-2 text-[10px] text-slate-500 font-mono"
              title={
                lang === 'da'
                  ? 'Balance pr. kilde efter seneste kald'
                  : 'Balance per source after last call'
              }
            >
              <span className="text-slate-400">{lang === 'da' ? 'Plan: ' : 'Plan: '}</span>
              {tokenBalance.plan.toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB')}
              <span className="text-slate-600 mx-1.5">·</span>
              <span className="text-slate-400">{lang === 'da' ? 'Bonus: ' : 'Bonus: '}</span>
              {tokenBalance.bonus.toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB')}
              <span className="text-slate-600 mx-1.5">·</span>
              <span className="text-emerald-400/80">
                {lang === 'da' ? 'Købt: ' : 'Purchased: '}
              </span>
              <span className="text-emerald-400">
                {tokenBalance.topUp.toLocaleString(lang === 'da' ? 'da-DK' : 'en-GB')}
              </span>
            </p>
          )}

        {/* AI disclaimer */}
        <p className="px-4 pb-2 text-xs text-slate-500">
          ⚠️ Svar genereret af AI er ikke nødvendigvis korrekte. Verificér altid vigtig information.
        </p>
      </div>

      {/* ── Chat-indhold ─────────────────────────────────────────────────── */}
      {!subActive && (
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
      {subActive && (
        <>
          {/* Beskeder */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5 min-h-0">
            {messages.length === 0 && !streamText && !chatCtx.streamText ? (
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
                {messages.map((msg, i) => {
                  // BIZZ-812: Strip the attachment text-block from display —
                  // it's kept in content for the AI's context window but
                  // renders as chips instead of a wall of text.
                  const displayContent =
                    msg.role === 'user' && msg.attachments && msg.attachments.length > 0
                      ? msg.content
                          .split(/\n\n---\n\n/)
                          .slice(-1)[0]
                          .replace(/^\(ingen prompt.*\)$/u, '')
                      : msg.content;
                  return (
                    <div
                      key={i}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-blue-600 text-white whitespace-pre-wrap'
                            : 'bg-slate-800/80 text-slate-300 border border-slate-700/40'
                        }`}
                      >
                        {/* BIZZ-812: Attachment chips above the prompt text */}
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="space-y-1 mb-1.5">
                            {msg.attachments.map((att, ai) => (
                              <div
                                key={ai}
                                className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 ${
                                  msg.role === 'user'
                                    ? 'bg-white/10 text-white'
                                    : 'bg-slate-900/60 text-slate-200'
                                }`}
                              >
                                <FileText size={10} className="shrink-0 opacity-80" />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-[10.5px] font-medium">{att.name}</p>
                                  <p className="text-[9px] opacity-70 uppercase">
                                    {att.file_type} · {Math.round(att.size / 1024)} KB
                                    {att.truncated &&
                                      (lang === 'da' ? ' · beskåret' : ' · truncated')}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {/* BIZZ-223: Use MarkdownContent for assistant, plain text for user */}
                        {msg.role === 'assistant' ? (
                          <MarkdownContent text={displayContent} />
                        ) : (
                          displayContent
                        )}
                        {/* BIZZ-814: AI-genererede filer som chips under assistant-svaret */}
                        {msg.role === 'assistant' &&
                          msg.generatedFiles &&
                          msg.generatedFiles.length > 0 && (
                            <div className="mt-2 space-y-1">
                              {msg.generatedFiles.map((gf) => (
                                <div
                                  key={gf.file_id}
                                  className="flex items-center gap-1.5 rounded-md px-2 py-1.5 bg-slate-900/60 border border-blue-500/30"
                                >
                                  <FileText size={12} className="shrink-0 text-blue-300" />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[11px] font-medium text-white">
                                      {gf.file_name}
                                    </p>
                                    <p className="text-[9px] uppercase text-slate-400">
                                      {gf.format} · {(gf.bytes / 1024).toFixed(1)} KB
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      docPreview.open({
                                        name: gf.file_name,
                                        fileType: gf.format,
                                        text: gf.preview_text,
                                        downloadUrl: gf.download_url,
                                        sizeBytes: gf.bytes,
                                        // BIZZ-815: binary-aware preview
                                        kind: gf.preview_kind,
                                        columns: gf.preview_columns,
                                        rows: gf.preview_rows,
                                        // BIZZ-868: html-preview for docx
                                        html: gf.preview_html,
                                      })
                                    }
                                    aria-label={lang === 'da' ? 'Forhåndsvis' : 'Preview'}
                                    className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
                                    title={lang === 'da' ? 'Forhåndsvis' : 'Preview'}
                                  >
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                                      <circle cx="12" cy="12" r="3" />
                                    </svg>
                                  </button>
                                  <a
                                    href={gf.download_url}
                                    download={gf.file_name}
                                    aria-label={lang === 'da' ? 'Download' : 'Download'}
                                    className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
                                    title={lang === 'da' ? 'Download' : 'Download'}
                                  >
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                      <polyline points="7 10 12 15 17 10" />
                                      <line x1="12" y1="15" x2="12" y2="3" />
                                    </svg>
                                  </a>
                                </div>
                              ))}
                            </div>
                          )}
                      </div>
                    </div>
                  );
                })}

                {/* Live streaming-tekst — BIZZ-810: falder tilbage til context
                    hvis lokal state er tom (fx efter en re-sync). Sikrer at
                    drawer viser det samme svar som fullpage. */}
                {(() => {
                  const effective = streamText || chatCtx.streamText;
                  return effective ? (
                    <div className="flex justify-start">
                      <div className="max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed bg-slate-800/80 text-slate-300 border border-slate-700/40">
                        <MarkdownContent text={effective} />
                        <span className="inline-block w-1.5 h-3.5 bg-blue-400/70 ml-0.5 animate-pulse rounded-sm" />
                      </div>
                    </div>
                  ) : null;
                })()}
              </>
            )}

            {/* Tænke-animation + tool-status (før streaming starter) */}
            {(isLoading || chatCtx.isStreaming) && !streamText && !chatCtx.streamText && (
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
          <div className="px-3 pb-3 pt-1 shrink-0 space-y-2">
            {/* BIZZ-902: Domain-sag dokument-kontekst-chips. Info-only —
                viser brugeren hvilke docs AI har adgang til som kontekst.
                Fjernes via checkbox i workspace-panelet (ikke her — stammer
                fra pageData.selectedDocuments). */}
            {pageData?.selectedDocuments && pageData.selectedDocuments.length > 0 && (
              <div className="rounded-lg bg-blue-500/5 border border-blue-500/20 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wide text-blue-300 mb-1">
                  {lang === 'da'
                    ? `${pageData.selectedDocuments.length} ${pageData.selectedDocuments.length === 1 ? 'dokument' : 'dokumenter'} i kontekst`
                    : `${pageData.selectedDocuments.length} ${pageData.selectedDocuments.length === 1 ? 'document' : 'documents'} in context`}
                </p>
                <div className="flex flex-wrap gap-1">
                  {pageData.selectedDocuments.map((d) => (
                    <span
                      key={d.id}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-800/80 border border-blue-500/30 rounded text-[11px] text-slate-200 max-w-full"
                      title={d.name}
                    >
                      <Paperclip size={10} className="text-blue-300 shrink-0" />
                      <span className="truncate">{d.name}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* BIZZ-806: Attachment-chips vises over input-feltet. Klik
                åbner preview-modal. Klik på X fjerner. */}
            {(attachments.length > 0 || attachError) && (
              <div className="space-y-1">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex items-center gap-2 bg-slate-800/80 border border-slate-700/40 rounded-lg px-2 py-1.5"
                  >
                    <FileText size={12} className="text-blue-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-slate-200 truncate">{att.name}</p>
                      <p className="text-[10px] text-slate-500 uppercase">
                        {att.file_type} · {Math.round(att.size / 1024)} KB
                        {att.truncated && ` · ${lang === 'da' ? 'beskåret' : 'truncated'}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        docPreview.open({
                          key: `chat-attachment-${att.id}`,
                          name: att.name,
                          fileType: att.file_type,
                          sizeBytes: att.size,
                          text: att.extracted_text,
                          truncated: att.truncated,
                        })
                      }
                      aria-label={lang === 'da' ? 'Se preview' : 'Preview'}
                      title={lang === 'da' ? 'Se preview' : 'Preview'}
                      className="p-1 rounded text-slate-400 hover:text-blue-300 hover:bg-slate-700/40 transition-colors shrink-0"
                    >
                      <Eye size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.id)}
                      aria-label={lang === 'da' ? 'Fjern fil' : 'Remove file'}
                      className="p-1 rounded text-slate-400 hover:text-rose-300 hover:bg-slate-700/40 transition-colors shrink-0"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                {attachError && <p className="text-[10px] text-rose-300 px-1">{attachError}</p>}
              </div>
            )}
            <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/40 rounded-xl px-3 py-2 focus-within:border-blue-500/40 transition-colors">
              <label
                className="cursor-pointer text-slate-400 hover:text-blue-400 transition-colors shrink-0"
                aria-label={lang === 'da' ? 'Vedhæft fil' : 'Attach file'}
                title={lang === 'da' ? 'Vedhæft fil' : 'Attach file'}
              >
                {attachBusy ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Paperclip size={13} />
                )}
                <input
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void uploadAttachments(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
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
                  disabled={!input.trim() && attachments.length === 0}
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
    </div>
  );
}

export default memo(AIChatPanel);
