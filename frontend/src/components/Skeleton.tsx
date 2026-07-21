// Shared loading-skeleton primitives. Generalized from the calculator page's
// placeholder cards (the app's first polished skeleton). Prefer these over a
// bare centered spinner for a page's first paint: matching the real layout's
// shape keeps loading from feeling like a blank stall, and the shimmer is
// disabled under prefers-reduced-motion.
//
// Usage:
//   if (isLoading) return <SkeletonGrid count={8} />;   // grid of card tiles
//   <Skeleton className="h-6 w-40" />                     // one shimmer block

interface SkeletonProps {
  /** Tailwind sizing/shape classes (height, width, rounding). */
  className?: string;
}

/** A single shimmer block. Compose these to mirror real content. */
export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`bg-bambu-dark-secondary border border-bambu-dark-tertiary animate-pulse motion-reduce:animate-none ${className}`}
      aria-hidden="true"
    />
  );
}

/** A card-shaped placeholder: title bar + a few content lines. */
export function SkeletonCard({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary p-4 space-y-3 ${className}`}
      aria-hidden="true"
    >
      <div className="h-5 w-1/2 rounded bg-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
      <div className="h-3 w-full rounded bg-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
      <div className="h-3 w-4/5 rounded bg-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
      <div className="h-3 w-2/3 rounded bg-bambu-dark-tertiary animate-pulse motion-reduce:animate-none" />
    </div>
  );
}

interface SkeletonGridProps {
  /** How many placeholder cards to render. */
  count?: number;
  /** Grid column classes; defaults to a responsive 1→2→3 layout. */
  gridClassName?: string;
  /** Extra classes on the outer wrapper (e.g. padding to match the page). */
  className?: string;
  /** Per-card height class. */
  cardClassName?: string;
}

/**
 * A responsive grid of card skeletons. The items stagger-reveal via the shared
 * `.stagger-children` + `.animate-rise` utilities so the placeholder itself
 * eases in rather than popping — the same cascade real cards use.
 */
export function SkeletonGrid({
  count = 8,
  gridClassName = 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  className = '',
  cardClassName = 'h-40',
}: SkeletonGridProps) {
  return (
    <div className={`grid gap-4 stagger-children ${gridClassName} ${className}`} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} className={`animate-rise ${cardClassName}`} />
      ))}
    </div>
  );
}
