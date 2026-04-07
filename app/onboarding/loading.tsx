/**
 * Onboarding page loading skeleton — app/onboarding/loading.tsx
 *
 * Shown by Next.js while the onboarding page chunk is loading.
 * Mirrors the card layout of the onboarding page to avoid layout shift.
 *
 * @returns Static skeleton UI
 */
export default function OnboardingLoading() {
  return (
    <div className="min-h-screen bg-[#0a1020] flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Brand placeholder */}
        <div className="text-center mb-6">
          <div className="h-6 w-28 bg-slate-800 rounded-lg mx-auto animate-pulse" />
        </div>

        {/* Card skeleton */}
        <div className="bg-[#0f172a] border border-slate-700/50 rounded-2xl p-8 shadow-2xl">
          {/* Progress dots */}
          <div className="flex items-center justify-center gap-2 mb-8">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`rounded-full bg-slate-800 animate-pulse ${i === 0 ? 'w-6 h-2' : 'w-2 h-2'}`}
              />
            ))}
          </div>

          {/* Icon placeholder */}
          <div className="w-16 h-16 bg-slate-800 rounded-2xl mx-auto mb-6 animate-pulse" />

          {/* Title */}
          <div className="h-7 w-3/4 bg-slate-800 rounded-lg mx-auto mb-3 animate-pulse" />

          {/* Body text lines */}
          <div className="space-y-2 mb-8 max-w-xs mx-auto">
            <div className="h-3.5 w-full bg-slate-800 rounded animate-pulse" />
            <div className="h-3.5 w-5/6 bg-slate-800 rounded animate-pulse" />
            <div className="h-3.5 w-4/6 bg-slate-800 rounded animate-pulse" />
          </div>

          {/* Button placeholder */}
          <div className="h-11 w-full bg-slate-800 rounded-xl animate-pulse" />
        </div>

        {/* Skip link placeholder */}
        <div className="h-3 w-40 bg-slate-800/60 rounded mx-auto mt-4 animate-pulse" />
      </div>
    </div>
  );
}
