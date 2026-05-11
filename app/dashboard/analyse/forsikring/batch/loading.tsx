/**
 * Loading skeleton for batch forsikrings-gap.
 *
 * @returns Skeleton JSX
 */
export default function Loading() {
  return (
    <div className="flex-1 bg-[#0a1628] p-8">
      <div className="h-8 w-64 bg-slate-800 rounded animate-pulse mb-4" />
      <div className="h-4 w-96 bg-slate-800/50 rounded animate-pulse mb-8" />
      <div className="h-64 bg-slate-800/30 rounded-2xl animate-pulse" />
    </div>
  );
}
