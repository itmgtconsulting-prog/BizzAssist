'use client';

/**
 * Release Manager — admin page for triggering releases and viewing pipeline status.
 *
 * Shows:
 * - Current app version
 * - GitHub Actions workflow status links
 * - Instructions for using the Release Agent workflow
 *
 * BIZZ-86: Service Manager + Release Agent
 */

import { useState } from 'react';
import {
  GitBranch,
  PlayCircle,
  Shield,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react';

// Use the version from env or fallback
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0';
const GITHUB_REPO = 'itmgtconsulting-prog/BizzAssist';

/** Quality gate definition displayed on the release manager page */
interface QualityGate {
  name: string;
  icon: React.ElementType;
  description: string;
}

/** GitHub Actions workflow definition */
interface Workflow {
  name: string;
  file: string;
  description: string;
  trigger: string;
}

const qualityGates: QualityGate[] = [
  {
    name: 'Code Review (JSDoc + Security)',
    icon: Shield,
    description: 'ISO 27001 compliance, JSDoc on all exports, no hardcoded secrets',
  },
  {
    name: 'Architecture Review',
    icon: GitBranch,
    description: 'Structural changes approved by ARCHITECT agent',
  },
  {
    name: 'Test Suite (919+ tests)',
    icon: CheckCircle,
    description: '≥60% lines, ≥50% functions, ≥35% branches',
  },
  {
    name: 'Pre-commit Hook',
    icon: Shield,
    description: 'Secret scan + test run — runs automatically on git commit',
  },
];

const workflows: Workflow[] = [
  {
    name: 'Release Agent',
    file: 'release-agent.yml',
    description: 'Bump version, tag, create GitHub Release',
    trigger: 'Manual (workflow_dispatch)',
  },
  {
    name: 'Service Manager',
    file: 'service-manager.yml',
    description: 'Daily health check — TypeScript, lint, tests, audit',
    trigger: 'Daily 06:00 UTC',
  },
  {
    name: 'Auto-Fix Agent',
    file: 'auto-fix.yml',
    description:
      'Triggered by Service Manager on failure — proposes and applies safe fixes automatically',
    trigger: 'On Service Manager failure',
  },
  {
    name: 'CI Pipeline',
    file: 'ci.yml',
    description: 'PR checks — build, test, lint',
    trigger: 'Every push/PR',
  },
  {
    name: 'Security Scan',
    file: 'security.yml',
    description: 'Weekly npm audit for CVEs',
    trigger: 'Weekly Monday 08:00',
  },
  {
    name: 'DAST Scan',
    file: 'dast.yml',
    description: 'OWASP ZAP dynamic security testing',
    trigger: 'Weekly Sunday 03:00',
  },
  {
    name: 'Lighthouse CI',
    file: 'lighthouse.yml',
    description: 'Accessibility (≥0.85) + performance audit',
    trigger: 'Every push',
  },
  {
    name: 'Bundle Size',
    file: 'bundle-size.yml',
    description: 'Warns if JS chunks exceed 500KB',
    trigger: 'Every push',
  },
];

/**
 * ReleaseManagerPage — admin page for triggering GitHub releases and
 * monitoring CI/CD pipeline status.
 *
 * @returns React element with version info, release trigger UI, quality gates, and workflow links
 */
export default function ReleaseManagerClient() {
  const [selectedBump, setSelectedBump] = useState<'patch' | 'minor' | 'major'>('patch');
  const ghBase = `https://github.com/${GITHUB_REPO}`;
  const actionsBase = `${ghBase}/actions/workflows`;

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Release Manager</h1>
        <p className="text-slate-400 text-sm">BIZZ-86 · Service Manager + Release Agent</p>
      </div>

      {/* Current Version */}
      <section className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <div className="flex items-center gap-3 mb-4">
          <GitBranch className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">Current Version</h2>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-3xl font-mono font-bold text-blue-400">v{APP_VERSION}</span>
          <a
            href={`${ghBase}/releases`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
          >
            View all releases <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </section>

      {/* Trigger Release */}
      <section className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <div className="flex items-center gap-3 mb-4">
          <PlayCircle className="w-5 h-5 text-green-400" />
          <h2 className="text-lg font-semibold text-white">Trigger Release</h2>
        </div>
        <p className="text-slate-400 text-sm mb-4">
          Triggers the Release Agent workflow on GitHub Actions. Quality gate must pass first.
        </p>
        <div className="flex items-center gap-3 mb-4">
          <label className="text-sm text-slate-300 font-medium">Version bump:</label>
          {(['patch', 'minor', 'major'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setSelectedBump(b)}
              aria-label={`Select ${b} version bump`}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                selectedBump === b
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {b}
            </button>
          ))}
        </div>
        <div className="bg-slate-900 rounded-lg p-4 font-mono text-sm text-slate-300 mb-4">
          <p className="text-slate-500 mb-1"># Trigger via GitHub CLI:</p>
          <p>gh workflow run release-agent.yml --field version_bump={selectedBump}</p>
        </div>
        <a
          href={`${actionsBase}/release-agent.yml`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <ExternalLink className="w-4 h-4" />
          Open Release Agent on GitHub
        </a>
      </section>

      {/* Quality Gates */}
      <section className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <div className="flex items-center gap-3 mb-4">
          <CheckCircle className="w-5 h-5 text-emerald-400" />
          <h2 className="text-lg font-semibold text-white">Quality Gates</h2>
          <span className="text-xs text-slate-400">(all must be green before release)</span>
        </div>
        <div className="space-y-3">
          {qualityGates.map((gate) => (
            <div key={gate.name} className="flex items-start gap-3 p-3 bg-slate-700/50 rounded-lg">
              <gate.icon className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-white">{gate.name}</p>
                <p className="text-xs text-slate-400 mt-0.5">{gate.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Workflows */}
      <section className="bg-slate-800 rounded-xl p-5 border border-slate-700">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="w-5 h-5 text-yellow-400" />
          <h2 className="text-lg font-semibold text-white">Automation Workflows</h2>
        </div>
        <div className="space-y-2">
          {workflows.map((wf) => (
            <a
              key={wf.file}
              href={`${actionsBase}/${wf.file}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-3 bg-slate-700/50 hover:bg-slate-700 rounded-lg transition-colors group"
            >
              <div>
                <p className="text-sm font-medium text-white group-hover:text-blue-300 transition-colors">
                  {wf.name}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">{wf.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <span className="text-xs text-slate-500 hidden sm:block">{wf.trigger}</span>
                <ExternalLink className="w-3.5 h-3.5 text-slate-500 group-hover:text-blue-400 transition-colors" />
              </div>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
