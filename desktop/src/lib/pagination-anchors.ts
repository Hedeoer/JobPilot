/**
 * Pagination boundary anchoring.
 *
 * Locates where PDF pages start inside the live preview DOM by matching the
 * per-page text extracted from the probe PDF against each visual text lane of
 * the rendered template. Pure string logic (`findPageTransitionIndices`) is
 * separated from DOM measurement so the core can run in node tests.
 *
 * Why L-gram monotonic annotation instead of a geometry formula: the export
 * CSS uses `break-inside: avoid` on items, which pushes whole blocks to the
 * next page and leaves page-bottom gaps that accumulate per page. A pure
 * `k * usableHeight` line drifts by hundreds of px (measured up to 449px on a
 * 5-page document), while text anchoring pins each boundary to the exact DOM
 * node where the next page begins.
 */

/** Gram length for page-transition detection. */
const GRAM_LENGTH = 8;
/** Consecutive gram hits required to confirm a page transition. */
const TRANSITION_RUN = 4;
/** Max chars to backtrack over a repeated page-start phrase. */
const BACKTRACK_LIMIT = 200;
/** Ancestor tops within this distance of the anchor line snap the line up. */
const BLOCK_SNAP_LIMIT = 48;

const STRIP_RE = /[\s\u200b-\u200d\ufeff]+/g;
// Non-global twin for single-char tests: a /g/ regex's `.test()` is stateful
// (lastIndex), which would mis-detect alternating characters in buildLane.
const STRIP_CHAR_RE = /[\s\u200b-\u200d\ufeff]/;

/** Remove whitespace and zero-width characters (used on both sides). */
export function normalizeAnchorText(text: string): string {
  return text.replace(STRIP_RE, "");
}

/** Pure result: where page k starts inside a lane's normalized char sequence. */
export interface PageTransition {
  /** 1-based page number that STARTS at this position (2..N). */
  page: number;
  /** Index into the lane's normalized (whitespace-stripped) char sequence. */
  charIndex: number;
}

/**
 * Find the char index where each PDF page starts within one lane of text.
 *
 * Builds a gram set per page and walks the lane monotonically: when RUN
 * consecutive grams fall out of the current page's set and into the next
 * page's set, a transition is confirmed at the leftmost such gram. If a page
 * starts with a repeated phrase (e.g. a job-title row that appears on several
 * pages), the trigger point lands on the first unique word; we backtrack to
 * the leftmost gram still contained in the next page so the boundary sits on
 * the phrase start instead of mid-entry.
 *
 * Returns nothing for pages whose transition cannot be confirmed — callers
 * must omit those boundaries rather than guess.
 */
export function findPageTransitionIndices(
  laneText: string,
  pageTexts: string[],
): PageTransition[] {
  const lane = normalizeAnchorText(laneText);
  const pageCount = pageTexts.length;
  if (pageCount < 2 || lane.length < GRAM_LENGTH) {
    return [];
  }

  const grams = new Array<Set<string>>(pageCount);
  for (let k = 0; k < pageCount; k += 1) {
    const page = normalizeAnchorText(pageTexts[k] ?? "");
    const set = new Set<string>();
    for (let i = 0; i + GRAM_LENGTH <= page.length; i += 1) {
      set.add(page.slice(i, i + GRAM_LENGTH));
    }
    grams[k] = set;
  }

  const transitions: PageTransition[] = [];
  let currentPage = 0;
  let run = 0;
  let lastConfirmed = -1;

  for (let i = 0; i + GRAM_LENGTH <= lane.length && currentPage < pageCount - 1; i += 1) {
    const gram = lane.slice(i, i + GRAM_LENGTH);
    const inCurrent = grams[currentPage].has(gram);
    const inNext = grams[currentPage + 1].has(gram);

    if (!inCurrent && inNext) {
      run += 1;
      if (run >= TRANSITION_RUN) {
        let p = i - TRANSITION_RUN + 1;
        const floor = Math.max(lastConfirmed + 1, p - BACKTRACK_LIMIT);
        while (p - 1 >= floor && grams[currentPage + 1].has(lane.slice(p - 1, p - 1 + GRAM_LENGTH))) {
          p -= 1;
        }
        transitions.push({ page: currentPage + 2, charIndex: p });
        lastConfirmed = p;
        currentPage += 1;
        run = 0;
      }
    } else {
      run = 0;
    }
  }

  return transitions;
}

// ─── DOM side ────────────────────────────────────────────────────────────────

/** A boundary pinned to a DOM text position; geometry re-measured on reflow. */
export interface PageBoundaryAnchor {
  page: number;
  laneEl: HTMLElement;
  node: Text;
  offset: number;
}

/** Measured boundary geometry in design-space px (zoom-invariant). */
export interface BoundaryGeometry {
  page: number;
  x: number;
  y: number;
  width: number;
}

interface Lane {
  el: HTMLElement;
  text: string;
  /** charIndex -> [textNode, offsetInNode] for the normalized sequence. */
  map: Array<[Text, number]>;
}

function isVisibleElement(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE;
}

function isTextLaneRoot(el: HTMLElement): boolean {
  const display = window.getComputedStyle(el).display;
  return display === "flex" || display === "grid";
}

/**
 * Detect visual text lanes (independent vertical columns). A flex/grid root
 * (or its single wrapper child) with 2+ children rendered at distinct
 * horizontal positions is treated as multi-lane; otherwise the whole root is
 * one lane. Lanes are detected from real layout, never from template markers.
 */
