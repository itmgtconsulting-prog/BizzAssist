'use client';

/**
 * Service Manager admin page — /dashboard/admin/service-manager
 *
 * Monitoring dashboard for the BizzAssist platform (BIZZ-86 v2).
 * Shows:
 *   - Recent Vercel deployments with build status
 *   - History of automated bug scans with categorised issues
 *   - AI-proposed fix proposals with unified diff viewer
 *   - Approve / Reject / Apply Hotfix controls for each fix
 *   - Release Agent activity log
 *
 * Data sources:
 *   GET  /api/admin/service-manager          — deployments + scan history
 *   POST /api/admin/service-manager          — trigger new scan
 *   GET  /api/admin/service-manager/auto-fix?scanId=<id> — fixes for a scan
 *   POST /api/admin/service-manager/auto-fix — propose fix for an issue
 *   PATCH /api/admin/service-manager/auto-fix — approve / reject a fix
 *   POST /api/admin/release-agent            — create hotfix / deploy / promote
 *   GET  /api/admin/release-agent            — activity log
 *
 * Only accessible by admin users (app_metadata.isAdmin === true).
 * Polling every 4 seconds when a scan is in progress.
 *
 * @see app/api/admin/service-manager/route.ts       — main API
 * @see app/api/admin/service-manager/auto-fix/route.ts — AI fix engine
 * @see app/api/admin/release-agent/route.ts          — deployment workflow
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Activity,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Rocket,
  Bug,
  Settings,
  BarChart3,
  Bot,
  ShieldCheck,
  Users,
  CreditCard,
  AlertCircle,
  Wrench,
  Sparkles,
  ThumbsUp,
  ThumbsDown,
  GitBranch,
  Terminal,
  Eye,
  EyeOff,
  Zap,
  ListChecks,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type {
  VercelDeployment,
  ScanRecord,
  ScanIssue,
} from '@/app/api/admin/service-manager/route';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A fix proposal record from service_manager_fixes */
interface FixRecord {
  id: string;
  scan_id: string;
  issue_index: number;
  file_path: string;
  proposed_diff: string;
  classification: 'bug-fix' | 'config-fix' | 'rejected';
  status: 'proposed' | 'approved' | 'applied' | 'rejected';
  claude_reasoning: string | null;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** Timestamp when the Release Agent committed this fix (migration 037) */
  applied_at: string | null;
  /** Git commit SHA produced by the Release Agent (migration 037) */
  commit_sha: string | null;
  created_at: string;
}

/** An activity log entry from service_manager_activity */
interface ActivityRecord {
  id: string;
  action: string;
  details: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

// ─── Badge components ─────────────────────────────────────────────────────────

/**
 * Badge showing a Vercel deployment state with appropriate colour.
 *
 * @param state - The Vercel deployment state string.
 */
function DeploymentStateBadge({ state }: { state: string }) {
  const config: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
    READY: {
      label: 'Ready',
      className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      icon: <CheckCircle2 size={11} />,
    },
    ERROR: {
      label: 'Failed',
      className: 'bg-red-500/15 text-red-400 border-red-500/30',
      icon: <XCircle size={11} />,
    },
    BUILDING: {
      label: 'Building',
      className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      icon: <Loader2 size={11} className="animate-spin" />,
    },
    QUEUED: {
      label: 'Queued',
      className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
      icon: <Clock size={11} />,
    },
    CANCELED: {
      label: 'Canceled',
      className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
      icon: <XCircle size={11} />,
    },
  };
  const c = config[state] ?? {
    label: state,
    className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    icon: <Clock size={11} />,
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.className}`}
    >
      {c.icon} {c.label}
    </span>
  );
}

/**
 * Badge for a scan's overall status.
 *
 * @param status - 'running' | 'completed' | 'failed'
 * @param da - Whether to use Danish labels.
 */
function ScanStatusBadge({ status, da }: { status: ScanRecord['status']; da: boolean }) {
  const config: Record<
    ScanRecord['status'],
    { label: string; className: string; icon: React.ReactNode }
  > = {
    running: {
      label: da ? 'Kører' : 'Running',
      className: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
      icon: <Loader2 size={11} className="animate-spin" />,
    },
    completed: {
      label: da ? 'Færdig' : 'Done',
      className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      icon: <CheckCircle2 size={11} />,
    },
    failed: {
      label: da ? 'Fejlet' : 'Failed',
      className: 'bg-red-500/15 text-red-400 border-red-500/30',
      icon: <XCircle size={11} />,
    },
  };
  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${c.className}`}
    >
      {c.icon} {c.label}
    </span>
  );
}

