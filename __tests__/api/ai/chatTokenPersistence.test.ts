/**
 * BIZZ-2205: Verificerer at AI-chat-routens token-persistering er wired så
 * skrivningerne overlever stream-close.
 *
 * Rod-årsag (2. iteration): den første fix pakkede persisteringen i after(),
 * men after() blev kaldt INDE i stream-controlleren EFTER controller.close() —
 * dér er request-scopet returneret, så callbacken eksekverede ikke på Vercel →
 * ai_token_usage forblev tom trods forbrug (verificeret i prod 2026-08-05).
 * Korrekt fix: await skrivningerne FØR [DONE]+controller.close() mens funktionen
 * stadig kører (SSE-heartbeat holder forbindelsen i live under skrivningen).
 *
 * Strategi: source-code assertion (samme mønster som generateListingTokenTracking).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('AI-chat token-persistering — source verification (BIZZ-2205)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'app/api/ai/chat/route.ts'), 'utf-8');

  it('bruger IKKE after() til post-close-persistering (den virkede ikke i streamen)', () => {
    // Regressionsvagt: after() efter controller.close() må ikke genindføres.
    expect(source).not.toContain('after(async () => {');
  });

  it("await'er token-audit FØR controller.close() (ikke efter)", () => {
    // I hver streaming-exit-sti skal recordTenantTokenUsage await'es, efterfulgt
    // (inden for samme blok) af [DONE] + controller.close(). Regex bekræfter
    // rækkefølgen: audit-skrivning → ... → [DONE] → close.
    expect(source).toMatch(
      /await recordTenantTokenUsage\([\s\S]{0,900}?sse\(controller, '\[DONE\]'\);[\s\S]{0,80}?controller\.close\(\)/
    );
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
