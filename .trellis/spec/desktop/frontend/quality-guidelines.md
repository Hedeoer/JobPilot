# Desktop Frontend Quality Guidelines

> Code quality standards for the desktop frontend.

---

## Overview

The desktop frontend uses ESLint (shared config from root) and Vite's TypeScript checking for code quality. There is no automated test suite for the desktop frontend. Quality is enforced through linting, type checking, and manual verification.

---

## Quality Commands

```bash
# Lint the entire project (includes desktop via shared config)
pnpm lint

# Build desktop frontend only (Vite, no Rust)
pnpm build:desktop-shell

# Full desktop build (Rust + frontend)
pnpm build:tauri

# Development mode
pnpm dev:tauri
```

---

## Forbidden Patterns

1. **Direct `invoke()` calls in components** — Always use typed wrappers in `desktop-api.ts`.

2. **Importing web-only modules** — Do not import from `next/link`, `next/navigation`, `next-intl`, `src/hooks/*`, `src/stores/*`, or `src/app/*`. These are Next.js-specific and will fail at build time.

3. **Using shared `Date`-typed resume fields** — Desktop uses `string` dates. Import from `desktop/src/types/resume`, not `@/types/resume` for the `Resume` type.

4. **Creating CSS modules or styled-components** — Use Tailwind utility classes only.

5. **Adding dependencies without checking the monorepo** — Desktop dependencies go in `desktop/package.json`, not the root. Shared dependencies go in root `package.json`.

6. **Modifying shared `src/` code to fix desktop-only issues** — If a bug exists only in desktop, fix it in `desktop/src/`. If it affects both, fix in `src/` and verify both apps.

---

## Required Patterns

1. **All backend calls through `desktop-api.ts`** — New Tauri commands must be wrapped with typed interfaces here.

1b. **Every new Tauri command must be ACL-allowed** — This project uses an explicit allowlist in
   `desktop/src-tauri/permissions/desktop-core.toml` (`commands.allow`). Registering a command in
   `lib.rs`'s `generate_handler![...]` is NOT enough: the renderer fails at runtime with
   `Command <name> not allowed by ACL` and the feature appears broken with no compile-time signal.
   `pnpm run verify:desktop:migration` now cross-checks the handler list against that allowlist, so
   add the command name there in the same change.

2. **Route loaders for initial data** — Use `desktop-loaders.ts` to fetch route data. Do not fetch in component body without a loader pattern.

3. **Zustand for state** — Use Zustand stores (`resume-store.ts`, `editor-store.ts`, `ui-store.ts`). Do not add Redux, React Query, or other state libraries.

4. **Autosave debounce** — The resume store has a 500ms autosave debounce. Mutations call `_scheduleSave()` automatically. Do not add manual save buttons except for explicit export operations.

5. **Dark mode support** — Include `dark:` variants for all color-related Tailwind classes.

6. **i18n for user-facing strings** — Use `useTranslation()` from `react-i18next`. Do not hardcode UI strings.

---

## Testing Requirements

There is no automated test suite for the desktop frontend. Quality is verified through:

1. **Build verification** — `pnpm build:desktop-shell` must pass (catches TypeScript errors and missing imports).
2. **Lint verification** — `pnpm lint` must pass.
3. **Manual smoke testing** — Key flows verified manually:
   - Create new resume → edit sections → save → reopen
   - Switch templates → preview updates
   - AI chat → streaming response → apply to section
   - Import legacy data → verify migration
   - Export PDF → verify output
   - Theme changes persist across restart

---

## Code Review Checklist

- [ ] No direct `invoke()` calls outside `desktop-api.ts`
- [ ] No imports from `next/*` or web-only `src/` paths
- [ ] Desktop `Resume` type used (with `string` dates), not shared type
- [ ] Tailwind classes include `dark:` variants
- [ ] User-facing strings go through `t()` (react-i18next)
- [ ] New Tauri commands have typed wrappers in `desktop-api.ts` **and are listed in `permissions/desktop-core.toml`** (otherwise: `Command <name> not allowed by ACL`)
- [ ] Event listeners (`listen()`) are cleaned up in `useEffect` return
- [ ] No new dependencies added to wrong `package.json`
- [ ] `pnpm build:desktop-shell` passes
- [ ] `pnpm lint` passes
