/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import ChatPageClient from './ChatPageClient';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return <ChatPageClient />;
}
