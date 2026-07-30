/**
 * BIZZ-2205: Verificerer at AI-chat-routens token-persistering er wired så
 * skrivningerne overlever stream-close.
 *
 * Rod-årsag: token-/audit-skrivninger skete fire-and-forget EFTER
 * controller.close() uden waitUntil → Vercel termineret funktionen → 0 rækker
 * i tenant.ai_token_usage. Fix: pak persisteringen i after() (next/server) og
 * fjern den redundante recordAiUsage (double-count + duplikat-audit).
 *
 * Strategi: source-code assertion (samme mønster som generateListingTokenTracking).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('AI-chat token-persistering — source verification (BIZZ-2205)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'app/api/ai/chat/route.ts'), 'utf-8');

  it('importerer after fra next/server', () => {
    expect(source).toMatch(/import \{[^}]*\bafter\b[^}]*\} from 'next\/server'/);
  });

  it('pakker post-close-persistering i after()', () => {
    expect(source).toContain('after(async () => {');
  });

  it('awaiter recordTenantTokenUsage inde i after (ikke fire-and-forget efter close)', () => {
    expect(source).toContain('await recordTenantTokenUsage(');
  });

  it('awaiter persistChatMessages inde i after (chat-historik bevares)', () => {
    expect(source).toContain('await persistChatMessages(');
  });

  it('recordTenantTokenUsage returnerer Promise (awaitable)', () => {
    expect(source).toMatch(/function recordTenantTokenUsage\([\s\S]*?\): Promise<void>/);
  });

  it('kalder IKKE længere den redundante recordAiUsage i chat-routen', () => {
    expect(source).not.toContain('recordAiUsage({');
  });
});
