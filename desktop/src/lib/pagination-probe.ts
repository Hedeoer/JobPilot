/**
 * Pagination probe orchestration for the desktop editor preview.
 *
 * Renders the live resume through the exact export pipeline (isolated copy →
 * `generateHtml(resume, true)` → Rust Chrome probe) and pins page boundaries
 * into the preview DOM via `pagination-anchors`.
 *
 * Guarantees:
 * - Single-flight: at most one probe runs; later triggers coalesce.
 * - Stale-safe: results for a superseded content hash never rebind anchors.
 * - LRU-cached per content hash (template switches replay instantly).
 * - Store isolation: `toSharedResume` deep-clones because `generateHtml`
 *   mutates `content._qrSvgs` in place — the Zustand store must never see it.
 * - Silent failure: probe errors degrade the UI, never block editing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateHtml } from "@/lib/export";
import { previewResumePagination } from "./desktop-api";
import { toSharedResume } from "./resume-export";
import {
  computePageBoundaries,
  measureBoundaries,
  resolveTemplateRoot,
  type BoundaryGeometry,
  type PageBoundaryAnchor,
} from "./pagination-anchors";
import { useResumeStore } from "../stores/resume-store";
import type { Resume as DesktopResume, ResumeSection } from "../types/resume";

/** Idle delay after content edits before probing (ms). */
const CONTENT_PROBE_DELAY_MS = 2_000;
/** Faster probe after template/theme changes (ms). */
const TEMPLATE_PROBE_DELAY_MS = 300;
/** Consecutive failures before auto-probing stops. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** LRU cache capacity keyed by content hash. */
const CACHE_LIMIT = 8;

export type PaginationStatus = "measuring" | "fresh" | "stale" | "unavailable";

export interface PaginationProbeState {
  status: PaginationStatus;
  pageCount: number | null;
  boundaries: BoundaryGeometry[];
  refresh: () => void;
}

interface ProbeCacheEntry {
  pageCount: number;
  pageTexts: string[];
}

