'use client';

/**
 * AIChatContext — shared conversation state between drawer panel and
 * full-page chat.
 *
 * BIZZ-820: Persistens flyttet fra localStorage til Supabase (via
 * /api/ai/sessions + /api/ai/sessions/[id] + /api/ai/sessions/[id]/messages).
 * I denne iter bruger vi polling (5s) for aktiv session — Realtime
 * integration (ALTER PUBLICATION i BIZZ-819 migration 075) unblocker
 * iter 2 hvor vi skifter til Supabase Realtime-subscribe for sub-sekund
 * cross-device sync.
 *
 * Både AIChatPanel (drawer) og ChatPageClient bruger denne context så
 * conversations startet i én overflade er synlige i den anden.
 *
 * Public interface holdt bagudkompatibelt med chatStorage-versionen så
 * callers ikke skal ændres (bortset fra at passe session_id til
 * /api/ai/chat).
 *
 * @module context/AIChatContext
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import type { ChatMessage, Conversation } from '@/app/lib/chatStorage';
import { migrateChatHistoryToSupabase } from '@/app/lib/migrateLocalStorage';

// ─── API types (matcher /api/ai/sessions) ───────────────────────────────────

interface ApiSession {
  id: string;
  title: string | null;
  context_type?: string | null;
  context_id?: string | null;
  created_at: string;
  last_msg_at?: string | null;
  archived_at?: string | null;
}

interface ApiMessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  created_at: string;
}

// ─── Context interface ──────────────────────────────────────────────────────

interface AIChatContextValue {
  /** All persisted conversations (newest first) */
  conversations: Conversation[];
  /** Currently active conversation ID (matches session_id i API) */
  activeId: string | null;
  /** Messages for the active conversation */
  messages: ChatMessage[];
  /** Whether the topbar drawer is open */
  drawerOpen: boolean;
  /** Open/close the drawer */
  setDrawerOpen: (open: boolean) => void;
  /** Live streaming text from drawer (visible to fullpage chat during streaming) */
  streamText: string;
  setStreamText: (text: string) => void;
  /** Tool status from drawer (visible to fullpage chat during streaming) */
  toolStatus: string;
  setToolStatus: (status: string) => void;
  /** Whether the drawer is currently streaming a response */
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;
  /** Create a new empty conversation and select it */
  createConversation: (lang: 'da' | 'en') => Promise<string | null>;
  /** Select an existing conversation */
  selectConversation: (id: string) => Promise<void>;
  /** Delete a conversation */
  deleteConversation: (id: string) => Promise<void>;
  /** Set messages for the active conversation (used during streaming) */
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /**
   * No-op i API-versionen: /api/ai/chat persisterer user + assistant
   * messages server-side via session_id-hook. Beholdt for bagudkompat.
   * BIZZ-839: accepterer null-id så callers kan bruge stateless-mode.
   */
  persistConversation: (id: string | null, updatedMessages: ChatMessage[]) => void;
  /** Auto-title a conversation from the first user message */
  titleConversation: (id: string, firstMessage: string) => Promise<void>;
  /** Ensure there is an active conversation, creating one if needed */
  ensureConversation: (lang: 'da' | 'en') => Promise<string | null>;
  /**
   * BIZZ-872: True hvis /api/ai/sessions returnerer 401/500 — indikerer at
   * brugerens samtaler ikke kan persisteres til Supabase. UI skal vise
   * warning-banner så brugeren ved at chat-historik er ephemeral.
   */
  persistenceError: boolean;
}

const AIChatContext = createContext<AIChatContextValue | null>(null);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Coerce server-persisted content-jsonb til ChatMessage.content-string.
 * persistChatMessages skriver `{text: '...'}`. Legacy-migrerede
 * rows kan være plain strings. Array/objekt → JSON-serialisér.
 */
function coerceContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

/**
 * BIZZ-869 part 2: Ekstrahér generatedFiles fra persisteret content
 * JSONB så download-chips kan re-hydrateres efter reload eller cross-
 * device login. Persistens-formatet er `{ text, generatedFiles: [...] }`.
 * Returnerer undefined hvis feltet mangler, så eksisterende rows uden
 * attachments bare opfører sig som før.
 */
