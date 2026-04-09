/**
 * Unit tests for app/lib/loginThrottle.ts — brute-force login protection.
 *
 * Covers:
 *   - checkLoginThrottle: reports locked when lock key has a TTL
 *   - checkLoginThrottle: reports not locked when lock key is absent
 *   - recordFailedLogin: returns locked status after MAX_ATTEMPTS (5) failures
 *   - recordFailedLogin: returns warning (attemptsLeft === 1) on 4th attempt
 *   - recordFailedLogin: each failure increments counter
 *   - clearLoginThrottle: deletes all three Redis keys for the email
 *   - Redis errors fail open (non-blocking)
 *
 * @upstash/redis is mocked so no real Redis connection is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @upstash/redis ──────────────────────────────────────────────────────

const mockGet = vi.fn();
const mockIncr = vi.fn();
const mockExpire = vi.fn();
const mockSet = vi.fn();
const mockExists = vi.fn();
const mockDel = vi.fn();
const mockTtl = vi.fn();

vi.mock('@upstash/redis', () => {
  class Redis {
    constructor(_opts: Record<string, unknown>) {}
    get = mockGet;
    incr = mockIncr;
    expire = mockExpire;
    set = mockSet;
    exists = mockExists;
    del = mockDel;
    ttl = mockTtl;
  }
  return { Redis };
});

// ─── Import after mocks ───────────────────────────────────────────────────────

import { checkLoginThrottle, recordFailedLogin, clearLoginThrottle } from '@/app/lib/loginThrottle';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});

// ─── checkLoginThrottle ───────────────────────────────────────────────────────

describe('checkLoginThrottle', () => {
  it('returns locked=true when lock key has a positive TTL', async () => {
    mockTtl.mockResolvedValue(600); // 10 minutes remaining
    mockGet.mockResolvedValue(5);

    const result = await checkLoginThrottle('user@example.com');

    expect(result.locked).toBe(true);
    expect(result.lockedForSeconds).toBe(600);
    expect(result.attemptsLeft).toBe(0);
  });

  it('returns locked=false when lock key has expired (TTL <= 0)', async () => {
    mockTtl.mockResolvedValue(-2); // key does not exist
    mockGet.mockResolvedValue(2);

    const result = await checkLoginThrottle('user@example.com');

    expect(result.locked).toBe(false);
    expect(result.lockedForSeconds).toBe(0);
    expect(result.attemptsLeft).toBe(3); // MAX_ATTEMPTS(5) - 2
  });

  it('sets warningShown=true when exactly 4 attempts have been made (one left)', async () => {
    mockTtl.mockResolvedValue(-2); // not locked
    mockGet.mockResolvedValue(4); // 4 attempts recorded

    const result = await checkLoginThrottle('user@example.com');

    expect(result.warningShown).toBe(true);
    expect(result.attemptsLeft).toBe(1);
    expect(result.locked).toBe(false);
  });

  it('sets warningShown=false when fewer than 4 attempts', async () => {
    mockTtl.mockResolvedValue(-2);
    mockGet.mockResolvedValue(2);

    const result = await checkLoginThrottle('user@example.com');

    expect(result.warningShown).toBe(false);
  });

  it('treats missing counter (null) as 0 attempts', async () => {
    mockTtl.mockResolvedValue(-2);
    mockGet.mockResolvedValue(null);

    const result = await checkLoginThrottle('user@example.com');

    expect(result.attempts).toBe(0);
    expect(result.attemptsLeft).toBe(5);
    expect(result.locked).toBe(false);
  });

  it('fails open when Redis throws (locked=false)', async () => {
    mockTtl.mockRejectedValue(new Error('Redis connection refused'));

    const result = await checkLoginThrottle('user@example.com');

    expect(result.locked).toBe(false);
    expect(result.attemptsLeft).toBe(5);
  });

  it('normalises email (trims + lowercases) for key lookup', async () => {
    mockTtl.mockResolvedValue(-2);
    mockGet.mockResolvedValue(0);

    await checkLoginThrottle('  USER@EXAMPLE.COM  ');

    // Verifying the Redis key used (ttl is called first with the lock key)
    expect(mockTtl).toHaveBeenCalledWith('login_locked:user@example.com');
  });
});

// ─── recordFailedLogin ────────────────────────────────────────────────────────

describe('recordFailedLogin', () => {
  it('increments counter and returns correct attemptsLeft on first failure', async () => {
    mockIncr.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);

    const result = await recordFailedLogin('user@example.com', 'https://bizzassist.dk');

    expect(mockIncr).toHaveBeenCalledWith('login_attempts:user@example.com');
    expect(result.attempts).toBe(1);
    expect(result.attemptsLeft).toBe(4);
    expect(result.locked).toBe(false);
  });

  it('shows warning (attemptsLeft === 1) on 4th failed attempt', async () => {
    mockIncr.mockResolvedValue(4);
    mockExpire.mockResolvedValue(1);

    const result = await recordFailedLogin('user@example.com', 'https://bizzassist.dk');

    expect(result.warningShown).toBe(true);
    expect(result.attemptsLeft).toBe(1);
    expect(result.locked).toBe(false);
  });

  it('triggers lockout on 5th failed attempt', async () => {
    mockIncr.mockResolvedValue(5);
    mockExpire.mockResolvedValue(1);
    mockSet.mockResolvedValue('OK');
    mockExists.mockResolvedValue(0); // reset email not yet sent

    const result = await recordFailedLogin('user@example.com', 'https://bizzassist.dk');

    expect(result.locked).toBe(true);
    expect(result.lockedForSeconds).toBe(900); // 15 * 60
    expect(result.attemptsLeft).toBe(0);
    // Lock key should be set
    expect(mockSet).toHaveBeenCalledWith(
      'login_locked:user@example.com',
      '1',
      expect.objectContaining({ ex: 900 })
    );
  });

  it('triggers lockout on 6th+ failed attempt (exceeds MAX_ATTEMPTS)', async () => {
    mockIncr.mockResolvedValue(7);
    mockExpire.mockResolvedValue(1);
    mockSet.mockResolvedValue('OK');
    mockExists.mockResolvedValue(1); // reset email already sent

    const result = await recordFailedLogin('user@example.com', 'https://bizzassist.dk');

    expect(result.locked).toBe(true);
  });

  it('does not resend reset email if already sent (exists key is truthy)', async () => {
    mockIncr.mockResolvedValue(5);
    mockExpire.mockResolvedValue(1);
    mockSet.mockResolvedValue('OK');
    mockExists.mockResolvedValue(1); // already sent

    await recordFailedLogin('user@example.com', 'https://bizzassist.dk');

    // The reset_sent key should NOT be set again (set is only called for lockKey, not resetSentKey)
    const setCalls = mockSet.mock.calls;
    const resetSentCalls = setCalls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith('login_reset_sent:')
    );
    expect(resetSentCalls).toHaveLength(0);
  });

  it('fails open when Redis throws', async () => {
    mockIncr.mockRejectedValue(new Error('Redis unavailable'));

    const result = await recordFailedLogin('user@example.com', 'https://bizzassist.dk');

    expect(result.locked).toBe(false);
    expect(result.attemptsLeft).toBe(5);
  });

  it('normalises email for Redis keys', async () => {
    mockIncr.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);

    await recordFailedLogin('  ADMIN@EXAMPLE.COM  ', 'https://bizzassist.dk');

    expect(mockIncr).toHaveBeenCalledWith('login_attempts:admin@example.com');
  });
});

// ─── clearLoginThrottle ───────────────────────────────────────────────────────

describe('clearLoginThrottle', () => {
  it('deletes all three Redis keys for the email', async () => {
    mockDel.mockResolvedValue(1);

    await clearLoginThrottle('user@example.com');

    expect(mockDel).toHaveBeenCalledWith('login_attempts:user@example.com');
    expect(mockDel).toHaveBeenCalledWith('login_locked:user@example.com');
    expect(mockDel).toHaveBeenCalledWith('login_reset_sent:user@example.com');
    expect(mockDel).toHaveBeenCalledTimes(3);
  });

  it('normalises email before building keys', async () => {
    mockDel.mockResolvedValue(1);

    await clearLoginThrottle('  TEST@EXAMPLE.COM  ');

    expect(mockDel).toHaveBeenCalledWith('login_attempts:test@example.com');
    expect(mockDel).toHaveBeenCalledWith('login_locked:test@example.com');
    expect(mockDel).toHaveBeenCalledWith('login_reset_sent:test@example.com');
  });

  it('does not throw when Redis fails (fail-silent)', async () => {
    mockDel.mockRejectedValue(new Error('Redis error'));

    await expect(clearLoginThrottle('user@example.com')).resolves.not.toThrow();
  });
});
