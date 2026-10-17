# Desktop Frontend Component Guidelines

> How components are built in the desktop frontend.

---

## Overview

Desktop components are React function components that compose shared shadcn UI primitives (`@/components/ui/*`) with desktop-specific data and behavior layers. They use `desktop-api.ts` for backend communication instead of Next.js API routes.

---

## Component Structure

Standard desktop component file layout:

```tsx
// 1. Imports: shared UI first, then desktop libs, then local
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { saveDocument } from "../../lib/desktop-api";
import { useResumeStore } from "../../stores/resume-store";

// 2. Type definitions for props
interface SectionEditorProps {
  sectionId: string;
  onRemove: () => void;
}

// 3. Component: function declaration, named export
export function SectionEditor({ sectionId, onRemove }: SectionEditorProps) {
  // hooks first
  const { t } = useTranslation();
  const sections = useResumeStore((s) => s.sections);
  // then local state, effects, handlers
  // then return JSX
}
```

Reference: `desktop/src/routes/root.tsx`, `desktop/src/components/editor/`

---

## Props Conventions

- Props are defined as a named `interface` above the component.
- Use explicit types — no inline `{ prop: type }` in the function signature.
- Callback props use `on*` prefix: `onClose`, `onRemove`, `onSelect`.
- Children use `React.ReactNode` when needed.
- Avoid prop drilling through more than 2 levels — use Zustand stores instead.

```tsx
// Good
interface CreateResumeDialogProps {
  open: boolean;
  onClose: () => void;
}

// Avoid: inline prop types
export function CreateResumeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {}
```

---

## Styling Patterns

- **Tailwind-first**: Use utility classes directly. No CSS modules, no styled-components.
- **`cn()` for conditional classes**: Import from `@/lib/utils`.
- **Shared UI components**: Import shadcn primitives from `@/components/ui/*`. Do not recreate button, dialog, input, etc.
- **Dark mode**: Use `dark:` Tailwind variant. The root element gets the `dark` class toggled by `root.tsx` based on workspace settings.

```tsx
import { cn } from "@/lib/utils";

<div className={cn(
  "rounded-lg border p-4",
  isActive && "border-blue-500 bg-blue-50 dark:bg-blue-950"
)}>
```

---

## Shared vs Desktop Components

**Use shared components directly** (import via `@/`):
- All `@/components/ui/*` primitives (Button, Dialog, Input, etc.)
- `@/lib/template-renderer` for template preview/rendering
- `@/lib/section-content` for content normalization

**Desktop-specific reimplementations**:
- Editor components — use desktop stores and `desktop-api.ts` instead of web hooks and API routes
- AI chat — uses `startAiPromptStream()` Tauri command instead of web SSE endpoints
- Dashboard/library — uses `listDocuments()` Tauri command instead of web fetch
- Interview components — entirely desktop-only feature

The reason for reimplementing: the web and desktop data layers are completely separate (Next.js API routes vs Tauri invoke). Shared UI primitives are reused, but data-flow components must be reimplemented.

---

## i18n

Desktop uses `react-i18next` (NOT `next-intl`). Translations are loaded from the shared `messages/en.json` and `messages/zh.json` files.

```tsx
import { useTranslation } from "react-i18next";

const { t } = useTranslation();
<span>{t("libraryLabel")}</span>
```

Translation keys are shared with the web app. Desktop-specific keys are added to the same JSON files.

---

## Accessibility

- All interactive elements must have accessible labels (`aria-label`, `aria-labelledby`, or visible text).
- Use semantic HTML (`button`, `nav`, `main`, `header`).
- Dialogs use shadcn's `Dialog` component which handles focus trapping and `aria-modal`.
- Icon-only buttons must have `aria-label`.

Reference: `desktop/src/routes/root.tsx` — the `AppUpdateBadge`, `LanguagePicker`, and settings button all have proper aria labels.

---

## AI Stream Rendering

Desktop AI surfaces consume Tauri stream events from `listenToAiStreamEvents()`.
Each `DesktopAiStreamEvent` can include both:

- `deltaText`: the text chunk for the current event
- `accumulatedText`: the full assistant text accumulated by the backend so far

### Convention: Prefer Backend Accumulated Text

