/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * BIZZ-236: AI access is gated by subscription plan, not env var.
 */
import ChatPageClient from './ChatPageClient';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return <ChatPageClient />;
}