function extractGeneratedFiles(raw: unknown): ChatMessage['generatedFiles'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const gf = obj.generatedFiles;
  if (!Array.isArray(gf) || gf.length === 0) return undefined;
  // Shallow-validate: hver entry skal have file_id + file_name + bytes + format.
  return gf.filter(
    (g): g is NonNullable<ChatMessage['generatedFiles']>[number] =>
      !!g &&
      typeof g === 'object' &&
      typeof (g as Record<string, unknown>).file_id === 'string' &&
      typeof (g as Record<string, unknown>).file_name === 'string' &&
      typeof (g as Record<string, unknown>).format === 'string'
  );
}

function apiRowToMessage(row: ApiMessageRow): ChatMessage | null {
  if (row.role !== 'user' && row.role !== 'assistant') return null;
  const msg: ChatMessage = {
    role: row.role,
    content: coerceContent(row.content),
  };
  // BIZZ-869 part 2: genskab download-chips efter reload
  if (row.role === 'assistant') {
    const gf = extractGeneratedFiles(row.content);
    if (gf && gf.length > 0) msg.generatedFiles = gf;
  }
  return msg;
}

function apiSessionToConversation(s: ApiSession): Conversation {
  return {
    id: s.id,
    title: s.title ?? 'Samtale',
    messages: [],
    createdAt: s.created_at,
  };
}

// ─── Provider ───────────────────────────────────────────────────────────────

/**
 * Provider der loader conversations fra /api/ai/sessions ved mount og
 * bruger polling (5s) for aktiv session. Kører én-gangs localStorage
 * migration første gang context mounter med auth.
 */
