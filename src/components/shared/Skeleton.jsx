// Lightweight loading placeholders. A `Skeleton` is a single pulsing block;
// `PageSkeleton` stacks a few skeleton cards inside the standard page padding
// and doubles as the Suspense fallback for lazily-loaded routes.

export function Skeleton({ className = '' }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-slate-slate700/50 ${className}`}
    />
  );
}

function SkeletonCard() {
  return (
    <div className="glass rounded-2xl p-5">
      <Skeleton className="h-3 w-24 mb-4" />
      <Skeleton className="h-8 w-32 mb-3" />
      <Skeleton className="h-3 w-full mb-2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

// A few stacked skeleton rows for list-style section bodies (feeds, event
// lists, etc.). `rows` controls how many lines render; `label` is the status name announced.
export function ListSkeleton({ rows = 4, label = 'Loading' }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

// Compact skeleton sized for the Home WidgetCard body: a headline number,
// a short subtitle, and a couple of list lines.
export function WidgetSkeleton() {
  return (
    <div aria-hidden="true">
      <Skeleton className="h-8 w-20 mb-2" />
      <Skeleton className="h-3 w-16 mb-3" />
      <Skeleton className="h-3 w-full mb-1.5" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto" role="status" aria-label="Loading">
      <div className="mb-5">
        <Skeleton className="h-6 w-40 mb-2" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export default Skeleton;
