# Desktop Frontend Hook Guidelines

> How hooks are used in the desktop frontend.

---

## Overview

The desktop frontend has no custom hooks in `desktop/src/hooks/` — there is no such directory. Desktop components get data from Zustand stores and call backend functions via `desktop-api.ts` directly. Shared hooks from `src/hooks/` (like `useAuth`) are web-only and not used in the desktop app.

---

## Data Fetching Pattern

Desktop does **not** use React Query, SWR, or any server-state caching library. The pattern is:

1. **Route loaders** fetch data in parallel at route entry time (in `desktop-loaders.ts`).
2. **Zustand stores** hold the fetched data and manage mutations.
3. **Components** read from stores and call store actions.

```tsx
// Route loader (desktop-loaders.ts)
export async function loadEditorRouteData(documentId: string) {
  const document = await getDocument(documentId);
  return { document };
}

// Route component
export const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/editor/$documentId",
  loader: ({ params }) => loadEditorRouteData(params.documentId),
  component: EditorPage,
});

// Component reads loader data, then initializes store
function EditorPage() {
  const { document } = editorRoute.useLoaderData();
  const setResume = useResumeStore((s) => s.setResume);

  useEffect(() => {
    setResume(toResumeDocument(document));
  }, [document, setResume]);
}
```

---

## Custom Hook Patterns

Desktop defines custom hooks only for complex multi-concern orchestration, and
they live in `desktop/src/lib/` (NOT a `hooks/` directory). The sanctioned
precedent is `usePaginationProbe` in `desktop/src/lib/pagination-probe.ts`
(debounce + single-flight + LRU cache + failure backoff + DOM anchoring).
Simple cases stay as:

- **Zustand selectors** for reactive state: `useResumeStore((s) => s.sections)`
- **`desktop-api.ts` functions** for one-shot backend calls: `await saveDocument({...})`
- **`listen()` from `@tauri-apps/api/event`** for streaming events (AI chat)

When you add a desktop lib hook, register its file in
`scripts/verify-desktop-lint-boundary.mjs` `DESKTOP_BLOCKING_PATHS`.

For AI streaming, the pattern uses Tauri event listeners directly in the component:

```tsx
import { listen } from "@tauri-apps/api/event";

useEffect(() => {
  const unlisten = listen("desktop://ai-stream", (event) => {
    // handle streaming chunk
  });
  return () => { void unlisten.then((fn) => fn()); };
}, []);
```

---

## Naming Conventions

Since there are no custom hooks in the desktop frontend, naming conventions follow the shared project standard:
- Shared hooks (in `src/hooks/`): `use-` prefix, kebab-case files (`use-editor.ts`, `use-resume.ts`).
- Zustand stores (in `desktop/src/stores/`): `use` + PascalCase store name (`useResumeStore`, `useEditorStore`).

---

## Common Mistakes

1. **Importing shared web hooks** — Hooks like `useAuth()`, `useResume()` in `src/hooks/` are web-only. They use Next.js internals (NextAuth, web API routes). Desktop must use its own stores and `desktop-api.ts`.

2. **Using React Query or SWR** — The desktop frontend has no server-state cache library. All data fetching goes through route loaders + Zustand stores.

3. **Calling `invoke()` in components** — Always use the typed wrappers in `desktop-api.ts`, not raw `invoke()`.

4. **Not cleaning up event listeners** — When using `listen()` for AI streaming, always return the unlisten function from the `useEffect` cleanup.
