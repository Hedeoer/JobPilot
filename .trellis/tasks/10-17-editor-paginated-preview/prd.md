# Implement Desktop Paginated Resume Preview

## Goal
Show the real PDF page count, current page, and useful page-boundary markers while editing a resume in the desktop editor. The page count must come from the same local Chrome print pipeline used for PDF export.

## Requirements
- Add a typed Tauri command that renders the generated PDF HTML in a local Chrome/Edge probe and returns page count plus per-page text.
- Reuse the existing PDF browser discovery, file URL conversion, output stability, and PDF validation helpers.
- Protect the probe files/profile from concurrent calls and avoid mutating Zustand resume state while generating HTML.
- Add desktop-side debouncing, request de-duplication, stale-result protection, single-flight execution, and graceful fallback when probing fails.
- Add a preview toolbar page-count indicator and manual refresh control.
- Add a shared, presentational pagination overlay that anchors page boundaries to the current preview DOM, supports separate lanes for side-by-side layouts, and tracks the current page while scrolling.
- Keep legacy templates usable even when a boundary cannot be anchored; page count remains authoritative and boundary lines may be omitted.
- Use existing dependencies only. Do not change export rendering behavior or add a web API in this task.
- Add desktop tests for the pure anchor matching algorithm and verify the desktop/shared lint boundaries include new files.

## Acceptance Criteria
- [ ] Desktop probe returns the same page count as the existing desktop PDF export for representative single-column, background, sidebar, full-dark, and legacy templates.
- [ ] Probe failures do not block editing and expose a manual retry path.
- [ ] Probe calls are single-flight, stale responses cannot replace current anchors, and repeated resume hashes use cache.
- [ ] Page count, current-page indicator, and anchored boundary markers render in the desktop preview with light/dark styling and zoom support.
- [ ] Side-by-side preview lanes receive independent boundary segments; finished lanes do not draw later segments.
- [ ] The probe input is isolated from store data and does not persist `_qrSvgs` or other render-only metadata.
- [ ] `pnpm type-check`, desktop build, desktop/shared lint gates, desktop tests, and Rust cargo check pass.

## Technical Notes
- Desktop frontend logic belongs under `desktop/src`; components may use shared UI and preview components through `@/`.
- Shared overlay belongs under `src/components/preview/`, which is already in the desktop shared lint boundary.
- Existing `pdf-extract 0.7.12` exposes `extract_text_from_mem_by_pages`; no new Rust or frontend dependency is needed.
- Existing `generateHtml(resume, true)` must receive an isolated shared resume produced through `toSharedResume`.
- Existing desktop export uses `storage.rs::write_pdf_export`; the probe should keep the same Chrome flags and `file:` URL behavior.
- The implementation plan is `docs/plans/2026-10-17-editor-paginated-preview-implementation.md`; this task implements its revised desktop-only design.

## Out of Scope
- Web editor/API pagination probing.
- PDF canvas replacement of the live preview.
- Paged.js integration.
- JS geometry-only page estimation.
- Migrating legacy templates to the unified renderer.
- Changing the existing PDF export or Smart One-Page behavior.

## Definition of Done
- Implementation and focused tests are complete.
- Required desktop/shared validation commands are run and failures are resolved or explicitly reported.
- Any durable project convention discovered during implementation is recorded in the task/spec notes.