When rendering live AI output, always derive the next visible text with
`getNextStreamText()` from `desktop/src/components/editor/ai-dialog-helpers.ts`.
It prefers `event.accumulatedText` and falls back to appending `event.deltaText`
only when accumulated text is unavailable.

```tsx
const streamTextRef = useRef("");

unlisten = await listenToAiStreamEvents((event) => {
  if (event.requestId !== requestIdRef.current) {
    return;
  }

  if (event.kind === "completed") {
    const finalText = event.accumulatedText ?? streamTextRef.current;
    streamTextRef.current = finalText;
    setStreamText(finalText);
    return;
  }

  const nextText = getNextStreamText(event, streamTextRef.current);

  if (nextText !== null) {
    streamTextRef.current = nextText;
    setStreamText(nextText);
  }
});
```

**Why**: provider adapters may emit `deltaText` and `accumulatedText` together.
Appending blindly in component state can make the in-progress UI repeat content
or expose a huge raw stream, while the final rendered result still looks correct
because completion uses `accumulatedText`.

### Wrong vs Correct

Wrong:

```tsx
if (event.kind === "delta" && event.deltaText) {
  setStreamText((previous) => previous + event.deltaText);
}
```

Correct:

```tsx
const nextText = getNextStreamText(event, streamTextRef.current);

if (nextText !== null) {
  streamTextRef.current = nextText;
  setStreamText(nextText);
}
```

### Common Mistake: Re-registering Stream Listeners

Do not include live stream text state in the listener effect dependency array.
Use a ref for the mutable current text instead. Re-registering the listener on
every token can create unstable streaming behavior and makes event ordering
harder to reason about.

Wrong:

```tsx
useEffect(() => {
  // registers listenToAiStreamEvents(...)
}, [streamText, t]);
```

Correct:

```tsx
const streamTextRef = useRef("");

useEffect(() => {
  // registers listenToAiStreamEvents(...)
}, [t]);
```

### Verification

When changing an AI stream consumer, verify:

- in-progress rendering does not repeat earlier chunks
- completion still uses the final accumulated text
- structured payload markers are stripped or hidden from intermediate display
- `pnpm exec eslint <changed files>` passes
- `pnpm build:desktop-shell` passes

---

## Common Mistakes

1. **Calling `invoke()` directly** — Always use `desktop-api.ts` wrappers. They provide typed interfaces and handle the `isTauri()` check.

2. **Importing from wrong path** — Shared UI: `@/components/ui/button`. Desktop stores: `../stores/resume-store` (relative). Do not mix conventions.

3. **Using `Date` objects from shared types** — Desktop `types/resume.ts` uses `string` for timestamps, not `Date`. The mappers in `desktop-document-mappers.ts` handle the conversion.

4. **Using `next/link` or `next/navigation`** — Desktop uses `@tanstack/react-router` (`Link`, `useNavigate`, `useRouterState`).

5. **Missing dark mode variants** — Always include `dark:` variants for color-related Tailwind classes.

6. **Appending AI stream chunks blindly** — Use `getNextStreamText()` and a ref-backed current text value. Do not append `deltaText` directly in state when `accumulatedText` may also be present.

7. **Measuring the zoomed preview paper with raw `getBoundingClientRect()`** — The editor preview paper uses CSS `zoom` (30%–150%). Under `zoom`, `getBoundingClientRect()` returns screen-scaled values while `offsetTop/offsetHeight` stay in design space, so mixing them mis-positions overlays. Convert rect deltas to design space by dividing by `rect.height / el.offsetHeight` (see `measureBoundary()` in `desktop/src/lib/pagination-anchors.ts`), and convert scroll offsets with an explicit `* scale` / `/ scale`.

8. **Gating background work on `document.hasFocus()` in the Tauri webview** — WebView2/WKWebView do not report document focus reliably, and a `window.focus` event that arrives before React attaches listeners is never replayed. Background work gated on focus can therefore never start, with no error and no retry (observed symptom: the pagination page-count badge spun forever). Gate on `document.hidden` plus a `visibilitychange` recovery instead, and treat focus only as an extra *trigger*, never as a precondition. See `desktop/src/lib/pagination-probe.ts`.
