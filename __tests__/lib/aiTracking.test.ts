/**
 * Unit tests for app/lib/aiTracking.ts (BIZZ-1594).
 *
 * Dækker recordAiUsage helper:
 * - Skip ved 0 tokens
 * - Skip ved manglende userId
 * - updateUserById opdaterer tokensUsedThisMonth med summen
 * - Insert til ai_token_usage med korrekte felter (når tenantId sat)
 * - Skipper insert hvis tenantId null (public AI-tools)
 * - Fail-soft: kaster IKKE ved DB/auth-fejl
 * - extractTokenUsage håndterer manglende usage-objekt
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { createAdminClient } from '@/lib/supabase/admin';
import { recordAiUsage, extractTokenUsage } from '@/app/lib/aiTracking';

const mockCreate = vi.mocked(createAdminClient);

function makeAdmin(
  opts: {
    currentTokensUsed?: number;
    getUserError?: { message: string } | null;
    updateUserError?: { message: string } | null;
    insertError?: { message: string } | null;
    captureInsert?: (row: unknown) => void;
  } = {}
) {
  const insert = vi.fn().mockImplementation((row: unknown) => {
    opts.captureInsert?.(row);
    return Promise.resolve({ error: opts.insertError ?? null });
  });
  const from = vi.fn().mockReturnValue({ insert });
  const schemaFn = vi.fn().mockReturnValue({ from });
  const getUserById = vi.fn().mockResolvedValue({
    data: opts.getUserError
      ? null
      : {
          user: {
            id: 'user-1',
            app_metadata: {
              subscription: { tokensUsedThisMonth: opts.currentTokensUsed ?? 0 },
            },
          },
        },
    error: opts.getUserError ?? null,
  });
  const updateUserById = vi.fn().mockResolvedValue({
    data: null,
    error: opts.updateUserError ?? null,
  });
  return {
    schema: schemaFn,
    auth: { admin: { getUserById, updateUserById } },
    _spy: { schemaFn, from, insert, getUserById, updateUserById },
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('recordAiUsage', () => {
  it('skipper ved 0 tokens (ingen DB-kald)', async () => {
    const admin = makeAdmin();
    mockCreate.mockReturnValue(admin as never);
    await recordAiUsage({
      userId: 'user-1',
      tenantId: 'tenant-1',
      route: 'ai.test',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(admin._spy.getUserById).not.toHaveBeenCalled();
    expect(admin._spy.insert).not.toHaveBeenCalled();
  });

  it('skipper ved manglende userId', async () => {
    const admin = makeAdmin();
    mockCreate.mockReturnValue(admin as never);
    await recordAiUsage({
      userId: '',
      tenantId: 'tenant-1',
      route: 'ai.test',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(admin._spy.getUserById).not.toHaveBeenCalled();
  });

  it('happy path: opdaterer app_metadata + inserter ai_token_usage', async () => {
    let capturedRow: Record<string, unknown> | null = null;
    const admin = makeAdmin({
      currentTokensUsed: 1000,
      captureInsert: (row) => {
        capturedRow = row as Record<string, unknown>;
      },
    });
    mockCreate.mockReturnValue(admin as never);

    await recordAiUsage({
      userId: 'user-1',
      tenantId: 'tenant-1',
      route: 'ai.chat',
      inputTokens: 250,
      outputTokens: 150,
      model: 'claude-sonnet-4-6',
    });

    expect(admin._spy.getUserById).toHaveBeenCalledWith('user-1');
    expect(admin._spy.updateUserById).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          subscription: expect.objectContaining({ tokensUsedThisMonth: 1400 }), // 1000 + 250 + 150
        }),
      })
    );
    expect(admin._spy.schemaFn).toHaveBeenCalledWith('tenant');
    expect(admin._spy.from).toHaveBeenCalledWith('ai_token_usage');
    expect(capturedRow).toMatchObject({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      route: 'ai.chat',
      tokens_in: 250,
      tokens_out: 150,
      model: 'claude-sonnet-4-6',
    });
  });

  it('skipper insert hvis tenantId er null (public AI-tools)', async () => {
    const admin = makeAdmin();
    mockCreate.mockReturnValue(admin as never);
    await recordAiUsage({
      userId: 'user-1',
      tenantId: null,
      route: 'ai.public',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(admin._spy.updateUserById).toHaveBeenCalled(); // user-metadata stadig opdateret
    expect(admin._spy.schemaFn).not.toHaveBeenCalled(); // men ingen insert
  });

  it('handler manglende app_metadata.subscription (start fra 0)', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ insert });
    const schemaFn = vi.fn().mockReturnValue({ from });
    const getUserById = vi.fn().mockResolvedValue({
      data: { user: { id: 'user-1', app_metadata: {} } }, // no subscription
      error: null,
    });
    const updateUserById = vi.fn().mockResolvedValue({ data: null, error: null });
    mockCreate.mockReturnValue({
      schema: schemaFn,
      auth: { admin: { getUserById, updateUserById } },
    } as never);

    await recordAiUsage({
      userId: 'user-1',
      tenantId: 'tenant-1',
      route: 'ai.test',
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(updateUserById).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        app_metadata: expect.objectContaining({
          subscription: { tokensUsedThisMonth: 150 },
        }),
      })
    );
  });

  it('fail-soft: getUserById fejl → logger warn men kaster IKKE', async () => {
    const admin = makeAdmin({ getUserError: { message: 'user not found' } });
    mockCreate.mockReturnValue(admin as never);
    await expect(
      recordAiUsage({
        userId: 'user-1',
        tenantId: 'tenant-1',
        route: 'ai.test',
        inputTokens: 100,
        outputTokens: 50,
      })
    ).resolves.toBeUndefined();
    // Insert sker stadig (selvom user-metadata opdatering fejlede)
    expect(admin._spy.insert).toHaveBeenCalled();
  });

  it('fail-soft: insert fejl → logger warn men kaster IKKE', async () => {
    const admin = makeAdmin({ insertError: { message: 'permission denied' } });
    mockCreate.mockReturnValue(admin as never);
    await expect(
      recordAiUsage({
        userId: 'user-1',
        tenantId: 'tenant-1',
        route: 'ai.test',
        inputTokens: 100,
        outputTokens: 50,
      })
    ).resolves.toBeUndefined();
  });

  it('bruger model="unknown" hvis ikke angivet', async () => {
    let capturedRow: Record<string, unknown> | null = null;
    const admin = makeAdmin({
      captureInsert: (row) => {
        capturedRow = row as Record<string, unknown>;
      },
    });
    mockCreate.mockReturnValue(admin as never);
    await recordAiUsage({
      userId: 'user-1',
      tenantId: 'tenant-1',
      route: 'ai.test',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(capturedRow).toMatchObject({ model: 'unknown' });
  });
});

describe('extractTokenUsage', () => {
  it('returnerer input + output tokens', () => {
    expect(extractTokenUsage({ usage: { input_tokens: 100, output_tokens: 50 } })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('returnerer 0 ved manglende usage-objekt', () => {
    expect(extractTokenUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('returnerer 0 ved manglende input_tokens', () => {
    expect(extractTokenUsage({ usage: { output_tokens: 50 } })).toEqual({
      inputTokens: 0,
      outputTokens: 50,
    });
  });
});
