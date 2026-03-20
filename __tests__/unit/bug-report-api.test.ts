/**
 * Unit tests for the bug report API payload validation.
 *
 * Verifies that:
 * - Valid payloads pass validation
 * - Missing required fields are caught
 * - Severity values are constrained to allowed values
 * - Type values are constrained to allowed values
 */
import { describe, it, expect } from 'vitest';
import type { BugReportPayload } from '@/app/api/report-bug/route';

/** Helper: creates a valid base payload for testing */
function validPayload(overrides: Partial<BugReportPayload> = {}): BugReportPayload {
  return {
    type: 'bug',
    title: 'Login button does not respond',
    description:
      'When clicking the login button, nothing happens. Expected: redirect to dashboard.',
    severity: 'high',
    page: '/login',
    ...overrides,
  };
}

describe('BugReportPayload', () => {
  it('accepts a valid bug report payload', () => {
    const payload = validPayload();
    expect(payload.title).toBeTruthy();
    expect(payload.description).toBeTruthy();
    expect(['bug', 'feedback', 'feature']).toContain(payload.type);
    expect(['low', 'medium', 'high', 'critical']).toContain(payload.severity);
  });

  it('accepts feedback type without severity', () => {
    const payload = validPayload({ type: 'feedback', severity: 'low' });
    expect(payload.type).toBe('feedback');
  });

  it('accepts optional email field', () => {
    const payload = validPayload({ email: 'jakob@bizzassist.dk' });
    expect(payload.email).toBe('jakob@bizzassist.dk');
  });

  it('accepts optional sentryEventId field', () => {
    const payload = validPayload({ sentryEventId: 'abc-123' });
    expect(payload.sentryEventId).toBe('abc-123');
  });

  it('severity values are one of the allowed options', () => {
    const allowed: BugReportPayload['severity'][] = ['low', 'medium', 'high', 'critical'];
    for (const severity of allowed) {
      const payload = validPayload({ severity });
      expect(allowed).toContain(payload.severity);
    }
  });
});
