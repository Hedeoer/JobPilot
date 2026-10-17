import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PaginationOverlay } from "@/components/preview/pagination-overlay";
import { ResumePreview } from "@/components/preview/resume-preview";
import type { Resume as SharedResume } from "@/types/resume";
import { Button } from "@/components/ui/button";
import { useResumeStore } from "../../stores/resume-store";
import { currentPageForScroll } from "../../lib/pagination-anchors";
import { usePaginationProbe } from "../../lib/pagination-probe";
import type { Resume } from "../../types/resume";

// A4 width in px (at 96 dpi)
const A4_WIDTH = 794;
const A4_HEIGHT = 1123;
const DEFAULT_ZOOM = 90;
const MIN_ZOOM = 30;
const MAX_ZOOM = 150;

/** Screen-space distance between the paper top and the scroll content top. */
function paperScreenTop(scrollEl: HTMLElement, paper: HTMLElement): number {
  return (
    paper.getBoundingClientRect().top -
    scrollEl.getBoundingClientRect().top +
    scrollEl.scrollTop
  );
}

export function EditorPreviewPanel() {
  const { t } = useTranslation();
  const { currentResume, sections } = useResumeStore();
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [currentPage, setCurrentPage] = useState(1);

  const paperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pagination = usePaginationProbe({ paperRef });

  const liveResume = useMemo<Resume | null>(() => {
    if (!currentResume) return null;
    return { ...currentResume, sections };
  }, [currentResume, sections]);

  const boundaryYs = useMemo(
    () => pagination.boundaries.map((boundary) => boundary.y),
    [pagination.boundaries],
  );

  const scale = zoom / 100;

  // Track which page the preview viewport is looking at (rAF-throttled).
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const paper = paperRef.current;
    if (!scrollEl || !paper) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      const currentPaper = paperRef.current;
      const currentScroll = scrollRef.current;
      if (!currentPaper || !currentScroll) return;
      const centerYScreen =
        currentScroll.scrollTop +
        currentScroll.clientHeight / 2 -
        paperScreenTop(currentScroll, currentPaper);
      const centerY = centerYScreen / scale;
      setCurrentPage(
        currentPageForScroll(
          centerY,
          currentPaper.offsetHeight,
          boundaryYs,
          pagination.pageCount ?? 1,
        ),
      );
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scale, boundaryYs, pagination.pageCount]);

  const handleBoundaryActivate = (page: number, y: number) => {
    const scrollEl = scrollRef.current;
    const paper = paperRef.current;
    if (!scrollEl || !paper) return;
    const targetScreen = y * scale + paperScreenTop(scrollEl, paper) - 24;
    scrollEl.scrollTo({ top: Math.max(0, targetScreen), behavior: "smooth" });
    setCurrentPage(page);
  };

  if (!liveResume) return null;

  const pageCount = pagination.pageCount;
  // Diagnostics in the tooltip: status, native error text, probe duration.
  const paginationTooltip = [
    pagination.status === "stale" ? t("editor.toolbar.paginationStale") : null,
    pagination.status === "unavailable" ? pagination.lastError : null,
    pagination.elapsedMs !== null ? `${pagination.elapsedMs} ms` : null,
  ]
    .filter(Boolean)
    .join(" · ") || undefined;

  return (
    <div
      data-tour="preview"
      className="flex min-w-[420px] flex-[6] flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-[0_4px_12px_rgba(15,23,42,0.05)] dark:border-white/10 dark:bg-card dark:shadow-[0_18px_44px_rgba(0,0,0,0.22)]"
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-100 bg-white px-5 dark:border-white/10 dark:bg-card">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
          {t("editor.toolbar.preview")}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50/60 px-2 py-0.5 dark:border-blue-500/20 dark:bg-blue-950/25">
            {pagination.status === "measuring" && pageCount === null ? (
              <Loader2 className="h-3 w-3 animate-spin text-slate-500 dark:text-zinc-400" />
            ) : null}
            {pagination.status === "unavailable" ? (
              <AlertTriangle className="h-3 w-3 text-amber-500 dark:text-amber-400" />
            ) : null}
            <span
              className="text-xs font-medium tabular-nums text-slate-600 dark:text-zinc-300"
              title={paginationTooltip}
            >
              {pagination.status === "unavailable"
                ? t("editor.toolbar.paginationUnavailable")
                : pageCount === null
                  ? t("editor.toolbar.paginationUpdating")
                  : t("editor.toolbar.paginationPages", { count: pageCount })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 cursor-pointer rounded-full p-0 text-slate-500 hover:text-blue-600 dark:text-zinc-400 dark:hover:text-blue-300"
              aria-label={t("editor.toolbar.paginationRefresh")}
              onClick={pagination.refresh}
            >
              <RotateCw className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50/60 px-1 py-0.5 dark:border-blue-500/20 dark:bg-blue-950/25">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 cursor-pointer rounded-full p-0 text-slate-600 hover:bg-white hover:text-blue-600 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-blue-200"
              aria-label={t("editor.toolbar.zoomOut")}
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 10))}
              disabled={zoom <= MIN_ZOOM}
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="w-12 text-center text-xs font-medium tabular-nums text-slate-600 dark:text-zinc-300">
              {zoom}%
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 cursor-pointer rounded-full p-0 text-slate-600 hover:bg-white hover:text-blue-600 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-blue-200"
              aria-label={t("editor.toolbar.zoomIn")}
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 10))}
              disabled={zoom >= MAX_ZOOM}
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

{/* Probe failure detail: shown inline (not only in a tooltip) so the
          reason is visible in a screenshot / bug report. */}
      {pagination.status === "unavailable" ? (
        <div
          role="status"
          className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] leading-4 text-amber-900 dark:border-amber-500/20 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <span className="font-semibold">
            {t("editor.toolbar.paginationUnavailable")}
          </span>
          {pagination.lastError ? (
            <span className="ml-2 break-all opacity-90">{pagination.lastError}</span>
          ) : null}
        </div>
      ) : null}
      {/* Preview body */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto bg-slate-50 dark:bg-zinc-950"
      >
        <div className="flex min-h-full justify-center px-8 py-8 lg:py-10">
          <div
            ref={paperRef}
            className="relative overflow-hidden rounded-sm border border-slate-200 bg-white shadow-xl shadow-slate-900/16 ring-1 ring-slate-900/5 dark:border-zinc-700 dark:shadow-black/50"
            style={{
              width: A4_WIDTH,
              minHeight: A4_HEIGHT,
              zoom: scale,
            }}
          >
            <ResumePreview resume={liveResume as unknown as SharedResume} />
            <PaginationOverlay
              boundaries={pagination.boundaries}
              stale={pagination.status === "stale"}
              labels={{
                pageStart: (page) => t("editor.toolbar.paginationPageStart", { page }),
              }}
              onBoundaryActivate={handleBoundaryActivate}
            />
          </div>
        </div>
        {pageCount !== null && pagination.status !== "unavailable" && (
          <div className="pointer-events-none absolute bottom-3 right-4 rounded-full border border-slate-200 bg-white/90 px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300">
            {t("editor.toolbar.paginationCurrent", {
              current: currentPage,
              total: pageCount,
            })}
          </div>
        )}
      </div>
    </div>
  );
}
