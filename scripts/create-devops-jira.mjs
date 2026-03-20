/**
 * Creates JIRA tickets for remaining professional setup items
 * that were identified in the dev tooling audit.
 * Run: node scripts/create-devops-jira.mjs
 */

const JIRA_HOST = 'bizzassist.atlassian.net';
const JIRA_EMAIL = 'itmgtconsulting@gmail.com';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'BIZZ';
const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE_URL = `https://${JIRA_HOST}/rest/api/3`;

async function jiraRequest(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Basic ${AUTH}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function createIssue({ summary, description, priority, labels }) {
  return jiraRequest('POST', '/issue', {
    fields: {
      project: { key: PROJECT_KEY },
      summary,
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] },
      issuetype: { name: 'Story' },
      priority: { name: priority },
      labels: labels || [],
    },
  });
}

const tickets = [
  // ── CI/CD & Deployment ─────────────────────────────────────────────────────
  {
    summary: '[DEVOPS] Set up GitHub repository and push codebase',
    description: 'Create private GitHub repository under bizzassist organisation. Push current codebase. Configure branch protection rules: require PR + 1 review + CI passing before merge to main. Enable Dependabot for automated dependency updates.',
    priority: 'Highest', labels: ['devops', 'p0', 'git'],
  },
  {
    summary: '[DEVOPS] Set up Vercel deployment — staging and production environments',
    description: 'Connect GitHub repo to Vercel. Create two environments: staging (auto-deploys from develop branch) and production (deploys from main, requires manual approval). Configure all environment variables in Vercel dashboard. Set up custom domain bizzassist.dk for production.',
    priority: 'Highest', labels: ['devops', 'p0', 'deployment'],
  },
  {
    summary: '[DEVOPS] Add GitHub secrets for CI pipeline (Sentry, build vars)',
    description: 'Add repository secrets in GitHub Settings: SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN, NEXT_PUBLIC_SENTRY_DSN. These are referenced in .github/workflows/ci.yml. Also add SKIP_ENV_VALIDATION=1 for build jobs that run without full env vars.',
    priority: 'High', labels: ['devops', 'p1', 'ci', 'security'],
  },
  {
    summary: '[DEVOPS] Configure Dependabot for automated dependency security updates',
    description: 'Create .github/dependabot.yml. Configure weekly npm dependency updates. Auto-approve patch updates. Require review for minor/major updates. Group minor updates to reduce PR noise. Ensures npm audit stays clean (ISO 27001 A.12 vulnerability management).',
    priority: 'High', labels: ['devops', 'p1', 'security', 'dependencies'],
  },

  // ── Monitoring & Observability ─────────────────────────────────────────────
  {
    summary: '[MONITORING] Set up uptime monitoring (UptimeRobot or Checkly)',
    description: 'Register at UptimeRobot (free) or Checkly. Monitor: production homepage (https://bizzassist.dk), health check endpoint (/api/health), login page. Set alert intervals: every 5 minutes. Alert channels: email to jakob + Slack (when Slack is set up). Target 99.9% uptime SLA. Implements ISO 27001 A.17 business continuity monitoring.',
    priority: 'High', labels: ['monitoring', 'p1', 'iso27001'],
  },
  {
    summary: '[MONITORING] Configure Sentry alerts and performance monitoring',
    description: 'In Sentry dashboard: set alert rules for >5 errors/minute (P1 incident trigger). Enable Performance monitoring for Core Web Vitals (LCP, FID, CLS). Set performance thresholds: LCP < 2.5s, CLS < 0.1. Create Sentry → JIRA integration so Sentry issues auto-create BIZZ tickets. Configure alert emails to jakob.',
    priority: 'High', labels: ['monitoring', 'p1', 'sentry', 'performance'],
  },
  {
    summary: '[MONITORING] Lighthouse CI — automated performance + accessibility checks in CI',
    description: 'Install @lhci/cli. Create lighthouserc.yml. Run Lighthouse CI in GitHub Actions on every PR. Fail PR if: Performance < 80, Accessibility < 90, Best Practices < 90, SEO < 90. Upload reports to Lighthouse CI server or use temporary public storage. Prevents performance regressions.',
    priority: 'Medium', labels: ['monitoring', 'p2', 'performance', 'accessibility', 'ci'],
  },
  {
    summary: '[MONITORING] Bundle size monitoring — alert on significant size increases',
    description: 'Install bundlesize or next-bundle-analyzer. Add bundle size check to CI pipeline. Set budget: main JS bundle < 250KB gzipped, total page weight < 500KB. Fail CI if budget exceeded. Prevents accidental large dependency additions. Configure next-bundle-analyzer for visual bundle exploration.',
    priority: 'Medium', labels: ['monitoring', 'p2', 'performance', 'ci'],
  },

  // ── Security ───────────────────────────────────────────────────────────────
  {
    summary: '[SECURITY] Create security.txt at /.well-known/security.txt',
    description: 'Create public/well-known/security.txt following RFC 9116. Include: Contact email (security@bizzassist.dk), Preferred-Languages: da, en, Policy link (link to responsible disclosure policy), Expires date (1 year). Register security@bizzassist.dk email address. Implements ISO 27001 responsible disclosure.',
    priority: 'Medium', labels: ['security', 'p2', 'iso27001'],
  },
  {
    summary: '[SECURITY] Set up Snyk or GitHub Advanced Security for dependency scanning',
    description: 'Enable GitHub Dependabot security alerts. Optionally integrate Snyk (free for open source, paid for private). Configure to scan for: known CVEs in npm dependencies, licence compliance issues. Alert on new critical/high vulnerabilities. Implements ISO 27001 A.12 vulnerability management.',
    priority: 'Medium', labels: ['security', 'p2', 'iso27001', 'dependencies'],
  },
  {
    summary: '[SECURITY] Add OWASP ZAP or similar DAST scan to CI/CD pipeline',
    description: 'Add a scheduled (weekly) Dynamic Application Security Testing scan against the staging environment. Use OWASP ZAP GitHub Action or Checkmarx. Scan for: XSS, SQL injection, CSRF, insecure headers, open redirects. Create JIRA ticket automatically for any findings above Medium severity. Implements ISO 27001 A.14 security testing.',
    priority: 'Low', labels: ['security', 'p3', 'iso27001', 'dast'],
  },

  // ── Developer Experience ───────────────────────────────────────────────────
  {
    summary: '[DX] Create database migration tooling and seed data for local development',
    description: 'Once Supabase is set up (BIZZ-7): create supabase/migrations/ directory. Write SQL migration files. Add npm scripts: db:migrate, db:reset, db:seed. Create seed data with realistic Danish company/property/person data (anonymised — no real PII). Add supabase local development setup to CONTRIBUTING.md.',
    priority: 'High', labels: ['dx', 'p1', 'database'],
  },
  {
    summary: '[DX] Set up Storybook for component documentation and visual testing',
    description: 'Install Storybook for Next.js. Create stories for all existing components: Navbar, Hero, Stats, Features, BugReportModal, etc. Configure dark theme as default. Add Chromatic or Percy for visual regression testing on PRs. Allows design review without running the full app.',
    priority: 'Low', labels: ['dx', 'p3', 'storybook', 'testing'],
  },
  {
    summary: '[DX] Create Docker Compose setup for local development environment',
    description: 'Create docker-compose.yml with services: Next.js app, local Supabase (postgres + auth + storage). Create Dockerfile for Next.js. Add .dockerignore. Document Docker setup in CONTRIBUTING.md. Ensures every developer has an identical environment regardless of machine. Reduces "works on my machine" issues.',
    priority: 'Low', labels: ['dx', 'p3', 'docker'],
  },

  // ── Compliance ─────────────────────────────────────────────────────────────
  {
    summary: '[COMPLIANCE] Create Privacy Policy and Terms of Service (required before public launch)',
    description: 'GDPR Article 13 requires a Privacy Policy before collecting any personal data. Engage Danish legal counsel or use a qualified GDPR template. Must cover: what data is collected, legal basis, data subject rights (access, erasure, portability), retention periods, contact for DPO. Also create Terms of Service. Publish at /privacy and /terms. Required before ANY paying customers.',
    priority: 'Highest', labels: ['compliance', 'p0', 'gdpr', 'legal'],
  },
  {
    summary: '[COMPLIANCE] Implement cookie consent banner (GDPR + Danish Cookie Order)',
    description: 'Implement cookie consent before any analytics or non-essential cookies are set. Use a Danish-law-compliant solution (CookieYes or Cookiebot recommended for Danish compliance). Must allow granular consent: necessary / analytics / marketing. Store consent in database with timestamp. Required before any tracking is added.',
    priority: 'High', labels: ['compliance', 'p1', 'gdpr', 'cookies'],
  },
  {
    summary: '[COMPLIANCE] Sign Data Processing Agreements with all suppliers',
    description: 'GDPR Article 28 requires a DPA with every processor that handles personal data. Required DPAs: Supabase (available at supabase.com/dpa), Vercel (available at vercel.com/legal/dpa), Anthropic Claude (contact enterprise@anthropic.com — required before any customer data is sent to AI), Sentry (available in Sentry dashboard), Resend (when configured). Track signed DPAs in docs/security/ISMS.md Section 10.',
    priority: 'High', labels: ['compliance', 'p1', 'gdpr', 'legal', 'iso27001'],
  },
  {
    summary: '[COMPLIANCE] GDPR data subject rights — implement erasure and export endpoints',
    description: 'GDPR Articles 17 and 20 require the ability to delete and export a user\'s data on request. Build: DELETE /api/account → deletes user + all tenant data within 30 days. GET /api/account/export → returns JSON/CSV of all personal data held. Must be completable within 30 days of request. Add to user settings page. Required before public launch.',
    priority: 'High', labels: ['compliance', 'p1', 'gdpr', 'user-rights'],
  },
];

async function main() {
  console.log('🚀 Creating DevOps & Professional Setup JIRA tickets...\n');
  let count = 0;
  for (const t of tickets) {
    try {
      const issue = await createIssue(t);
      console.log(`✅ ${issue.key}: ${t.summary}`);
      count++;
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`❌ Failed: ${t.summary.slice(0, 60)} → ${err.message}`);
    }
  }
  console.log(`\n🎉 Created ${count} tickets.`);
  console.log(`🔗 https://${JIRA_HOST}/jira/software/projects/${PROJECT_KEY}/boards`);
}

main().catch(console.error);
