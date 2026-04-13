'use client';

/**
 * AIChatContext — shared conversation state between drawer panel and full-page chat.
 *
 * Manages conversations in localStorage via chatStorage.ts.
 * Both AIChatPanel (drawer) and ChatPageClient consume this context
 * so conversations started in one are visible in the other.
 *
 * Also holds `drawerOpen` state for the topbar slide-out drawer.
 *
 * @module context/AIChatContext
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import {
  loadConversations,
  saveConversations,
  generateId,
  deriveTitle,
  STORAGE_KEY,
  type Conversation,
  type ChatMessage,
} from '@/app/lib/chatStorage';

// ─── Context interface ──────────────────────────────────────────────────────

interface AIChatContextValue {
  /** All persisted conversations (newest first) */
  conversations: Conversation[];
  /** Currently active conversation ID */
  activeId: string | null;
  /** Messages for the active conversation */
  messages: ChatMessage[];
  /** Whether the topbar drawer is open */
  drawerOpen: boolean;
  /** Open/close the drawer */
  setDrawerOpen: (open: boolean) => void;
  /** Create a new empty conversation and select it */
  createConversation: (lang: 'da' | 'en') => string;
  /** Select an existing conversation */
  selectConversation: (id: string) => void;
  /** Delete a conversation */
  deleteConversation: (id: string) => void;
  /** Set messages for the active conversation (e.g. during streaming) */
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Persist the current messages to the active conversation in localStorage */
  persistConversation: (id: string, updatedMessages: ChatMessage[]) => void;
  /** Auto-title a conversation from the first user message */
  titleConversation: (id: string, firstMessage: string) => void;
  /** Ensure there is an active conversation, creating one if needed */
  ensureConversation: (lang: 'da' | 'en') => string;
}

const AIChatContext = createContext<AIChatContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────────────────────

export function AIChatContextProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drawerOpen, setDrawerOpenRaw] = useState(false);

  // Load conversations from localStorage on mount
  useEffect(() => {
    setConversations(loadConversations());
  }, []);

  // Auto-close drawer when navigating to full-page chat
  useEffect(() => {
    if (pathname === '/dashboard/chat') {
      setDrawerOpenRaw(false);
    }
  }, [pathname]);

  // Cross-tab sync: listen for localStorage changes from other tabs
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setConversations(loadConversations());
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const setDrawerOpen = useCallback((open: boolean) => {
    setDrawerOpenRaw(open);
  }, []);

  const createConversation = useCallback(
    (lang: 'da' | 'en'): string => {
      const newConv: Conversation = {
        id: generateId(),
        title: lang === 'da' ? 'Ny samtale' : 'New conversation',
        messages: [],
        createdAt: new Date().toISOString(),
      };
      const updated = [newConv, ...conversations];
      saveConversations(updated);
      setConversations(updated);
      setActiveId(newConv.id);
      setMessages([]);
      return newConv.id;
    },
    [conversations],
  );

  const selectConversation = useCallback(
    (id: string) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return;
      setActiveId(id);
      setMessages(conv.messages);
    },
    [conversations],
  );

  const deleteConversation = useCallback(
    (id: string) => {
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
    [conversations, activeId],
  );

  const persistConversation = useCallback((id: string, updatedMessages: ChatMessage[]) => {
    const fresh = loadConversations();
    const updated = fresh.map((c) => (c.id === id ? { ...c, messages: updatedMessages } : c));
    saveConversations(updated);
    setConversations(updated);
  }, []);

  const titleConversation = useCallback((id: string, firstMessage: string) => {
    const fresh = loadConversations();
    const updated = fresh.map((c) => (c.id === id ? { ...c, title: deriveTitle(firstMessage) } : c));
    saveConversations(updated);
    setConversations(updated);
  }, []);

  const ensureConversation = useCallback(
    (lang: 'da' | 'en'): string => {
      if (activeId) return activeId;
      return createConversation(lang);
    },
    [activeId, createConversation],
  );

  return (
    <AIChatContext.Provider
      value={{
        conversations,
        activeId,
        messages,
        drawerOpen,
        setDrawerOpen,
        createConversation,
        selectConversation,
        deleteConversation,
        setMessages,
        persistConversation,
        titleConversation,
        ensureConversation,
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