export function AIChatContextProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drawerOpen, setDrawerOpenRaw] = useState(false);
  const [streamText, setStreamTextRaw] = useState('');
  const [toolStatus, setToolStatusRaw] = useState('');
  const [isStreaming, setIsStreamingRaw] = useState(false);
  // BIZZ-872: Tracker om persistens-API er tilgængelig
  const [persistenceError, setPersistenceError] = useState(false);

  /**
   * BIZZ-873: Watchdog for isStreaming — auto-reset efter 90s af
   * inaktivitet så input ikke sidder fast efter afbrudte streams
   * (navigation, tab-close, network drop, error mellem
   * setIsStreaming(true) og finally-blokken).
   *
   * streamStartedAtRef opdateres hver gang isStreaming sættes til true
   * eller streamText modtages nye chunks. Watchdog tjekker hver 10s
   * om der er gået mere end 90s uden aktivitet → auto-reset.
   */
  const streamStartedAtRef = useRef<number | null>(null);
  const setIsStreaming = useCallback((streaming: boolean) => {
    setIsStreamingRaw(streaming);
    if (streaming) {
      streamStartedAtRef.current = Date.now();
    } else {
      streamStartedAtRef.current = null;
    }
  }, []);
  const setStreamText = useCallback((text: string) => {
    setStreamTextRaw(text);
    // Enhver chunk-opdatering nulstiller watchdog-timer
    if (text) streamStartedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    const WATCHDOG_INTERVAL_MS = 10_000;
    const STUCK_THRESHOLD_MS = 90_000;
    const handle = setInterval(() => {
      if (!isStreaming || streamStartedAtRef.current === null) return;
      const elapsed = Date.now() - streamStartedAtRef.current;
      if (elapsed > STUCK_THRESHOLD_MS) {
        console.warn(`[AIChatContext] isStreaming stuck for ${elapsed}ms — auto-reset`);
        setIsStreamingRaw(false);
        setStreamTextRaw('');
        setToolStatusRaw('');
        streamStartedAtRef.current = null;
      }
    }, WATCHDOG_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [isStreaming]);

  /**
   * BIZZ-873: Visibility-change handler — når brugeren returnerer til tab
   * efter lang fravær og isStreaming er stuck (elapsed > threshold), reset.
   * Dækker scenarie hvor browser har paused baggrunds-timers.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isStreaming || streamStartedAtRef.current === null) return;
      const elapsed = Date.now() - streamStartedAtRef.current;
      if (elapsed > 90_000) {
        console.warn(`[AIChatContext] visibility-regained, stream stuck ${elapsed}ms — reset`);
        setIsStreamingRaw(false);
        setStreamTextRaw('');
        setToolStatusRaw('');
        streamStartedAtRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [isStreaming]);

  // Seneste message-timestamp for aktiv session (bruges til polling ?since=)
  const lastPolledRef = useRef<string | null>(null);

  // ── Fetch sessions-list ──────────────────────────────────────────────────
  const refreshConversations = useCallback(async (): Promise<Conversation[]> => {
    try {
      const res = await fetch('/api/ai/sessions?limit=100');
      if (!res.ok) {
        // BIZZ-872: 401 = ingen tenant_membership eller auth udløbet.
        // 500 = DB-fejl. Sæt flag så UI viser warning om ephemeral chat.
        if (res.status === 401 || res.status >= 500) {
          console.warn(`[AIChatContext] sessions-list ${res.status} — persistens utilgængelig`);
          setPersistenceError(true);
        }
        return [];
      }
      // Success → clear error-flag hvis det var sat
      setPersistenceError(false);
      const data = (await res.json()) as { sessions?: ApiSession[] };
      const convs = (data.sessions ?? []).map(apiSessionToConversation);
      setConversations(convs);
      return convs;
    } catch {
      return [];
    }
  }, []);

  // ── Initial load + migration ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshConversations();
      if (cancelled) return;
      // Engangs-migration af localStorage → Supabase. Kører efter sessions
      // er loadet så vi ikke duplikerer hvis migration allerede er done.
      try {
        const migrated = await migrateChatHistoryToSupabase();
        if (!cancelled && migrated > 0) {
          // Genindlæs listen så migrerede conversations er synlige
          await refreshConversations();
        }
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshConversations]);

  // ── Auto-close drawer ved navigation til fullpage ────────────────────────
  useEffect(() => {
    if (pathname === '/dashboard/chat') {
      setDrawerOpenRaw(false);
    }
  }, [pathname]);

  // ── Polling fallback for aktiv session ───────────────────────────────────
  // Sub-sekund Realtime kommer i iter 2 via Supabase publication (migration
  // 075). Indtil da: poll hver 5s efter messages oprettet EFTER sidste kendte
  // timestamp. Ingen polling hvis vi streamer (optimistic state ejer UI).
  useEffect(() => {
    if (!activeId || isStreaming) return;
    const handle = setInterval(async () => {
      try {
        const since = lastPolledRef.current;
        const qs = since ? `?since=${encodeURIComponent(since)}` : '';
        const res = await fetch(`/api/ai/sessions/${activeId}/messages${qs}`);
        if (!res.ok) return;
        const data = (await res.json()) as { messages?: ApiMessageRow[] };
        const rows = data.messages ?? [];
        if (rows.length === 0) return;
        const newMsgs = rows.map(apiRowToMessage).filter((m): m is ChatMessage => m !== null);
        if (newMsgs.length > 0) {
          setMessages((prev) => [...prev, ...newMsgs]);
        }
        lastPolledRef.current = rows[rows.length - 1].created_at;
      } catch {
        /* transient netværksfejl */
      }
    }, 5000);
    return () => clearInterval(handle);
  }, [activeId, isStreaming]);

  // ── Drawer toggle ────────────────────────────────────────────────────────
  const setDrawerOpen = useCallback((open: boolean) => {
    setDrawerOpenRaw(open);
  }, []);

  // ── Create ───────────────────────────────────────────────────────────────
  const createConversation = useCallback(async (lang: 'da' | 'en'): Promise<string | null> => {
    try {
      const res = await fetch('/api/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: lang === 'da' ? 'Ny samtale' : 'New conversation',
        }),
      });
      if (!res.ok) {
        // BIZZ-872: Logg + set error-flag så UI kan vise banner.

        console.warn(`[AIChatContext] createConversation ${res.status} — persistens utilgængelig`);
        if (res.status === 401 || res.status >= 500) {
          setPersistenceError(true);
        }
        return null;
      }
      // Success → clear error-flag
      setPersistenceError(false);
      const data = (await res.json()) as { session?: ApiSession };
      const s = data.session;
      if (!s) return null;
      const conv = apiSessionToConversation(s);
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      setMessages([]);
      lastPolledRef.current = null;
      return conv.id;
    } catch (err) {
      console.warn('[AIChatContext] createConversation exception:', err);
      setPersistenceError(true);
      return null;
    }
  }, []);

  // ── Select ───────────────────────────────────────────────────────────────
  const selectConversation = useCallback(async (id: string): Promise<void> => {
    setActiveId(id);
    setMessages([]);
    lastPolledRef.current = null;
    try {
      const res = await fetch(`/api/ai/sessions/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        session?: ApiSession;
        messages?: ApiMessageRow[];
      };
      const rows = data.messages ?? [];
      const msgs = rows.map(apiRowToMessage).filter((m): m is ChatMessage => m !== null);
      setMessages(msgs);
      if (rows.length > 0) {
        lastPolledRef.current = rows[rows.length - 1].created_at;
      }
    } catch {
      /* best-effort */
    }
  }, []);

  // ── Delete ───────────────────────────────────────────────────────────────
  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      try {
        await fetch(`/api/ai/sessions/${id}`, { method: 'DELETE' });
      } catch {
        /* ignorer — UI opdateres alligevel */
      }
      setConversations((prev) => {
        const updated = prev.filter((c) => c.id !== id);
        if (activeId === id) {
          if (updated.length > 0) {
            // Vælg næste øverste uden fetch — vis tom messages indtil select
            setActiveId(updated[0].id);
            setMessages([]);
            lastPolledRef.current = null;
          } else {
            setActiveId(null);
            setMessages([]);
            lastPolledRef.current = null;
          }
        }
        return updated;
      });
    },
    [activeId]
  );

  // ── Persist (no-op) ──────────────────────────────────────────────────────
  // Server-side /api/ai/chat persisterer user + assistant messages via
  // session_id-hook (BIZZ-819). Callerne må fortsat kalde funktionen for
  // bagudkompat men den laver intet lokalt (messages lever i state).
  const persistConversation = useCallback(
    (_id: string | null, _updatedMessages: ChatMessage[]): void => {
      void _id;
      void _updatedMessages;
    },
    []
  );

  // ── Title ────────────────────────────────────────────────────────────────
  const titleConversation = useCallback(async (id: string, firstMessage: string): Promise<void> => {
    const MAX = 40;
    const clean = firstMessage.trim().replace(/\n/g, ' ');
    const title = clean.length > MAX ? `${clean.slice(0, MAX)}\u2026` : clean;
    try {
      const res = await fetch(`/api/ai/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  // ── Ensure ───────────────────────────────────────────────────────────────
  const ensureConversation = useCallback(
    async (lang: 'da' | 'en'): Promise<string | null> => {
      if (activeId) return activeId;
      return createConversation(lang);
    },
    [activeId, createConversation]
  );

  return (
    <AIChatContext.Provider
      value={{
        conversations,
        activeId,
        messages,
        drawerOpen,
        setDrawerOpen,
        streamText,
        // BIZZ-873: setStreamText wraps raw setter med watchdog-timer reset
        setStreamText,
        toolStatus,
        setToolStatus: setToolStatusRaw,
        isStreaming,
        // BIZZ-873: setIsStreaming wraps raw setter med watchdog-timer init
        setIsStreaming,
        createConversation,
        selectConversation,
        deleteConversation,
        setMessages,
        persistConversation,
        titleConversation,
        ensureConversation,
        // BIZZ-872: Expose persistence-error til UI-laget
        persistenceError,
      }}
    >
      {children}
    </AIChatContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Access the shared AI chat state.
 * Must be used within an AIChatContextProvider.
 */
export function useAIChatContext(): AIChatContextValue {
  const ctx = useContext(AIChatContext);
  if (!ctx) throw new Error('useAIChatContext must be used within AIChatContextProvider');
  return ctx;
}