/**
 * Badge for a single scan issue type.
 *
 * @param issue - The ScanIssue to badge.
 */
function IssueBadge({ issue }: { issue: ScanIssue }) {
  const typeConfig: Record<ScanIssue['type'], { label: string; className: string }> = {
    build_error: { label: 'Build', className: 'bg-red-500/15 text-red-400 border-red-500/30' },
    runtime_error: {
      label: 'Runtime',
      className: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    },
    type_error: {
      label: 'TypeScript',
      className: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    },
    config_error: {
      label: 'Config',
      className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    },
  };
  const c = typeConfig[issue.type];
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${c.className}`}
    >
      {c.label}
    </span>
  );
}

/**
 * Badge for a fix's classification.
 *
 * @param classification - 'bug-fix' | 'config-fix' | 'rejected'
 */
function FixClassificationBadge({
  classification,
}: {
  classification: FixRecord['classification'];
}) {
  const config: Record<FixRecord['classification'], { label: string; className: string }> = {
    'bug-fix': { label: 'Bug Fix', className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
    'config-fix': {
      label: 'Config Fix',
      className: 'bg-teal-500/15 text-teal-400 border-teal-500/30',
    },
    rejected: { label: 'Afvist', className: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  };
  const c = config[classification];
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${c.className}`}
    >
      {c.label}
    </span>
  );
}

/**
 * Badge for a fix's lifecycle status.
 *
 * @param status - 'proposed' | 'approved' | 'applied' | 'rejected'
 */
