import { NextRequest, NextResponse } from 'next/server';

export interface BugReportPayload {
  type: 'bug' | 'feedback' | 'feature';
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  page?: string;
  userAgent?: string;
  sentryEventId?: string;
  email?: string;
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
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`JIRA API error ${res.status}: ${error}`);
  }

  return res.json();
}

export async function POST(req: NextRequest) {
  try {
    const payload: BugReportPayload = await req.json();

    // Basic validation
    if (!payload.title?.trim() || !payload.description?.trim()) {
      return NextResponse.json({ error: 'Title and description are required' }, { status: 400 });
    }

    // Enrich with request metadata
    payload.userAgent = req.headers.get('user-agent') ?? undefined;

    const issue = await createJiraIssue(payload);

    return NextResponse.json({
      success: true,
      issueKey: issue.key,
      issueUrl: `https://${process.env.JIRA_HOST}/browse/${issue.key}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[report-bug]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
