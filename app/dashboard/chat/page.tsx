/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * AI chat is only available when NEXT_PUBLIC_AI_ENABLED=true (dev only).
 */
import { redirect } from 'next/navigation';
import ChatPageClient from './ChatPageClient';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  if (process.env.NEXT_PUBLIC_AI_ENABLED !== 'true') {
    redirect('/dashboard');
  }
  return <ChatPageClient />;
}
