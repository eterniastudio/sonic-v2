# Library workspace continuity

The renderer keeps search, tempo bands, formats, file/review filters, BPM target and tolerance, half/double-time inclusion, key, filter expansion, inspector ID, multi-selection, range anchor, and scroll position across page navigation. Layout, sort, and active collection still use the existing saved organization view. The new browsing context lasts for the renderer session; it is not a new disk format or restart-recovery system.

The Library waits for its collection snapshot before reconciling selection or restoring scroll. This avoids treating an interim all-audio view as an intentional scope change. A failed snapshot offers Retry without discarding the remembered workspace. Explicit scope/filter/smart-rule changes clear selection and reset scroll; membership and result changes prune hidden IDs without selecting new matches. Removed records also clear the inspector. Scroll offsets are clamped by the actual scroll container when the available content or viewport changes.

The store has no playback imports or action/dialog drafts. Delete, rename, export, metadata correction, and annotation drafts stay component-local. Returning to Library neither captures a new listening queue nor starts playback or submits an operation.

## Verification commands

Typechecking and the production build passed. All three workspace-store cases, 11 existing search cases, five new Electron workspace cases, and six focused existing collection/playback regressions passed. The final workspace run had zero retries and zero renderer errors; its local report is `test-results/reports/1790299269335-0d89d1a4-e2dd-4b3c-9add-5b8cc7c52836.json`.

```powershell
npm run typecheck
npm run build
node --test tests/library-workspace.test.mjs tests/library-search.test.mjs
npx playwright test tests/library-workspace.spec.mjs
npx playwright test tests/collections.spec.mjs tests/playback.spec.mjs --grep 'selection follows|right-click|select all matching|membership changes|Play selected|captured collection'
```

The Electron tests use isolated temporary profiles, generated WAV fixtures, real local playback, and the existing process-ownership/normal-close checks. The grid and list acceptance cases filter a 32-track collection, select three tracks, inspect a fourth, audition, scroll, and visit both Download and Settings. They assert restored controls, selection, range anchor, inspector, scroll, advancing playback, queue label/count, and the original next-track sequence after filtering to zero results.

Additional cases cover membership changes and record deletion while away, deliberate scope changes, discarded metadata/annotation drafts, and unmounting with pending delete/rename/export dialogs. The pending-dialog case dispatches the existing navigation button directly because modal overlays intentionally block pointer navigation; it verifies restoration boundaries, not a supported gesture through a modal.

This change does not claim fresh packaged/installed-app verification or DSP accuracy improvements. Existing DSP benchmark limitations remain unchanged.