function FixStatusBadge({ status }: { status: FixRecord['status'] }) {
  const config: Record<
    FixRecord['status'],
    { label: string; className: string; icon: React.ReactNode }
  > = {
    proposed: {
      label: 'Afventer',
      className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      icon: <Clock size={10} />,
    },
    approved: {
      label: 'Godkendt',
      className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      icon: <CheckCircle2 size={10} />,
    },
    applied: {
      label: 'Anvendt',
      className: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
      icon: <GitBranch size={10} />,
    },
    rejected: {
      label: 'Afvist',
      className: 'bg-red-500/15 text-red-400 border-red-500/30',
      icon: <XCircle size={10} />,
    },
  };
  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium border ${c.className}`}
    >
      {c.icon} {c.label}
    </span>
  );
}

// ─── Diff viewer ──────────────────────────────────────────────────────────────

/**
 * Renders a unified diff with syntax highlighting.
 * Added lines (+) are green, removed lines (-) are red, context lines are grey.
 *
 * @param diff - Unified diff string.
 */
function DiffViewer({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="text-slate-500 text-xs italic px-3 py-2">Intet diff tilgængeligt.</p>;
  }

  return (
    <pre className="text-xs font-mono overflow-x-auto leading-5 select-text">
      {diff.split('\n').map((line, i) => {
        let cls = 'text-slate-400';
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-slate-500';
        else if (line.startsWith('@@')) cls = 'text-blue-400';
        else if (line.startsWith('+')) cls = 'text-emerald-400 bg-emerald-500/5';
        else if (line.startsWith('-')) cls = 'text-red-400 bg-red-500/5';
        return (
          <span key={i} className={`block px-3 ${cls}`}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

// ─── Fix card ─────────────────────────────────────────────────────────────────

/**
 * Card showing a single fix proposal with diff viewer and action buttons.
 *
 * @param fix - The fix record to display.
 * @param da - Whether to use Danish labels.
 * @param onReview - Callback when admin approves or rejects the fix.
 * @param onApplyHotfix - Callback when admin clicks "Apply Hotfix".
 */
function FixCard({
  fix,
  da,
  onReview,
  onApplyHotfix,
}: {
  fix: FixRecord;
  da: boolean;
  onReview: (fixId: string, action: 'approve' | 'reject', reason?: string) => Promise<void>;
  onApplyHotfix: (fixId: string) => Promise<void>;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  /** Handle approve button click */
  const handleApprove = async () => {
    setReviewing(true);
    try {
      await onReview(fix.id, 'approve');
    } finally {
      setReviewing(false);
    }
  };

  /** Handle reject confirmation */
  const handleReject = async () => {
    if (!showRejectInput) {
      setShowRejectInput(true);
      return;
    }
    setReviewing(true);
    try {
      await onReview(
        fix.id,
        'reject',
        rejectReason || (da ? 'Afvist af admin' : 'Rejected by admin')
      );
      setShowRejectInput(false);
    } finally {
      setReviewing(false);
    }
  };

  /** Handle apply hotfix button click */
  const handleApplyHotfix = async () => {
    setApplying(true);
    try {
      await onApplyHotfix(fix.id);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="border border-slate-700/50 rounded-xl overflow-hidden">
      {/* Card header */}
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2 mb-1">
            <FixClassificationBadge classification={fix.classification} />
            <FixStatusBadge status={fix.status} />
            <span className="text-slate-400 text-xs font-mono truncate">{fix.file_path}</span>
          </div>
          {fix.claude_reasoning && (
            <p className="text-slate-300 text-xs mt-1 leading-relaxed">{fix.claude_reasoning}</p>
          )}
          {fix.rejection_reason && fix.status === 'rejected' && (
            <p className="text-red-400/80 text-xs mt-1">
              {da ? 'Afvisningsgrund:' : 'Rejection reason:'} {fix.rejection_reason}
            </p>
          )}
          <p className="text-slate-600 text-xs mt-1.5">
            {new Date(fix.created_at).toLocaleString(da ? 'da-DK' : 'en-GB', {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>
      </div>

      {/* Diff toggle */}
      <div className="border-t border-slate-700/30">
        <button
          onClick={() => setShowDiff((v) => !v)}
          className="w-full flex items-center gap-2 px-4 py-2 text-slate-400 hover:text-white text-xs transition-colors hover:bg-slate-800/30"
        >
          {showDiff ? <EyeOff size={12} /> : <Eye size={12} />}
          {showDiff ? (da ? 'Skjul diff' : 'Hide diff') : da ? 'Vis diff' : 'Show diff'}
        </button>
        {showDiff && (
          <div className="border-t border-slate-700/30 bg-slate-900/60 max-h-72 overflow-y-auto">
            <DiffViewer diff={fix.proposed_diff} />
          </div>
        )}
      </div>

      {/* Action buttons — only for proposed fixes */}
      {fix.status === 'proposed' && fix.classification !== 'rejected' && (
        <div className="border-t border-slate-700/30 px-4 py-3 flex flex-wrap items-center gap-2">
          <button
            onClick={handleApprove}
            disabled={reviewing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-400 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {reviewing ? <Loader2 size={12} className="animate-spin" /> : <ThumbsUp size={12} />}
            {da ? 'Godkend' : 'Approve'}
          </button>

          {showRejectInput ? (
            <div className="flex items-center gap-2 flex-1">
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={da ? 'Begrundelse (valgfri)…' : 'Reason (optional)…'}
                className="flex-1 min-w-0 px-2 py-1.5 bg-slate-800 border border-slate-600/50 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-red-500/50"
                autoFocus
                onKeyDown={(e) => e.key === 'Escape' && setShowRejectInput(false)}
              />
              <button
                onClick={handleReject}
                disabled={reviewing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 text-red-400 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {reviewing ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ThumbsDown size={12} />
                )}
                {da ? 'Bekræft' : 'Confirm'}
              </button>
              <button
                onClick={() => setShowRejectInput(false)}
                className="text-slate-500 hover:text-slate-300 text-xs px-2"
              >
                {da ? 'Annuller' : 'Cancel'}
              </button>
            </div>
          ) : (
            <button
              onClick={handleReject}
              disabled={reviewing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 text-red-400 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              <ThumbsDown size={12} />
              {da ? 'Afvis' : 'Reject'}
            </button>
          )}
        </div>
      )}

      {/* Apply Hotfix — only for approved fixes */}
      {fix.status === 'approved' && (
        <div className="border-t border-slate-700/30 px-4 py-3 flex items-center gap-3">
          <button
            onClick={handleApplyHotfix}
            disabled={applying}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {applying ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
            {applying
              ? da
                ? 'Opretter hotfix…'
                : 'Creating hotfix…'
              : da
                ? 'Anvend Hotfix'
                : 'Apply Hotfix'}
          </button>
          <p className="text-slate-500 text-xs">
            {da
              ? 'Opretter branch, committer og pusher til remote'
              : 'Creates branch, commits and pushes to remote'}
          </p>
        </div>
      )}

      {/* Applied state — show commit SHA and applied timestamp */}
      {fix.status === 'applied' && (
        <div className="border-t border-slate-700/30 px-4 py-3 flex flex-col gap-1">
          <div className="flex items-center gap-2 text-blue-400 text-xs">
            <GitBranch size={13} />
            {da ? 'Hotfix er oprettet og pushet til remote.' : 'Hotfix created and pushed to remote.'}
          </div>
          {fix.commit_sha && (
            <span className="text-slate-400 text-xs font-mono pl-5">
              commit: {fix.commit_sha.slice(0, 12)}
            </span>
          )}
          {fix.applied_at && (
            <span className="text-slate-500 text-xs pl-5">
              {new Date(fix.applied_at).toLocaleString(da ? 'da-DK' : 'en-GB', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Scan row (with fixes panel) ──────────────────────────────────────────────

/**
 * Expandable scan row that shows issues and their fix proposals.
 *
 * @param scan - The scan record.
 * @param da - Whether to use Danish labels.
 * @param onHotfixApplied - Callback to refresh data after a hotfix is applied.
 */
function ScanRow({
  scan,
  da,
  onHotfixApplied,
}: {
  scan: ScanRecord;
  da: boolean;
  onHotfixApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fixes, setFixes] = useState<FixRecord[]>([]);
  const [loadingFixes, setLoadingFixes] = useState(false);
  const [proposingFor, setProposingFor] = useState<number | null>(null);
  const [hotfixResult, setHotfixResult] = useState<Record<string, string>>({});

  const errorCount = scan.issues_found.filter((i) => i.severity === 'error').length;
  const warnCount = scan.issues_found.filter((i) => i.severity === 'warning').length;

  /** Load fix proposals for this scan */
  const loadFixes = useCallback(async () => {
    if (!open) return;
    setLoadingFixes(true);
    try {
      const res = await fetch(`/api/admin/service-manager/auto-fix?scanId=${scan.id}`);
      if (res.ok) {
        const data = await res.json();
        setFixes(data.fixes ?? []);
      }
    } finally {
      setLoadingFixes(false);
    }
  }, [open, scan.id]);

  /** Reload fixes whenever the row is expanded */
  useEffect(() => {
    if (open) loadFixes();
  }, [open, loadFixes]);

  /** Propose an AI fix for a specific issue */
  const proposeFix = async (issueIndex: number) => {
    setProposingFor(issueIndex);
    try {
      const res = await fetch('/api/admin/service-manager/auto-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId: scan.id, issueIndex }),
      });
      await loadFixes();
      if (!res.ok) {
        const err = await res.json();
        console.warn('[auto-fix propose]', err);
      }
    } finally {
      setProposingFor(null);
    }
  };

  /** Handle fix review (approve / reject) */
  const handleReview = async (fixId: string, action: 'approve' | 'reject', reason?: string) => {
    await fetch('/api/admin/service-manager/auto-fix', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixId, action, reason }),
    });
    await loadFixes();
  };

  /** Handle apply hotfix via Release Agent */
  const handleApplyHotfix = async (fixId: string) => {
    const res = await fetch('/api/admin/release-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create-hotfix', fixId }),
    });
    const data = await res.json();
    if (res.ok && data.branch) {
      setHotfixResult((prev) => ({ ...prev, [fixId]: data.prUrl ?? data.branch }));
    }
    await loadFixes();
    onHotfixApplied();
  };

  /** Returns the fix for a given issue index, if any */
  const fixForIssue = (idx: number) => fixes.find((f) => f.issue_index === idx);

  return (
    <div className="border border-slate-700/50 rounded-xl overflow-hidden">
      {/* Row header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-800/40 transition-colors text-left"
      >
        <span className="text-slate-500">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <ScanStatusBadge status={scan.status} da={da} />
        <span className="text-white text-sm flex-1 truncate">
          {scan.summary ?? (da ? 'Ingen opsummering' : 'No summary')}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {errorCount > 0 && (
            <span className="text-red-400 text-xs font-medium">
              {errorCount} {da ? 'fejl' : 'error(s)'}
            </span>
          )}
          {warnCount > 0 && (
            <span className="text-amber-400 text-xs font-medium">
              {warnCount} {da ? 'adv.' : 'warn'}
            </span>
          )}
          {scan.issues_found.length === 0 && scan.status === 'completed' && (
            <span className="text-emerald-400 text-xs">{da ? 'Ingen problemer' : 'Clean'}</span>
          )}
          <span className="text-slate-500 text-xs">
            {new Date(scan.created_at).toLocaleString(da ? 'da-DK' : 'en-GB', {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </span>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="border-t border-slate-700/50">
          {/* Issues */}
          {scan.issues_found.length > 0 ? (
            <div className="divide-y divide-slate-700/30">
              {scan.issues_found.map((issue, idx) => {
                const fix = fixForIssue(idx);
                const isProposing = proposingFor === idx;
                const hotfixInfo = fix ? hotfixResult[fix.id] : undefined;

                return (
                  <div key={idx} className="px-4 py-3">
                    {/* Issue header */}
                    <div className="flex gap-3 items-start mb-2">
                      <span className="mt-0.5 shrink-0">
                        {issue.severity === 'error' ? (
                          <AlertCircle size={14} className="text-red-400" />
                        ) : (
                          <AlertTriangle size={14} className="text-amber-400" />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <IssueBadge issue={issue} />
                          <span className="text-white text-xs truncate">{issue.message}</span>
                        </div>
                        {issue.context && (
                          <p className="text-slate-500 text-xs font-mono mt-0.5 truncate">
                            {issue.context}
                          </p>
                        )}
                      </div>

                      {/* Auto-fix button — only when no fix exists yet */}
                      {!fix && scan.status === 'completed' && (
                        <button
                          onClick={() => proposeFix(idx)}
                          disabled={isProposing || proposingFor !== null}
                          className="flex items-center gap-1.5 px-2.5 py-1 bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-purple-300 text-xs rounded-lg transition-colors disabled:opacity-50 shrink-0"
                        >
                          {isProposing ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Sparkles size={11} />
                          )}
                          {isProposing
                            ? da
                              ? 'Analyserer…'
                              : 'Analysing…'
                            : da
                              ? 'Auto-Fix'
                              : 'Auto-Fix'}
                        </button>
                      )}
                    </div>

                    {/* Fix card */}
                    {fix && (
                      <div className="mt-2 ml-5">
                        <FixCard
                          fix={fix}
                          da={da}
                          onReview={handleReview}
                          onApplyHotfix={handleApplyHotfix}
                        />
                        {hotfixInfo && (
                          <p className="text-blue-400 text-xs mt-1.5 ml-1">
                            {da ? 'PR/Branch: ' : 'PR/Branch: '}
                            <span className="font-mono">{hotfixInfo}</span>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              {scan.status === 'completed' && (
                <div className="px-4 py-3 flex items-center gap-2 text-emerald-400 text-xs">
                  <CheckCircle2 size={14} />
                  {da ? 'Ingen problemer fundet i dette scan.' : 'No issues found in this scan.'}
                </div>
              )}
              {scan.status === 'running' && (
                <div className="px-4 py-3 flex items-center gap-2 text-blue-400 text-xs">
                  <Loader2 size={14} className="animate-spin" />
                  {da ? 'Scan er i gang…' : 'Scan in progress…'}
                </div>
              )}
            </>
          )}

          {/* Loading fixes indicator */}
          {loadingFixes && (
            <div className="px-4 py-2 flex items-center gap-2 text-slate-500 text-xs border-t border-slate-700/30">
              <Loader2 size={12} className="animate-spin" />
              {da ? 'Indlæser fix-forslag…' : 'Loading fix proposals…'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Activity log entry ───────────────────────────────────────────────────────

/**
 * Maps an activity action string to a human-readable label and icon.
 *
 * @param action - The action identifier.
 * @param da - Whether to use Danish labels.
 */
function activityLabel(
  action: string,
  da: boolean
): { label: string; icon: React.ReactNode; cls: string } {
  const map: Record<
    string,
    { label: string; labelDa: string; icon: React.ReactNode; cls: string }
  > = {
    auto_fix_proposed: {
      label: 'Fix proposed',
      labelDa: 'Fix foreslået',
      icon: <Sparkles size={12} />,
      cls: 'text-purple-400',
    },
    fix_approved: {
      label: 'Fix approved',
      labelDa: 'Fix godkendt',
      icon: <ThumbsUp size={12} />,
      cls: 'text-emerald-400',
    },
    fix_rejected: {
      label: 'Fix rejected',
      labelDa: 'Fix afvist',
      icon: <ThumbsDown size={12} />,
      cls: 'text-red-400',
    },
    hotfix_created: {
      label: 'Hotfix created',
      labelDa: 'Hotfix oprettet',
      icon: <GitBranch size={12} />,
      cls: 'text-blue-400',
    },
    hotfix_pushed: {
      label: 'Hotfix pushed',
      labelDa: 'Hotfix pushet',
      icon: <GitBranch size={12} />,
      cls: 'text-blue-300',
    },
    pr_created: {
      label: 'PR created',
      labelDa: 'PR oprettet',
      icon: <Rocket size={12} />,
      cls: 'text-cyan-400',
    },
    deploy_test: {
      label: 'Test deployment',
      labelDa: 'Test-deployment',
      icon: <Zap size={12} />,
      cls: 'text-amber-400',
    },
    promote_prod: {
      label: 'Promoted to prod',
      labelDa: 'Fremmet til prod',
      icon: <CheckCircle2 size={12} />,
      cls: 'text-emerald-400',
    },
    hotfix_error: {
      label: 'Hotfix error',
      labelDa: 'Hotfix-fejl',
      icon: <XCircle size={12} />,
      cls: 'text-red-400',
    },
    deploy_test_error: {
      label: 'Deploy error',
      labelDa: 'Deploy-fejl',
      icon: <XCircle size={12} />,
      cls: 'text-red-400',
    },
    promote_prod_error: {
      label: 'Promote error',
      labelDa: 'Promote-fejl',
      icon: <XCircle size={12} />,
      cls: 'text-red-400',
    },
  };
  const m = map[action];
  if (!m) {
    return { label: action, icon: <Terminal size={12} />, cls: 'text-slate-400' };
  }
  return { label: da ? m.labelDa : m.label, icon: m.icon, cls: m.cls };
}

/**
 * Single row in the activity log.
 *
 * @param activity - The activity record to display.
 * @param da - Whether to use Danish labels.
 */
function ActivityRow({ activity, da }: { activity: ActivityRecord; da: boolean }) {
  const [showDetails, setShowDetails] = useState(false);
  const { label, icon, cls } = activityLabel(activity.action, da);
  const hasDetails = Object.keys(activity.details).length > 0;

  return (
    <div className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-800/20 transition-colors">
      <span className={`mt-0.5 shrink-0 ${cls}`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-medium ${cls}`}>{label}</span>
          {!!activity.details.branch && (
            <span className="text-slate-400 text-xs font-mono">
              {String(activity.details.branch)}
            </span>
          )}
          {!!activity.details.error && (
            <span className="text-red-400 text-xs truncate max-w-[240px]">
              {String(activity.details.error)}
            </span>
          )}
          {hasDetails && (
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="text-slate-600 hover:text-slate-400 text-xs"
            >
              {showDetails ? '▲' : '▼'}
            </button>
          )}
        </div>
        {showDetails && (
          <pre className="text-slate-500 text-xs font-mono mt-1 overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(activity.details, null, 2)}
          </pre>
        )}
      </div>
      <span className="text-slate-600 text-xs shrink-0 whitespace-nowrap">
        {new Date(activity.created_at).toLocaleTimeString(da ? 'da-DK' : 'en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

/**
 * Service Manager v2 admin page.
 * Monitoring, AI auto-fix proposals, and Release Agent controls.
 */
export default function ServiceManagerClient() {
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [deployments, setDeployments] = useState<VercelDeployment[]>([]);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<'scans' | 'activity'>('scans');

  /** Ref used to cancel polling when component unmounts */
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Fetch deployment + scan data and activity log */
  const refresh = useCallback(async () => {
    try {
      const [mainRes, activityRes] = await Promise.all([
        fetch('/api/admin/service-manager'),
        fetch('/api/admin/release-agent?limit=50'),
      ]);

      if (mainRes.status === 403) {
        setIsAdmin(false);
        return;
      }
      if (!mainRes.ok) return;

      setIsAdmin(true);
      const data = await mainRes.json();
      setDeployments(data.deployments ?? []);
      setScans(data.scans ?? []);
      setConfigured(data.configured ?? false);
      setLastRefresh(new Date());

      if (activityRes.ok) {
        const actData = await activityRes.json();
        setActivities(actData.activities ?? []);
      }
    } catch {
      // Network error — keep existing data
    }
  }, []);

  /** Initial load */
  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  /** Poll every 4 seconds while any scan is running */
  useEffect(() => {
    const hasRunning = scans.some((s) => s.status === 'running');
    if (hasRunning) {
      pollRef.current = setInterval(refresh, 4000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [scans, refresh]);

  /** Trigger a new scan */
  const startScan = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/admin/service-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan' }),
      });
      if (res.ok) await refresh();
    } finally {
      setScanning(false);
    }
  };

  // ── Derived stats ──────────────────────────────────────────────────────────
  const totalScans = scans.length;
  const openIssues = scans
    .filter((s) => s.status === 'completed')
    .flatMap((s) => s.issues_found)
    .filter((i) => i.severity === 'error').length;
  const lastScan = scans[0] ?? null;
  const hasRunning = scans.some((s) => s.status === 'running');

  // ── Access denied ──────────────────────────────────────────────────────────
  if (!loading && isAdmin === false) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400">
        <div className="text-center">
          <ShieldCheck size={40} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm">{da ? 'Adgang nægtet.' : 'Access denied.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="sticky top-0 z-20 px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} /> {da ? 'Tilbage' : 'Back'}
          </button>
        </div>
        <div className="flex items-center gap-3 mb-1">
          <Wrench size={22} className="text-blue-400" />
          <div>
            <h1 className="text-white text-xl font-bold">Service Manager</h1>
            <p className="text-slate-400 text-sm">
              {da
                ? 'Overvågning, AI auto-fix og release-agent'
                : 'Monitoring, AI auto-fix and release agent'}
            </p>
          </div>
        </div>

        {/* Admin tab navigation */}
        <div className="flex gap-1 -mb-px overflow-x-auto mt-4">
          <Link
            href="/dashboard/admin/users"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Users size={14} /> {da ? 'Brugere' : 'Users'}
          </Link>
          <Link
            href="/dashboard/admin/billing"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <CreditCard size={14} /> {da ? 'Fakturering' : 'Billing'}
          </Link>
          <Link
            href="/dashboard/admin/plans"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <Settings size={14} /> {da ? 'Planer' : 'Plans'}
          </Link>
          <Link
            href="/dashboard/admin/analytics"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
          >
            <BarChart3 size={14} /> {da ? 'Analyse' : 'Analytics'}
          </Link>
          <Link
            href="/dashboard/admin/ai-media-agents"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Bot size={14} /> {da ? 'AI-agenter' : 'AI Agents'}
          </Link>
          <Link
            href="/dashboard/admin/security"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <ShieldCheck size={14} /> {da ? 'Sikkerhed' : 'Security'}
          </Link>
          <span className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-blue-500 text-blue-300 font-medium cursor-default whitespace-nowrap">
            <Wrench size={14} /> Service Manager
          </span>
          <Link
            href="/dashboard/admin/service-management"
            className="flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors whitespace-nowrap"
          >
            <Activity size={14} /> {da ? 'Infrastruktur' : 'Infrastructure'}
          </Link>
        </div>
      </div>

      {/* ─── Body ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-6 space-y-6">
        {loading ? (
          <div className="flex items-center gap-3 text-slate-400 text-sm">
            <Loader2 size={18} className="animate-spin" /> {da ? 'Indlæser…' : 'Loading…'}
          </div>
        ) : (
          <>
            {/* ─── Vercel credentials warning ─── */}
            {!configured && (
              <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
                <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-amber-300 text-sm font-medium">
                    {da ? 'Vercel ikke konfigureret' : 'Vercel not configured'}
                  </p>
                  <p className="text-amber-400/70 text-xs mt-0.5">
                    {da
                      ? 'Tilføj VERCEL_API_TOKEN og VERCEL_PROJECT_ID i .env.local for live data.'
                      : 'Add VERCEL_API_TOKEN and VERCEL_PROJECT_ID to .env.local for live data.'}
                  </p>
                </div>
              </div>
            )}

            {/* ─── Stats row ─── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
                <p className="text-slate-400 text-xs mb-1">{da ? 'Scans i alt' : 'Total scans'}</p>
                <p className="text-white text-2xl font-bold">{totalScans}</p>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
                <p className="text-slate-400 text-xs mb-1">{da ? 'Åbne fejl' : 'Open errors'}</p>
                <p
                  className={`text-2xl font-bold ${openIssues > 0 ? 'text-red-400' : 'text-emerald-400'}`}
                >
                  {openIssues}
                </p>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
                <p className="text-slate-400 text-xs mb-1">{da ? 'Seneste scan' : 'Last scan'}</p>
                <p className="text-white text-sm font-medium truncate">
                  {lastScan
                    ? new Date(lastScan.created_at).toLocaleTimeString(da ? 'da-DK' : 'en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '—'}
                </p>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3">
                <p className="text-slate-400 text-xs mb-1">{da ? 'Aktiviteter' : 'Activities'}</p>
                <p className="text-white text-2xl font-bold">{activities.length}</p>
              </div>
            </div>

            {/* ─── Action bar ─── */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={startScan}
                disabled={scanning || hasRunning}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
              >
                {scanning || hasRunning ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Play size={15} />
                )}
                {scanning || hasRunning
                  ? da
                    ? 'Scanner…'
                    : 'Scanning…'
                  : da
                    ? 'Kør fejlscan'
                    : 'Run Bug Scan'}
              </button>
              <button
                onClick={refresh}
                className="flex items-center gap-2 px-3 py-2 bg-slate-700/60 hover:bg-slate-700 text-slate-300 text-sm rounded-xl transition-colors border border-slate-600/50"
              >
                <RefreshCw size={14} />
                {da ? 'Opdater' : 'Refresh'}
              </button>
              {lastRefresh && (
                <span className="text-slate-500 text-xs">
                  {da ? 'Opdateret' : 'Updated'}{' '}
                  {lastRefresh.toLocaleTimeString(da ? 'da-DK' : 'en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              )}
            </div>

            {/* ─── Recent deployments ─── */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <Rocket size={16} className="text-slate-400" />
                <h2 className="text-slate-200 text-sm font-semibold">
                  {da ? 'Seneste deployments' : 'Recent Deployments'}
                </h2>
              </div>

              {deployments.length === 0 ? (
                <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl px-4 py-6 text-center text-slate-500 text-sm">
                  {configured
                    ? da
                      ? 'Ingen deployments fundet.'
                      : 'No deployments found.'
                    : da
                      ? 'Konfigurer VERCEL_API_TOKEN og VERCEL_PROJECT_ID for at se deployments.'
                      : 'Configure VERCEL_API_TOKEN and VERCEL_PROJECT_ID to see deployments.'}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 text-xs border-b border-slate-700/50">
                        <th className="pb-2 pr-4 font-medium">{da ? 'Status' : 'Status'}</th>
                        <th className="pb-2 pr-4 font-medium">{da ? 'Besked' : 'Message'}</th>
                        <th className="pb-2 pr-4 font-medium">{da ? 'Branch' : 'Branch'}</th>
                        <th className="pb-2 pr-4 font-medium">{da ? 'Miljø' : 'Env'}</th>
                        <th className="pb-2 font-medium">{da ? 'Tidspunkt' : 'Time'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/30">
                      {deployments.map((d) => (
                        <tr key={d.uid} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2.5 pr-4">
                            <DeploymentStateBadge state={d.state} />
                          </td>
                          <td className="py-2.5 pr-4 text-white max-w-[260px] truncate">
                            {d.meta?.githubCommitMessage ?? d.uid}
                          </td>
                          <td className="py-2.5 pr-4 text-slate-400 font-mono text-xs">
                            {d.meta?.githubCommitRef ?? '—'}
                          </td>
                          <td className="py-2.5 pr-4">
                            {d.target === 'production' ? (
                              <span className="text-emerald-400 text-xs font-medium">
                                {da ? 'Produktion' : 'Production'}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">Preview</span>
                            )}
                          </td>
                          <td className="py-2.5 text-slate-400 text-xs whitespace-nowrap">
                            {new Date(d.createdAt).toLocaleString(da ? 'da-DK' : 'en-GB', {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ─── Scan history / Activity log tabs ─── */}
            <section>
              <div className="flex items-center gap-4 mb-3">
                <button
                  onClick={() => setActiveTab('scans')}
                  className={`flex items-center gap-2 text-sm font-semibold pb-1 border-b-2 transition-colors ${
                    activeTab === 'scans'
                      ? 'text-white border-blue-500'
                      : 'text-slate-400 border-transparent hover:text-slate-200'
                  }`}
                >
                  <Bug size={15} />
                  {da ? 'Scanhistorik' : 'Scan History'}
                  {hasRunning && <Activity size={12} className="text-blue-400 animate-pulse" />}
                </button>
                <button
                  onClick={() => setActiveTab('activity')}
                  className={`flex items-center gap-2 text-sm font-semibold pb-1 border-b-2 transition-colors ${
                    activeTab === 'activity'
                      ? 'text-white border-blue-500'
                      : 'text-slate-400 border-transparent hover:text-slate-200'
                  }`}
                >
                  <ListChecks size={15} />
                  {da ? 'Aktivitetslog' : 'Activity Log'}
                  {activities.length > 0 && (
                    <span className="text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded-full">
                      {activities.length}
                    </span>
                  )}
                </button>
              </div>

              {activeTab === 'scans' && (
                <>
                  {scans.length === 0 ? (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl px-4 py-6 text-center text-slate-500 text-sm">
                      {da
                        ? 'Ingen scans endnu. Tryk "Kør fejlscan" for at starte.'
                        : 'No scans yet. Click "Run Bug Scan" to start.'}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {scans.map((scan) => (
                        <ScanRow key={scan.id} scan={scan} da={da} onHotfixApplied={refresh} />
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeTab === 'activity' && (
                <>
                  {activities.length === 0 ? (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl px-4 py-6 text-center text-slate-500 text-sm">
                      {da ? 'Ingen aktiviteter endnu.' : 'No activity yet.'}
                    </div>
                  ) : (
                    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl divide-y divide-slate-700/30 overflow-hidden">
                      {activities.map((a) => (
                        <ActivityRow key={a.id} activity={a} da={da} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
