/**
 * Unit tests for app/lib/teamAuth.ts (BIZZ-271).
 *
 * DB-afhængige helpers (resolveTeamContext, requireTenantAdmin) testes via
 * integration tests. Her fokuserer vi på den rene utility: token-generering.
 */
import { describe, it, expect } from 'vitest';
import { generateInvitationToken } from '@/app/lib/teamAuth';

describe('generateInvitationToken', () => {
  it('returnerer en base64url-string af længde 43', () => {
    const t = generateInvitationToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBe(43); // 32 bytes base64url uden padding
  });

  it('genererer unikke tokens på tværs af kald', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(generateInvitationToken());
    // Alle 100 skal være forskellige — collision-risk er praktisk talt 0
    expect(tokens.size).toBe(100);
  });

  it('indeholder ikke padding-karakterer eller slash/plus', () => {
    const t = generateInvitationToken();
    expect(t).not.toContain('=');
    expect(t).not.toContain('+');
    expect(t).not.toContain('/');
  });
});
