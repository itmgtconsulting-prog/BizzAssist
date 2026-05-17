/**
 * BIZZ-1601: Verificerer at generate-listing og generate-finance-report
 * importerer og kalder recordAiUsage korrekt.
 *
 * Strategi: Source-code assertion — verificerer at import + kald eksisterer
 * i route-filerne, samt unit-tester den specifikke gren der kalder
 * recordAiUsage efter stream.finalMessage().
 *
 * E2E-testen (e2e/ai-token-tracking.spec.ts) verificerer hele kæden
 * mod test.bizzassist.dk — her tester vi kun at koden er wired korrekt.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('AI token tracking — source verification (BIZZ-1601)', () => {
  const routeDir = path.join(process.cwd(), 'app/api/ai');

  describe('generate-listing/route.ts', () => {
    const source = fs.readFileSync(path.join(routeDir, 'generate-listing/route.ts'), 'utf-8');

    it('importerer recordAiUsage fra aiTracking', () => {
      expect(source).toContain("import { recordAiUsage } from '@/app/lib/aiTracking'");
    });

    it('kalder recordAiUsage med route ai.generate-listing', () => {
      expect(source).toContain("route: 'ai.generate-listing'");
    });

    it('kalder claudeStream.finalMessage() for usage-data', () => {
      expect(source).toContain('claudeStream.finalMessage()');
    });

    it('sender SSE usage-event med inputTokens, outputTokens, totalTokens', () => {
      expect(source).toMatch(/sse\(JSON\.stringify\(\{[\s\S]*?usage:/);
      expect(source).toContain('totalTokens: inputTokens + outputTokens');
    });

    it('recordAiUsage-kald er EFTER finalMessage (kun på succes-gren)', () => {
      const finalMsgIdx = source.indexOf('claudeStream.finalMessage()');
      const recordIdx = source.indexOf('void recordAiUsage(');
      expect(recordIdx).toBeGreaterThan(finalMsgIdx);
    });

    it('bruger void for fire-and-forget (ikke await)', () => {
      expect(source).toContain('void recordAiUsage(');
    });
  });

  describe('generate-finance-report/route.ts', () => {
    const source = fs.readFileSync(
      path.join(routeDir, 'generate-finance-report/route.ts'),
      'utf-8'
    );

    it('importerer recordAiUsage fra aiTracking', () => {
      expect(source).toContain("import { recordAiUsage } from '@/app/lib/aiTracking'");
    });

    it('kalder recordAiUsage med route ai.generate-finance-report', () => {
      expect(source).toContain("route: 'ai.generate-finance-report'");
    });

    it('kalder claudeStream.finalMessage() for usage-data', () => {
      expect(source).toContain('claudeStream.finalMessage()');
    });

    it('sender SSE usage-event med inputTokens, outputTokens, totalTokens', () => {
      expect(source).toMatch(/sse\(JSON\.stringify\(\{[\s\S]*?usage:/);
      expect(source).toContain('totalTokens: inputTokens + outputTokens');
    });

    it('recordAiUsage-kald er EFTER finalMessage (kun på succes-gren)', () => {
      const finalMsgIdx = source.indexOf('claudeStream.finalMessage()');
      const recordIdx = source.indexOf('void recordAiUsage(');
      // recordAiUsage should come after finalMessage
      expect(recordIdx).toBeGreaterThan(finalMsgIdx);
    });

    it('bruger void for fire-and-forget (ikke await)', () => {
      expect(source).toContain('void recordAiUsage(');
    });
  });

  describe('alle billable AI endpoints har recordAiUsage', () => {
    const billableEndpoints = [
      'chat/route.ts',
      'generate-listing/route.ts',
      'generate-finance-report/route.ts',
      'article-search/route.ts',
      'article-search/articles/route.ts',
      'article-search/socials/route.ts',
      'person-search/contacts/route.ts',
      'person-search/articles/route.ts',
      'person-search/socials/route.ts',
      'person-article-search/route.ts',
      'forklar-vurdering/route.ts',
    ];

    for (const endpoint of billableEndpoints) {
      it(`${endpoint} kalder recordAiUsage eller recordTenantTokenUsage`, () => {
        const filePath = path.join(routeDir, endpoint);
        const source = fs.readFileSync(filePath, 'utf-8');
        const hasTracking =
          source.includes('recordAiUsage') || source.includes('recordTenantTokenUsage');
        expect(hasTracking).toBe(true);
      });
    }

    it('analysis/run/route.ts kalder recordAiUsage', () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'app/api/analysis/run/route.ts'),
        'utf-8'
      );
      expect(source).toContain('recordAiUsage');
    });
  });

  describe('alle billable AI endpoints har assertAiAllowed gate', () => {
    const billableEndpoints = [
      'chat/route.ts',
      'generate-listing/route.ts',
      'generate-finance-report/route.ts',
      'article-search/route.ts',
      'article-search/articles/route.ts',
      'article-search/socials/route.ts',
      'person-search/contacts/route.ts',
      'person-search/articles/route.ts',
      'person-search/socials/route.ts',
      'person-article-search/route.ts',
      'forklar-vurdering/route.ts',
    ];

    for (const endpoint of billableEndpoints) {
      it(`${endpoint} kalder assertAiAllowed`, () => {
        const filePath = path.join(routeDir, endpoint);
        const source = fs.readFileSync(filePath, 'utf-8');
        expect(source).toContain('assertAiAllowed');
      });
    }
  });

  describe('non-billable endpoints er bevidst udeladt', () => {
    it('support/chat har IKKE assertAiAllowed (bevidst ��� BIZZ-654)', () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), 'app/api/support/chat/route.ts'),
        'utf-8'
      );
      expect(source).not.toContain('assertAiAllowed(');
      expect(source).toContain('BIZZ-654'); // dokumenteret beslutning
    });

    it('export-listing-pdf bruger ikke Claude (kun PDF-generation)', () => {
      const source = fs.readFileSync(path.join(routeDir, 'export-listing-pdf/route.ts'), 'utf-8');
      // Importerer assertAiAllowed som gate, men kalder IKKE Anthropic direkte
      expect(source).not.toContain('new Anthropic(');
      expect(source).not.toContain('client.messages');
    });
  });
});