function fingerprintResume(
  resume: DesktopResume,
  sections: ResumeSection[],
): string {
  return JSON.stringify([
    resume.template,
    resume.language,
    resume.themeConfig ?? null,
    sections,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Local emptiness check (the shared `isSectionEmpty` takes the shared
 * `ResumeSection` whose `createdAt` is a `Date`; desktop sections carry ISO
 * strings, so the types are deliberately incompatible).
 */
function sectionHasRenderableContent(section: ResumeSection): boolean {
  const content: unknown = section.content;
  if (!isRecord(content)) {
    return typeof content === "string" && content.trim().length > 0;
  }
  if (section.type === "summary") {
    return typeof content.text === "string" && content.text.trim().length > 0;
  }
  if (Array.isArray(content.items)) {
    return content.items.length > 0;
  }
  if (Array.isArray(content.categories)) {
    return content.categories.length > 0;
  }
  return Object.values(content).some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function hasVisibleContent(sections: ResumeSection[]): boolean {
  return sections.some(
    (section) => section.visible !== false && sectionHasRenderableContent(section),
  );
}

/** LRU cache: Map insertion order gives recency; re-set refreshes position. */
class ProbeCache {
  private readonly entries = new Map<string, ProbeCacheEntry>();

  get(hash: string): ProbeCacheEntry | undefined {
    const entry = this.entries.get(hash);
    if (entry) {
      this.entries.delete(hash);
      this.entries.set(hash, entry);
    }
    return entry;
  }

  set(hash: string, entry: ProbeCacheEntry): void {
    if (this.entries.has(hash)) {
      this.entries.delete(hash);
    }
    this.entries.set(hash, entry);
    while (this.entries.size > CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface UsePaginationProbeOptions {
  /** Ref to the A4 paper container that hosts the ResumePreview output. */
  paperRef: React.RefObject<HTMLElement | null>;
}

export function usePaginationProbe(options: UsePaginationProbeOptions): PaginationProbeState {
  const { paperRef } = options;
  const { currentResume, sections } = useResumeStore();

  const [status, setStatus] = useState<PaginationStatus>("measuring");
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [boundaries, setBoundaries] = useState<BoundaryGeometry[]>([]);

  const hashRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const pendingRef = useRef(false);
  const failuresRef = useRef(0);
  const anchorsRef = useRef<PageBoundaryAnchor[]>([]);
  const appliedHashRef = useRef("");
  const hasDataRef = useRef(false);
  /** Template+theme of the content the current measurement belongs to. */
  const appliedTemplateRef = useRef("");
  const cache = useMemo(() => new ProbeCache(), []);

  const refreshBoundaries = useCallback(() => {
    const paper = paperRef.current;
    if (!paper) return;
    setBoundaries(measureBoundaries(anchorsRef.current, paper));
  }, [paperRef]);

  const applyResult = useCallback(
    (hash: string, result: ProbeCacheEntry) => {
      const paper = paperRef.current;
      const templateRoot = paper ? resolveTemplateRoot(paper) : null;
      anchorsRef.current = templateRoot
        ? computePageBoundaries(templateRoot, result.pageTexts)
        : [];
      appliedHashRef.current = hash;
      hasDataRef.current = true;
      setPageCount(result.pageCount);
      setBoundaries(paper ? measureBoundaries(anchorsRef.current, paper) : []);
      setStatus("fresh");
    },
    [paperRef],
  );

  const runProbe = useCallback(
    async (hash: string) => {
      if (runningRef.current) {
        pendingRef.current = true;
        return;
      }
      runningRef.current = true;
      if (!hasDataRef.current) {
        setStatus("measuring");
      }

      try {
        const { currentResume: resume, sections: resumeSections } =
          useResumeStore.getState();
        if (!resume) return;

        // Isolated copy: generateHtml mutates qr section content in place.
        const shared = toSharedResume({ ...resume, sections: resumeSections }, resumeSections);
        const html = await generateHtml(shared, true);
        const result = await previewResumePagination({ html });

        cache.set(hash, { pageCount: result.pageCount, pageTexts: result.pageTexts });
        failuresRef.current = 0;

        // Stale guard: only rebind anchors when the DOM still matches the
        // probed content; otherwise the pending rerun picks it up.
        if (hash === hashRef.current) {
          applyResult(hash, { pageCount: result.pageCount, pageTexts: result.pageTexts });
        }
      } catch {
        failuresRef.current += 1;
        if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
          setStatus("unavailable");
        }
      } finally {
        runningRef.current = false;
        if (pendingRef.current) {
          pendingRef.current = false;
          const latestHash = hashRef.current;
          if (latestHash) {
            void runProbe(latestHash);
          }
        }
      }
    },
    // applyResult is stable; cache is stable; runProbe must stay stable too so
    // content effects do not reset their debounce timers on every page count.
    [applyResult, cache],
  );

  useEffect(() => {
    if (!currentResume) {
      hashRef.current = "";
      anchorsRef.current = [];
      hasDataRef.current = false;
      setPageCount(null);
      setBoundaries([]);
      setStatus("measuring");
      return;
    }

    const nextHash = fingerprintResume(currentResume, sections);
    const previousHash = hashRef.current;
    hashRef.current = nextHash;

    if (nextHash === previousHash && appliedHashRef.current === nextHash) {
      return; // already applied
    }

    const cached = cache.get(nextHash);
    if (cached) {
      applyResult(nextHash, cached);
      return;
    }

    // Mark stale as soon as content drifts from the applied measurement.
    if (appliedHashRef.current && appliedHashRef.current !== nextHash) {
      setStatus((prev) => (prev === "unavailable" ? prev : "stale"));
    }

    if (!hasVisibleContent(sections)) {
      anchorsRef.current = [];
      appliedHashRef.current = nextHash;
      hasDataRef.current = true;
      setPageCount(1);
      setBoundaries([]);
      setStatus("fresh");
      return;
    }

    if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
      return; // backoff: manual refresh only
    }
    if (typeof document !== "undefined" && (document.hidden || !document.hasFocus())) {
      return; // probed on focus via the listener below
    }

    const templateSnapshot = JSON.stringify([
      currentResume.template,
      currentResume.themeConfig ?? null,
    ]);
    const templateChanged =
      previousHash !== "" && templateSnapshot !== appliedTemplateRef.current;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (appliedHashRef.current === nextHash) return; // served by a faster path meanwhile
      void runProbe(hashRef.current || nextHash);
    }, templateChanged ? TEMPLATE_PROBE_DELAY_MS : CONTENT_PROBE_DELAY_MS);
  }, [currentResume, sections, cache, paperRef, applyResult, runProbe]);

  // Track the template+theme snapshot of the currently applied measurement so
  // the next template switch can use the fast probe delay.
  useEffect(() => {
    if (!currentResume) return;
    if (status !== "fresh") return;
    appliedTemplateRef.current = JSON.stringify([
      currentResume.template,
      currentResume.themeConfig ?? null,
    ]);
  }, [currentResume, status]);

  // Re-measure boundary geometry on reflow (anchors survive pure reflow).
  useEffect(() => {
    const paper = paperRef.current;
    const templateRoot = paper ? resolveTemplateRoot(paper) : null;
    if (!templateRoot) return;

    const observer = new ResizeObserver(() => {
      refreshBoundaries();
    });
    observer.observe(templateRoot);
    return () => observer.disconnect();
  }, [paperRef, refreshBoundaries]);

  // Window focus: probe the current content if it is still unapplied.
  useEffect(() => {
    const onWindowFocus = () => {
      const hash = hashRef.current;
      if (!hash || appliedHashRef.current === hash) return;
      if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) return;
      if (!useResumeStore.getState().currentResume) return;
      void runProbe(hash);
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [runProbe]);

  // Clear any pending timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const refresh = useCallback(() => {
    failuresRef.current = 0;
    const { currentResume: resume, sections: resumeSections } = useResumeStore.getState();
    if (!resume) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const hash = hashRef.current || fingerprintResume(resume, resumeSections);
    void runProbe(hash);
  }, [runProbe]);

  return { status, pageCount, boundaries, refresh };
}