function collectLanes(root: HTMLElement): Lane[] {
  let laneHost: HTMLElement | null = null;
  if (isTextLaneRoot(root)) {
    laneHost = root;
  } else {
    const elementChildren = Array.from(root.children).filter(isVisibleElement);
    if (elementChildren.length === 1 && isTextLaneRoot(elementChildren[0])) {
      laneHost = elementChildren[0];
    }
  }

  if (laneHost) {
    const children = Array.from(laneHost.children).filter(isVisibleElement);
    const lefts = children.map((child) => child.getBoundingClientRect().left);
    const distinctLefts = new Set(lefts.map((left) => Math.round(left)));
    if (children.length >= 2 && distinctLefts.size >= 2) {
      return children.map((child) => buildLane(child));
    }
  }
  return [buildLane(root)];
}

function buildLane(el: HTMLElement): Lane {
  const chars: string[] = [];
  const map: Array<[Text, number]> = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      const tag = parent?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null) !== null) {
    const data = textNode.data;
    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i];
      if (STRIP_CHAR_RE.test(ch)) {
        continue;
      }
      chars.push(ch);
      map.push([textNode, i]);
    }
  }

  return { el, text: chars.join(""), map };
}

/**
 * Resolve the template content root inside the preview paper container:
 * the first non-<style> element child of the `[data-theme-scope]` wrapper.
 */
export function resolveTemplateRoot(paperContainer: HTMLElement): HTMLElement | null {
  const scope = paperContainer.querySelector("[data-theme-scope]");
  if (!scope) return null;
  for (const child of Array.from(scope.children)) {
    if (isVisibleElement(child) && child.tagName !== "STYLE") {
      return child;
    }
  }
  return null;
}

/**
 * Anchor every confirmable page transition of every lane to DOM text nodes.
 * Pages whose transition cannot be confirmed produce no anchor — the overlay
 * simply omits those lines instead of drawing a wrong position.
 */
export function computePageBoundaries(
  templateRoot: HTMLElement,
  pageTexts: string[],
): PageBoundaryAnchor[] {
  if (pageTexts.length < 2) {
    return [];
  }

  const anchors: PageBoundaryAnchor[] = [];
  for (const lane of collectLanes(templateRoot)) {
    const transitions = findPageTransitionIndices(lane.text, pageTexts);
    for (const { page, charIndex } of transitions) {
      const entry = lane.map[charIndex];
      if (!entry) continue;
      const [node, offset] = entry;
      if (!node.isConnected) continue;
      anchors.push({ page, laneEl: lane.el, node, offset });
    }
  }

  anchors.sort((a, b) => a.page - b.page);
  return anchors;
}

/**
 * Measure anchor geometry in design-space px relative to the paper container
 * (where the overlay is mounted). CSS `zoom` scales getBoundingClientRect but
 * not offsetHeight, so dividing rect deltas by `rect.height / offsetHeight`
 * recovers zoom-invariant coordinates.
 *
 * Block snapping: if the anchor line sits within BLOCK_SNAP_LIMIT of an
 * ancestor's top (typical for an entry that starts the page — title row plus
 * card padding), the line snaps to that ancestor's top so it sits above the
 * whole block instead of through its first text line. The snap limit stops
 * the walk long before it could reach unrelated outer containers.
 */
export function measureBoundary(
  anchor: PageBoundaryAnchor,
  origin: HTMLElement,
): BoundaryGeometry | null {
  if (!anchor.node.isConnected || !anchor.laneEl.isConnected) {
    return null;
  }

  const originRect = origin.getBoundingClientRect();
  const scale = originRect.height / origin.offsetHeight || 1;

  const range = document.createRange();
  try {
    range.setStart(anchor.node, anchor.offset);
    range.setEnd(anchor.node, anchor.offset + 1);
  } catch {
    return null;
  }
  const charRect = range.getBoundingClientRect();
  if (!charRect || charRect.height === 0) {
    return null;
  }

  let top = charRect.top;
  let element: HTMLElement | null = anchor.node.parentElement;
  while (element && element !== origin) {
    const rect = element.getBoundingClientRect();
    if (top - rect.top > BLOCK_SNAP_LIMIT) {
      break;
    }
    top = rect.top;
    element = element.parentElement;
  }

  const laneRect = anchor.laneEl.getBoundingClientRect();

  return {
    page: anchor.page,
    x: Math.round((laneRect.left - originRect.left) / scale),
    y: Math.round((top - originRect.top) / scale),
    width: Math.round(laneRect.width / scale),
  };
}


/** Re-measure all still-connected anchors against the paper container. */
export function measureBoundaries(
  anchors: PageBoundaryAnchor[],
  origin: HTMLElement,
): BoundaryGeometry[] {
  const measured: BoundaryGeometry[] = [];
  for (const anchor of anchors) {
    const geometry = measureBoundary(anchor, origin);
    if (geometry) {
      measured.push(geometry);
    }
  }
  return measured;
}
/**
 * Map a viewport-center position (design-space px) to the current page.
 * Boundary y positions partition the document; without boundaries, fall back
 * to an even split so the indicator still works on legacy templates.
 */
export function currentPageForScroll(
  centerY: number,
  contentHeight: number,
  boundaryYs: number[],
  pageCount: number,
): number {
  const total = Math.max(1, pageCount);
  if (boundaryYs.length === 0) {
    if (contentHeight <= 0) return 1;
    return Math.min(total, Math.max(1, Math.ceil((centerY / contentHeight) * total)));
  }
  let page = 1;
  for (const y of boundaryYs) {
    if (centerY >= y) {
      page += 1;
    }
  }
  return Math.min(total, page);
}
