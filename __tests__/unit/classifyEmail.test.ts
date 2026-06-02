/**
 * Unit-tests for classifyEmail — email-klassificering i monitor-email cron
 * (BIZZ-1955).
 *
 * Fokus: regressionstests der sikrer at den overbrede uptime_alert-matcher
 * ikke længere fyrer falske kritiske runtime-alerts på generiske
 * "alert"/"monitor"/"incident"-emner, og at BizzAssists egne [KRITISK]-alerts
 * ikke re-klassificeres (alert-loop).
 */

import { describe, it, expect } from 'vitest';
import { classifyEmail, type GraphEmail } from '@/lib/monitorEmail';

/**
 * Byg en minimal GraphEmail til test.
 *
 * @param overrides - Felter der overstyrer defaults (subject, from-address, body).
 * @returns En GraphEmail klar til classifyEmail().
 */
function makeEmail(overrides: {
  subject?: string;
  address?: string;
  name?: string;
  body?: string;
}): GraphEmail {
  return {
    id: 'msg-1',
    subject: overrides.subject ?? '',
    receivedDateTime: '2026-06-01T12:00:00Z',
    bodyPreview: '',
    body: { contentType: 'text', content: overrides.body ?? '' },
    from: {
      emailAddress: {
        name: overrides.name ?? 'Test',
        address: overrides.address ?? 'someone@example.com',
      },
    },
  };
}

describe('classifyEmail — uptime_alert false-positives (BIZZ-1955)', () => {
  it('klassificerer IKKE et generisk emne med ordet "alert" som uptime_alert', () => {
    const result = classifyEmail(
      makeEmail({ subject: 'New security alert digest', address: 'digest@example.com' })
    );
    expect(result.category).not.toBe('uptime_alert');
  });

  it('klassificerer IKKE et Sentry-fejlemne (indeholder "monitor") som uptime_alert', () => {
    const result = classifyEmail(
      makeEmail({
        subject: 'BizzAssist BIZZASSIST-8 - TypeError in monitor route',
        address: 'noreply@sentry.io',
      })
    );
    expect(result.category).not.toBe('uptime_alert');
  });

  it('klassificerer IKKE et bart "incident"-emne som uptime_alert', () => {
    const result = classifyEmail(
      makeEmail({ subject: 'Weekly incident review notes', address: 'team@example.com' })
    );
    expect(result.category).not.toBe('uptime_alert');
  });
});

describe('classifyEmail — uptime_alert genuine cases', () => {
  it('klassificerer en kendt uptime-afsender (UptimeRobot) som uptime_alert', () => {
    const result = classifyEmail(
      makeEmail({ subject: 'Monitor is back', address: 'alert@uptimerobot.com' })
    );
    expect(result.category).toBe('uptime_alert');
  });

  it('klassificerer et eksplicit "is down"-emne som uptime_alert', () => {
    const result = classifyEmail(
      makeEmail({ subject: 'bizzassist.dk is down', address: 'ops@example.com' })
    );
    expect(result.category).toBe('uptime_alert');
  });

  it('klassificerer "outage"-emne som uptime_alert', () => {
    const result = classifyEmail(
      makeEmail({ subject: 'Production outage detected', address: 'ops@example.com' })
    );
    expect(result.category).toBe('uptime_alert');
  });
});

describe('classifyEmail — self-referential guard (alert-loop)', () => {
  it('skipper BizzAssists egen [KRITISK]-alert email', () => {
    const result = classifyEmail(
      makeEmail({
        subject: '[KRITISK] BizzAssist — Kritisk runtime-fejl',
        address: 'noreply@bizzassist.dk',
      })
    );
    expect(result.category).toBe('unknown');
  });

  it('skipper enhver email fra bizzassist.dk-domænet', () => {
    const result = classifyEmail(
      makeEmail({ subject: 'Service disruption outage', address: 'admin@bizzassist.dk' })
    );
    expect(result.category).toBe('unknown');
  });
});

describe('classifyEmail — eksisterende kategorier bevares', () => {
  it('klassificerer GitHub CI-fejl korrekt', () => {
    const result = classifyEmail(
      makeEmail({
        subject:
          '[itmgtconsulting-prog/BizzAssist] Run failed: CI — Quality Gate - develop (abc123)',
        address: 'noreply@github.com',
      })
    );
    expect(result.category).toBe('github_ci_failure');
    expect(result.metadata.repo).toBe('itmgtconsulting-prog/BizzAssist');
  });

  it('klassificerer ukendt email som unknown', () => {
    const result = classifyEmail(
      makeEmail({ subject: 'Lunch tomorrow?', address: 'colleague@example.com' })
    );
    expect(result.category).toBe('unknown');
  });
});
