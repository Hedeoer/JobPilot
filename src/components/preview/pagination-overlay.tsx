'use client';

/**
 * Presentational pagination overlay for the resume preview paper.
 *
 * Draws dashed page-boundary lines at design-space positions measured from
 * anchored DOM nodes. Purely presentational: geometry, labels, and click
 * handling come from the host (desktop or web editor panel). Boundaries the
 * anchoring step could not confirm are simply absent — this component never
 * guesses positions.
 */

export interface PaginationBoundaryLine {
  /** 1-based page number that starts at this boundary (2..N). */
  page: number;
  /** Design-space px, relative to the paper container's content box. */
  x: number;
  y: number;
  width: number;
}

export interface PaginationOverlayLabels {
  /** Accessible label for a boundary, e.g. "第 2 页开始". */
  pageStart: (page: number) => string;
}

interface PaginationOverlayProps {
  boundaries: PaginationBoundaryLine[];
  /** Show stale lines translucent while a refreshed measurement is pending. */
  stale: boolean;
  labels: PaginationOverlayLabels;
  /** Scroll the preview so that the given page top becomes visible. */
  onBoundaryActivate?: (page: number, y: number) => void;
}

export function PaginationOverlay({
  boundaries,
  stale,
  labels,
  onBoundaryActivate,
}: PaginationOverlayProps) {
  if (boundaries.length === 0) {
    return null;
  }

  return (
    <div
      aria-hidden={!onBoundaryActivate}
      className={stale ? 'pointer-events-none absolute inset-0 opacity-45' : 'pointer-events-none absolute inset-0'}
    >
      {boundaries.map((boundary) => (
        <div
          key={`${boundary.page}-${boundary.y}`}
          className="absolute border-t border-dashed border-slate-400/70 dark:border-zinc-500/70"
          style={{ top: boundary.y, left: boundary.x, width: boundary.width }}
        >
          {onBoundaryActivate ? (
            <button
              type="button"
              aria-label={labels.pageStart(boundary.page)}
              title={labels.pageStart(boundary.page)}
              onClick={() => onBoundaryActivate(boundary.page, boundary.y)}
              className="pointer-events-auto absolute -top-2.5 left-0 cursor-pointer rounded border border-slate-300 bg-white px-1 text-[10px] leading-4 font-medium text-slate-500 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-blue-500 dark:hover:text-blue-300"
            >
              P{boundary.page}
            </button>
          ) : (
            <span
              aria-hidden="true"
              className="absolute -top-2.5 left-0 rounded border border-slate-300 bg-white px-1 text-[10px] leading-4 font-medium text-slate-500 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
            >
              P{boundary.page}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
