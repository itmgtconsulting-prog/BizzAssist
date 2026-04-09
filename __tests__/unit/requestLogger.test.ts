/**
 * Unit tests for app/lib/requestLogger.
 *
 * logRequest writes structured JSON log entries for every API request.
 * The internal helpers categoriseUserAgent and levelFromStatus are private
 * but their behaviour is observable through the console.log output.
 *
 * Because logRequest calls console.log, we spy on it and inspect the JSON
 * written in production mode, or the formatted string in development mode.
 *
 * Covers:
 * - levelFromStatus: 2xx → info, 4xx → warn, 5xx → error
 * - categoriseUserAgent: chrome, firefox, safari, edge, curl, postman, other, undefined
 * - logRequest: writes a JSON object with timestamp, level, method, path, status, durationMs
 * - logRequest: userAgentCategory omitted when no User-Agent header
 * - logRequest: path contains no query string
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Force production mode so we get structured JSON output ──────────────────
// requestLogger reads process.env.NODE_ENV at module load time via `const isDev`.
// We must set the env var and re-import the module in a fresh module scope.

describe('logRequest — production mode (structured JSON)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    // Force production so isDev = false → JSON output path
    (process.env as Record<string, string>).NODE_ENV = 'production';
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    (process.env as Record<string, string>).NODE_ENV = originalNodeEnv;
    consoleSpy.mockRestore();
    vi.resetModules();
  });

  /**
   * Parse the first JSON string logged by console.log.
   */
  async function callLogRequest(
    path: string,
    method: string,
    status: number,
    duration: number,
    headers: Record<string, string> = {}
  ): Promise<Record<string, unknown>> {
    // Re-import after NODE_ENV change so isDev is evaluated fresh
    const { logRequest } = await import('@/app/lib/requestLogger');
    const req = new NextRequest(`https://bizzassist.dk${path}`, { method, headers });
    logRequest(req, status, duration);
    const callArgs = consoleSpy.mock.calls[0];
    return JSON.parse(callArgs[0] as string) as Record<string, unknown>;
  }

  it('writes a JSON object with a timestamp field', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50);
    expect(typeof entry.timestamp).toBe('string');
    expect(() => new Date(entry.timestamp as string)).not.toThrow();
  });

  it('sets level to "info" for 200 status', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50);
    expect(entry.level).toBe('info');
  });

  it('sets level to "info" for 201 status', async () => {
    const entry = await callLogRequest('/api/test', 'POST', 201, 30);
    expect(entry.level).toBe('info');
  });

  it('sets level to "warn" for 400 status', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 400, 10);
    expect(entry.level).toBe('warn');
  });

  it('sets level to "warn" for 404 status', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 404, 10);
    expect(entry.level).toBe('warn');
  });

  it('sets level to "error" for 500 status', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 500, 20);
    expect(entry.level).toBe('error');
  });

  it('sets level to "error" for 503 status', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 503, 20);
    expect(entry.level).toBe('error');
  });

  it('includes correct method in log entry', async () => {
    const entry = await callLogRequest('/api/test', 'POST', 200, 50);
    expect(entry.method).toBe('POST');
  });

  it('includes path without query string', async () => {
    const entry = await callLogRequest('/api/cvr', 'GET', 200, 100);
    expect(entry.path).toBe('/api/cvr');
    expect((entry.path as string).includes('?')).toBe(false);
  });

  it('includes status code', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 429, 5);
    expect(entry.status).toBe(429);
  });

  it('includes durationMs rounded to integer', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 142.7);
    expect(Number.isInteger(entry.durationMs)).toBe(true);
    expect(entry.durationMs).toBe(143);
  });

  it('sets userAgentCategory to "chrome" for Chrome UA', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50, {
      'user-agent': 'Mozilla/5.0 Chrome/120.0',
    });
    expect(entry.userAgentCategory).toBe('chrome');
  });

  it('sets userAgentCategory to "firefox" for Firefox UA', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50, {
      'user-agent': 'Mozilla/5.0 Firefox/121.0',
    });
    expect(entry.userAgentCategory).toBe('firefox');
  });

  it('sets userAgentCategory to "safari" for Safari UA', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50, {
      'user-agent': 'Mozilla/5.0 Safari/537.36',
    });
    expect(entry.userAgentCategory).toBe('safari');
  });

  it('sets userAgentCategory to "edge" for Edge UA', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50, {
      'user-agent': 'Mozilla/5.0 Edge/120.0',
    });
    expect(entry.userAgentCategory).toBe('edge');
  });

  it('sets userAgentCategory to "cli" for curl UA', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50, {
      'user-agent': 'curl/7.88.1',
    });
    expect(entry.userAgentCategory).toBe('cli');
  });

  it('sets userAgentCategory to "postman" for Postman UA', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50, {
      'user-agent': 'PostmanRuntime/7.36.0',
    });
    expect(entry.userAgentCategory).toBe('postman');
  });

  it('sets userAgentCategory to "other" for unknown UA', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50, {
      'user-agent': 'SomeCustomBot/1.0',
    });
    expect(entry.userAgentCategory).toBe('other');
  });

  it('omits userAgentCategory when no User-Agent header is present', async () => {
    const entry = await callLogRequest('/api/test', 'GET', 200, 50);
    expect(entry.userAgentCategory).toBeUndefined();
  });

  it('sets userAgentCategory to "cli" for httpie UA (lowercase match)', async () => {
    // The source code checks ua.includes('httpie') — lowercase
    const entry = await callLogRequest('/api/test', 'GET', 200, 50, {
      'user-agent': 'httpie/3.2.2',
    });
    expect(entry.userAgentCategory).toBe('cli');
  });
});

describe('logRequest — development mode (human-readable string)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    (process.env as Record<string, string>).NODE_ENV = 'development';
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    (process.env as Record<string, string>).NODE_ENV = originalNodeEnv;
    consoleSpy.mockRestore();
    vi.resetModules();
  });

  it('writes a non-JSON string in dev mode', async () => {
    const { logRequest } = await import('@/app/lib/requestLogger');
    const req = new NextRequest('https://bizzassist.dk/api/test', { method: 'GET' });
    logRequest(req, 200, 42);
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    // Dev output is a formatted string, not JSON
    expect(() => JSON.parse(output)).toThrow();
    // Should contain path and status
    expect(output).toContain('/api/test');
    expect(output).toContain('200');
  });

  it('shows duration in seconds for requests over 1000ms', async () => {
    const { logRequest } = await import('@/app/lib/requestLogger');
    const req = new NextRequest('https://bizzassist.dk/api/slow', { method: 'GET' });
    logRequest(req, 200, 2500);
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('2.5s');
  });

  it('shows duration in ms for requests under 1000ms', async () => {
    const { logRequest } = await import('@/app/lib/requestLogger');
    const req = new NextRequest('https://bizzassist.dk/api/fast', { method: 'GET' });
    logRequest(req, 200, 350);
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('350ms');
  });
});
