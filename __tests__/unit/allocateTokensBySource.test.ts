/**
 * Unit-tests for BIZZ-643 allocateTokensBySource — prioritets-dekrement
 * i rækkefølgen plan → bonus → topUp.
 *
 * Safety-kritisk fordi forkert rækkefølge ville få brugerens betalte
 * top-up-tokens til at brænde af før gratis plan-quota, hvilket er en
 * direkte forringelse af kundeværdi.
 */

import { describe, it, expect } from 'vitest';
import { allocateTokensBySource } from '@/app/api/ai/chat/route';

describe('allocateTokensBySource — prioritets-rækkefølge', () => {
  it('bruger plan-tokens først når der er quota tilbage', () => {
    const result = allocateTokensBySource(500, {
      planTokens: 1000,
      planTokensUsed: 0,
      bonusTokens: 200,
      topUpTokens: 300,
      tokensUsedThisMonth: 0,
    });
    expect(result.planTokensUsed).toBe(500);
    expect(result.bonusTokens).toBe(200); // uændret
    expect(result.topUpTokens).toBe(300); // uændret
    expect(result.tokensUsedThisMonth).toBe(500);
  });

  it('går videre til bonus-tokens når plan-quota er opbrugt', () => {
    const result = allocateTokensBySource(500, {
      planTokens: 1000,
      planTokensUsed: 900, // 100 tilbage
      bonusTokens: 1000,
      topUpTokens: 500,
      tokensUsedThisMonth: 900,
    });
    expect(result.planTokensUsed).toBe(1000); // fyldt op
    expect(result.bonusTokens).toBe(600); // 1000 - 400 = 600
    expect(result.topUpTokens).toBe(500); // uændret
    expect(result.tokensUsedThisMonth).toBe(1400);
  });

  it('går helt til top-up når både plan og bonus er opbrugt', () => {
    const result = allocateTokensBySource(300, {
      planTokens: 100,
      planTokensUsed: 100, // opbrugt
      bonusTokens: 50,
      topUpTokens: 1000,
      tokensUsedThisMonth: 100,
    });
    expect(result.planTokensUsed).toBe(100); // uændret
    expect(result.bonusTokens).toBe(0); // opbrugt
    expect(result.topUpTokens).toBe(750); // 1000 - 250 = 750
    expect(result.tokensUsedThisMonth).toBe(400);
  });

  it('under trial (planTokens=0) starter direkte med bonus', () => {
    const result = allocateTokensBySource(150, {
      planTokens: 0, // trial: plan-tokens låst
      planTokensUsed: 0,
      bonusTokens: 100,
      topUpTokens: 500,
      tokensUsedThisMonth: 0,
    });
    expect(result.planTokensUsed).toBe(0); // uændret
    expect(result.bonusTokens).toBe(0); // opbrugt
    expect(result.topUpTokens).toBe(450); // 500 - 50 = 450
    expect(result.tokensUsedThisMonth).toBe(150);
  });

  it('trial uden bonus — alle tokens går fra top-up', () => {
    const result = allocateTokensBySource(200, {
      planTokens: 0,
      planTokensUsed: 0,
      bonusTokens: 0,
      topUpTokens: 500,
      tokensUsedThisMonth: 0,
    });
    expect(result.topUpTokens).toBe(300);
    expect(result.tokensUsedThisMonth).toBe(200);
  });

  it('registrerer forbrug selvom alle kilder er tomme (gate stopper næste request)', () => {
    const result = allocateTokensBySource(100, {
      planTokens: 0,
      planTokensUsed: 0,
      bonusTokens: 0,
      topUpTokens: 0,
      tokensUsedThisMonth: 0,
    });
    expect(result.tokensUsedThisMonth).toBe(100);
    expect(result.planTokensUsed).toBe(0);
    expect(result.bonusTokens).toBe(0);
    expect(result.topUpTokens).toBe(0);
  });

  it('dækker krydset af tre kilder i én kørsel', () => {
    // 50 plan + 30 bonus + 20 topUp = 100 total
    const result = allocateTokensBySource(100, {
      planTokens: 100,
      planTokensUsed: 50, // 50 plan-tokens tilbage
      bonusTokens: 30,
      topUpTokens: 500,
      tokensUsedThisMonth: 50,
    });
    expect(result.planTokensUsed).toBe(100); // +50 → opbrugt
    expect(result.bonusTokens).toBe(0); // -30 → opbrugt
    expect(result.topUpTokens).toBe(480); // -20
    expect(result.tokensUsedThisMonth).toBe(150);
  });

  it('runder decimal consumed-værdier ned via Math.floor', () => {
    const result = allocateTokensBySource(99.7, {
      planTokens: 1000,
      planTokensUsed: 0,
      bonusTokens: 0,
      topUpTokens: 0,
      tokensUsedThisMonth: 0,
    });
    expect(result.planTokensUsed).toBe(99);
    expect(result.tokensUsedThisMonth).toBe(99);
  });

  it('negativt eller nul-consumption er no-op', () => {
    const result = allocateTokensBySource(0, {
      planTokens: 100,
      planTokensUsed: 50,
      bonusTokens: 10,
      topUpTokens: 20,
      tokensUsedThisMonth: 50,
    });
    expect(result).toEqual({
      planTokensUsed: 50,
      bonusTokens: 10,
      topUpTokens: 20,
      tokensUsedThisMonth: 50,
    });
  });
});
