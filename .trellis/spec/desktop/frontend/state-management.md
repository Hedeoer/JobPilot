# Desktop Frontend State Management

> How state is managed in the desktop frontend.

---

## Overview

The desktop frontend uses **Zustand 5** for all state management. There are 4 stores, each with a clear responsibility. There is no React Query, SWR, Redux, or server-state cache library. Server data is fetched via route loaders and stored in Zustand stores.

---

## Store Overview

| Store | File | Purpose |
|-------|------|---------|
| `useResumeStore` | `stores/resume-store.ts` | Core resume editing: current resume, sections, autosave |
| `useEditorStore` | `stores/editor-store.ts` | Editor UI: selection, undo/redo, panel visibility |
| `useUIStore` | `stores/ui-store.ts` | Global UI: sidebar, modals, theme |
| `useAppUpdateStore` | `stores/app-update-store.ts` | Tauri updater: check, download, install progress |

---

## State Categories

### 1. Global UI State (`useUIStore`)

Manages sidebar visibility, active modal, theme preference, and settings tab selection. Simple read/write with no async logic.

```ts
const sidebarOpen = useUIStore((s) => s.sidebarOpen);
const openModal = useUIStore((s) => s.openModal);
openModal('create-resume');
```

The `ModalType` is a union of 13 modal identifiers: `'create-resume' | 'delete-resume' | 'export-pdf' | 'settings' | ...` | `null`.

### 2. Editor UI State (`useEditorStore`)

Manages which section is selected, whether the theme editor or AI chat panel is open, drag state, and the undo/redo stacks.

**Undo/Redo**: Uses a snapshot-based approach. `_captureSnapshot()` pushes current sections to the `undoStack` (max 50 entries). `undo()` pops from undo, pushes to redo, and returns the snapshot for the caller to restore via `useResumeStore.restoreSections()`.

```ts
const snapshot = useEditorStore.getState().undo();
if (snapshot) {
  useResumeStore.getState().restoreSections(snapshot.sections);
}
```

### 3. Resume Editing State (`useResumeStore`)

The largest store. Holds `currentResume`, `sections`, `isDirty`, and `isSaving`. Every mutation:

1. Captures an undo snapshot (calls `_captureSnapshot()`)
2. Updates sections immutably
3. Sets `isDirty: true`
4. Schedules autosave (500ms debounce via `_scheduleSave()`)

**Autosave flow**:
```
User edits → updateSection() → _captureSnapshot() → set isDirty → _scheduleSave()
  → 500ms debounce → save() → saveDocument() Tauri command → set isDirty false
```

**Saving to backend**: `save()` calls `saveDocument()` from `desktop-api.ts` with the current resume data. Sections are serialized with their content as-is (already parsed objects), timestamps converted from ISO strings to epoch-ms.

Reference: `desktop/src/stores/resume-store.ts`

### 4. App Update State (`useAppUpdateStore`)

Integrates with the Tauri updater plugin. Tracks `pendingUpdate`, `latestVersion`, download progress (`downloadedBytes`, `contentLength`), and installation state. The `performInitialCheck()` function is called once at app startup from `root.tsx`.

---

## Data Flow Pattern

```
Route Loader (desktop-loaders.ts)
    ↓ fetches via desktop-api.ts
Route Component
    ↓ initializes store via store.setResume()
Zustand Store (resume-store.ts)
    ↓ holds state reactively
Components (via useResumeStore selectors)
    ↓ call store actions on user input
Store Action → _captureSnapshot() → update state → _scheduleSave()
    ↓ 500ms debounce
save() → desktop-api.ts → Tauri invoke → Rust storage.rs → SQLite
```

---

## When to Use Global State

Use Zustand stores when:
- State is shared across multiple components (resume data, editor selection)
- State must survive route transitions (resume editing state persists when switching between editor and templates)
- State needs to be accessed from non-component code (undo/redo needs cross-store access)

Use local `useState` when:
- State is truly local to one component (form input focus, dropdown open state)
- State does not need to survive unmount

---

## Cross-Store Communication

The resume store and editor store communicate via direct store access (not through React):

```ts
// In resume-store.ts
import { useEditorStore } from "./editor-store";

_captureSnapshot: () => {
  const { sections } = get();
  useEditorStore.getState().pushUndo({
    sections: structuredClone(sections),
    timestamp: Date.now(),
  });
},
```

This pattern is intentional — Zustand stores are singletons and can access each other via `getState()`.

---

## Common Mistakes

1. **Calling `_scheduleSave()` without capturing a snapshot first** — Every mutation that changes sections must call `_captureSnapshot()` before modifying state. This is already handled in the existing store actions.

2. **Not cancelling pending autosave on `setResume()`** — When loading a new resume, any pending autosave timeout must be cleared to prevent the old resume from overwriting the new one. This is handled in `setResume()`.

3. **Mutating state directly** — Always use immutable updates (`map`, spread, `filter`). Zustand uses reference equality for selectors.

4. **Adding new state libraries** — Do not introduce React Query, Redux, MobX, or other state management. The 4-store Zustand pattern is the established architecture.

5. **Reading store state outside React without `getState()`** — In non-component code, use `useResumeStore.getState()` not `useResumeStore()` (the latter is a React hook).

6. **Passing store objects into `generateHtml()` directly** — The shared export builder mutates its input in place (`preGenerateQrSvgs` writes `qrSection.content._qrSvgs`). Desktop callers MUST pass an isolated copy produced by `toSharedResume({ ...resume, sections }, sections)` first; otherwise the live Zustand store gets polluted and autosave can persist the render-only `_qrSvgs` field. Precedent: `usePaginationProbe` in `desktop/src/lib/pagination-probe.ts`.
