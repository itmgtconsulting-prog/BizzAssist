'use client';

/**
 * Reusable Excel export button.
 * Sends data to /api/export and triggers a file download.
 *
 * @param type - 'property' or 'company'
 * @param data - The data object to export
 * @param label - Button text
 */

import React, { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

interface ExportButtonProps {
  /** Export type — determines worksheet structure */
  type: 'property' | 'company';
  /** Data payload to export */
  data: Record<string, unknown>;
  /** Button label text */
  label?: string;
  /** Optional className override */
  className?: string;
}

/** BIZZ-211: memoized to prevent re-renders on detail pages */
const ExportButton = React.memo(function ExportButton({
  type,
  data,
  label = 'Excel',
  className,
}: ExportButtonProps) {
  const [exporting, setExporting] = useState(false);

  /**
   * Trigger export via API and download the resulting file.
   */
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, data }),
      });

      if (!res.ok) throw new Error('Export failed');

      const blob = await res.blob();
      const filename =
        res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ?? `export.xlsx`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // silently fail — could add toast notification
    }
    setExporting(false);
  };

  return (
    <button
      onClick={handleExport}
      disabled={exporting}
      className={
        className ??
        'inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 border border-emerald-500/20 transition-colors disabled:opacity-50'
      }
    >
      {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
      {label}
    </button>
  );
});

export default ExportButton;
