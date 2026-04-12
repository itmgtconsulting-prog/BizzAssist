/**
 * Server entry for the AI feedback admin dashboard.
 * BIZZ-231: Admin page to triage unmet AI needs and create JIRA tickets.
 */
import AIFeedbackClient from './AIFeedbackClient';

export const dynamic = 'force-dynamic';

export default function AIFeedbackPage() {
  return <AIFeedbackClient />;
}
