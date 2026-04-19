/**
 * Tab-level loading indicator — animated blue progress bar at the top of a tab panel.
 *
 * Used across all detail pages (ejendom, virksomhed, person) to show
 * a consistent loading state while tab-specific data is being fetched.
 * The bar animates continuously until loading is complete.
 *
 * BIZZ-478: Ensure a11y via role=progressbar + aria-label. Exposes
 * `ariaLabel` so callers can pass bilingual tekst (via translations.ts).
 *
 * @param label     - Optional visible loading message shown below the bar
 * @param ariaLabel - Accessible label for screen readers (defaults to the
 *                    visible label or a generic fallback)
 */
export default function TabLoadingSpinner({
  label,
  ariaLabel,
}: {
  label?: string;
  ariaLabel?: string;
}) {
  const a11yLabel = ariaLabel ?? label ?? 'Henter data';
  return (
    <div role="progressbar" aria-label={a11yLabel} aria-busy="true">
      <div className="h-0.5 w-full bg-slate-700/30 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full animate-[progress_1.5s_ease-in-out_infinite]" />
      </div>
      {label && <p className="text-slate-500 text-xs text-center mt-3">{label}</p>}
    </div>
  );
}
