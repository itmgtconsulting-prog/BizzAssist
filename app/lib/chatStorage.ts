/**
 * Shared conversation persistence utilities for AI Chat.
 *
 * Single source of truth for localStorage operations.
 * Used by both AIChatContext (drawer panel) and ChatPageClient (full page).
 *
 * @module lib/chatStorage
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single chat message */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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
