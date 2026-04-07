import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

export interface BugReportPayload {
  type: 'bug' | 'feedback' | 'feature';
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  page?: string;
  userAgent?: string;
  sentryEventId?: string;
  email?: string;
  /** Base64-encoded PNG screenshot (data URL format) */
  screenshotBase64?: string;
}

const PRIORITY_MAP: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Highest',
};

const TYPE_LABEL_MAP: Record<string, string> = {
  bug: 'Bug',
  feedback: 'Feedback',
  feature: 'Feature Request',
};

async function createJiraIssue(payload: BugReportPayload) {
  const host = process.env.JIRA_HOST;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const project = process.env.JIRA_PROJECT_KEY;

  if (!host || !email || !token || !project) {
    throw new Error('JIRA environment variables not configured');
  }

  const credentials = Buffer.from(`${email}:${token}`).toString('base64');

  const issueType = payload.type === 'feature' ? 'Story' : 'Task';

  const body = {
    fields: {
      project: { key: project },
      summary: `[${TYPE_LABEL_MAP[payload.type]}] ${payload.title}`,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: payload.description }],
          },
          ...(payload.page
            ? [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: `Page: `, marks: [{ type: 'strong' }] },
                    { type: 'text', text: payload.page },
                  ],
                },
              ]
            : []),
          ...(payload.email
            ? [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: `Reported by: `, marks: [{ type: 'strong' }] },
                    { type: 'text', text: payload.email },
                  ],
                },
              ]
            : []),
          ...(payload.sentryEventId
            ? [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: `Sentry Event ID: `, marks: [{ type: 'strong' }] },
                    { type: 'text', text: payload.sentryEventId },
                  ],
                },
              ]
            : []),
          ...(payload.userAgent
            ? [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: `User Agent: `, marks: [{ type: 'strong' }] },
                    { type: 'text', text: payload.userAgent },
                  ],
                },
              ]
            : []),
        ],
      },
      issuetype: { name: issueType },
      priority: { name: PRIORITY_MAP[payload.severity] },
      labels: ['bizzassist-app', payload.type],
    },
  };

  const res = await fetch(`https://${host}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`JIRA API error ${res.status}: ${error}`);
  }

  return res.json();
}

/**
 * Attaches a base64-encoded PNG screenshot to an existing JIRA issue.
 *
 * @param issueKey      - JIRA issue key (e.g. BIZZ-42)
 * @param screenshotB64 - data URL string (data:image/png;base64,...)
 */
async function attachScreenshotToJira(issueKey: string, screenshotB64: string): Promise<void> {
  const host = process.env.JIRA_HOST;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!host || !email || !token) return;

  const credentials = Buffer.from(`${email}:${token}`).toString('base64');
  const base64Data = screenshotB64.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: 'image/png' }), 'screenshot.png');

  await fetch(`https://${host}/rest/api/3/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'X-Atlassian-Token': 'no-check',
    },
    body: formData,
    signal: AbortSignal.timeout(15000),
  });
}

export async function POST(req: NextRequest) {
  const limited = await checkRateLimit(req, rateLimit);
  if (limited) return limited;

  try {
    const payload: BugReportPayload = await req.json();

    // Basic validation
    if (!payload.title?.trim() || !payload.description?.trim()) {
      return NextResponse.json({ error: 'Title and description are required' }, { status: 400 });
    }

    // Enrich with request metadata
    payload.userAgent = req.headers.get('user-agent') ?? undefined;

    const issue = await createJiraIssue(payload);

    // Attach screenshot to JIRA issue if provided
    if (payload.screenshotBase64) {
      await attachScreenshotToJira(issue.key, payload.screenshotBase64).catch((err) => {
        // Non-fatal — log but don't fail the request
        console.error('[report-bug] screenshot attach failed:', err);
      });
    }

    return NextResponse.json({
      success: true,
      issueKey: issue.key,
      issueUrl: `https://${process.env.JIRA_HOST}/browse/${issue.key}`,
    });
  } catch (err) {
    console.error('[report-bug]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}
