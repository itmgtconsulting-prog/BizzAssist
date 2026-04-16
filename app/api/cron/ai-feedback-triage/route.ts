/**
 * POST /api/cron/ai-feedback-triage — weekly auto-create JIRA from recurring AI gaps
 *
 * BIZZ-234: Scans ai_feedback_log for question patterns appearing 3+ times
 * in the past 7 days. Auto-creates a JIRA ticket for each new pattern and
 * links it back to the feedback entries (jira_ticket_id field).
 *
 * Triggered by Vercel cron (weekly, Sunday 08:00 UTC).
 * Protected by CRON_SECRET bearer token.
 *
 * GDPR: no PII in JIRA ticket — only aggregated question patterns.
 * Retention: feedback entries follow 12-month retention.
 *
 * @module api/cron/ai-feedback-triage
 */

import { NextRequest, NextResponse } from 'next/server';
import { tenantDb } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

const MIN_OCCURRENCES = 3;
const LOOKBACK_DAYS = 7;

/**
 * Verify cron authorization via CRON_SECRET bearer token.
 */
function verifyCronAuth(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const auth = request.headers.get('authorization');
  return auth === `Bearer ${cronSecret}`;
}

/**
 * Create a JIRA ticket via REST API.
 * Returns the ticket key (e.g. "BIZZ-239") or null on failure.
 */
async function createJiraTicket(summary: string, description: string): Promise<string | null> {
  const host = process.env.JIRA_HOST;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const projectKey = process.env.JIRA_PROJECT_KEY || 'BIZZ';

  if (!host || !email || !token) {
    logger.error('[ai-feedback-triage] JIRA credentials not configured');
    return null;
  }

  try {
    const res = await fetch(`https://${host}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
      },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary,
          issuetype: { name: 'Task' },
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
          },
          priority: { name: 'Medium' },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      logger.error(`[ai-feedback-triage] JIRA create failed: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { key?: string };
    return data.key ?? null;
  } catch (err) {
    logger.error('[ai-feedback-triage] JIRA create error:', err);
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Fetch recent feedback entries without JIRA tickets
    const { data: entries, error } = await tenantDb('tenant')
      .from('ai_feedback_log')
      .select('id, question_text, feedback_type')
      .is('jira_ticket_id', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      logger.error('[ai-feedback-triage] Query error:', error);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    if (!entries || entries.length === 0) {
      return NextResponse.json({ ok: true, ticketsCreated: 0 });
    }

    // Group by first 50 chars of question (simple pattern matching)
    const patterns: Record<string, { count: number; ids: number[]; sample: string }> = {};
    for (const e of entries as { id: number; question_text: string; feedback_type: string }[]) {
      const key = e.question_text.slice(0, 50).toLowerCase().trim();
      if (!patterns[key]) {
        patterns[key] = { count: 0, ids: [], sample: e.question_text };
      }
      patterns[key].count++;
      patterns[key].ids.push(e.id);
    }

    // Filter patterns with 3+ occurrences
    const recurring = Object.values(patterns).filter((p) => p.count >= MIN_OCCURRENCES);

    let ticketsCreated = 0;
    for (const pattern of recurring) {
      const summary = `[AI Gap] Brugere spoerger om: ${pattern.sample.slice(0, 80)}`;
      const description = `${pattern.count} forekomster i de seneste ${LOOKBACK_DAYS} dage.\n\nEksempel: "${pattern.sample}"\n\nFeedback entry IDs: ${pattern.ids.join(', ')}\n\nAuto-oprettet af ai-feedback-triage cron.`;

      const ticketKey = await createJiraTicket(summary, description);

      if (ticketKey) {
        // Update feedback entries with the JIRA ticket ID
        for (const id of pattern.ids) {
          await tenantDb('tenant')
            .from('ai_feedback_log')
            .update({ jira_ticket_id: ticketKey })
            .eq('id', id);
        }
        ticketsCreated++;
      }
    }

    return NextResponse.json({ ok: true, ticketsCreated, patterns: recurring.length });
  } catch (err) {
    logger.error('[ai-feedback-triage] POST error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
