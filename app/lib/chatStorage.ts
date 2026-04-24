/**
 * Shared conversation persistence utilities for AI Chat.
 *
 * Single source of truth for localStorage operations.
 * Used by both AIChatContext (drawer panel) and ChatPageClient (full page).
 *
 * @module lib/chatStorage
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * BIZZ-812: Metadata about a file the user attached to this message.
 * We store name/type/size (NOT the extracted text, which is already
 * folded into `content` and would blow localStorage quotas). The chip
 * renderer uses this to show vedhæftninger inline with the bubble.
 */
export interface ChatAttachmentMeta {
  name: string;
  file_type: string;
  size: number;
  truncated?: boolean;
  /**
   * BIZZ-812: Server-side persistens-reference (public.ai_file.id).
   * Sendes med i chat-request attachments-array så tool-use i BIZZ-813
   * kan reference binæret. Null hvis persistens fejlede (fallback er
   * tekst-injection som før).
   */
  file_id?: string | null;
}

/**
 * BIZZ-814: Metadata for en AI-genereret fil knyttet til en assistant-
 * besked. Persisteres i localStorage så chippen overlever reload.
 *
 * BIZZ-815: preview_kind + columns/rows for XLSX/CSV så preview-panelet
 * kan vise HTML-tabel med sticky header i stedet for plain tekst.
 */
export interface ChatGeneratedFileMeta {
  file_id: string;
  file_name: string;
  download_url: string;
  preview_text: string;
  bytes: number;
  format: string;
  /** BIZZ-815: 'table' for xlsx/csv, 'text' for docx */
  preview_kind?: 'text' | 'table';
  preview_columns?: string[];
  preview_rows?: string[][];
}

/** A single chat message */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** BIZZ-812: optional attachment metadata — renders as chips. */
  attachments?: ChatAttachmentMeta[];
  /** BIZZ-814: optional AI-generated-file metadata — renders as download chips. */
  generatedFiles?: ChatGeneratedFileMeta[];
}

/** A persisted conversation stored in localStorage */
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ba-chat-history';
const MAX_TITLE_LENGTH = 40;

// ─── Functions ──────────────────────────────────────────────────────────────

/**
 * Generate a unique conversation ID.
 * @returns A random alphanumeric string prefixed with timestamp
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Load all conversations from localStorage.
 * @returns Array of conversations, newest first
 */
export function loadConversations(): Conversation[] {
  if (typeof window === 'undefined') return [];
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
 * @param conversations - Full list of conversations to persist
 */
export function saveConversations(conversations: Conversation[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Derive conversation title from first user message.
 * @param firstMessage - The first user message text
 * @returns Truncated title string (max 40 chars)
 */
export function deriveTitle(firstMessage: string): string {
  const clean = firstMessage.trim().replace(/\n/g, ' ');
  return clean.length > MAX_TITLE_LENGTH ? clean.slice(0, MAX_TITLE_LENGTH) + '\u2026' : clean;
}

/** The localStorage key used for conversation persistence */
export { STORAGE_KEY };
