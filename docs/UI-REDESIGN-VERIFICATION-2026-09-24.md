# Sonic workspace UI

This UI change builds on the Library workspace continuity change in PR #7. It gives Downloads, Library, Settings, and the persistent player one shared visual system: graphite or light neutral surfaces, a restrained configurable accent, consistent controls, and a stable sidebar/content/player layout.

## What changed

- Library puts search, filters, collections, and result actions above artwork cards or a compact list. A separate scrolling inspector holds track details, metadata corrections, notes, and tags.
- Downloads uses a compact link composer, export preferences, visible queue actions, and a metadata inspector. The inspector narrows with the window, stays beside the composer, and can be dismissed until a new job becomes available.
- Settings groups related preferences and shows actual theme/accent previews. The player keeps its waveform mounted across navigation, gives sliders larger pointer targets, and labels playback errors explicitly.
- Shared colors, typography, borders, buttons, fields, focus outlines, badges, and dialogs now follow the same system. Redundant page kickers and ornamental dashboard panels were removed.

The four implementation areas were delegated to separate agents; integration, shared primitives, and validation were performed together. [Hallmark's skill](https://github.com/nutlope/hallmark/blob/main/skills/hallmark/SKILL.md) and relevant design guidance were read remotely from GitHub for the final review. No skill was downloaded, installed, or copied into the repository.

## Behavior and scope

Library search, filters, selection, range anchor, scroll, and inspector restoration remain separate from the captured playback queue. Navigation does not submit pending metadata/annotation drafts or reopen action dialogs. Import, export, correction, collection, queue, theme, and native-window controls keep their existing operations and accessible names.

This is a renderer UI change. It does not alter IPC contracts, storage formats, download services, or audio analysis algorithms. The target is the native desktop app, including its 1024 × 680 minimum window; it is not a mobile website.

## Verification

Typechecking and production builds passed. The broad Electron regression run passed 50 tests with one skip and no retries or unexpected failures. It covered collections, corrections, interactions, workspace continuity, local import, persistence, playback, and the redesigned layouts. Local report: `test-results/reports/1790300515639-d4e8afe3-1ac6-43e0-830a-f8fb4ee14e5f.json`.

After the final visual and accessibility refinements, eight component cases and both new redesign cases passed. Local report: `test-results/reports/1790301198240-ac905219-2f82-43fe-a19c-c31bc65bdcda.json`. The final narrower Downloads inspector then passed both redesign cases again, including a hit test proving that an enabled Add to queue button remains unobstructed. Final report: `test-results/reports/1790301304428-ae30f7f2-7fe5-4f11-b752-9a1e40f8b190.json`.

The skipped native pointer test could not acquire Windows foreground input. Chromium pointer tests of minimize, maximize, restore, and button edges passed. Packaged/installed-app execution was not part of this change.

```powershell
npm run typecheck
npm run build
node scripts/build-component-harness.mjs
npx playwright test tests/components.spec.mjs
npx playwright test tests/ui-redesign.spec.mjs tests/library-workspace.spec.mjs tests/interactions.spec.mjs tests/editor-corrections.spec.mjs tests/collections.spec.mjs tests/playback.spec.mjs tests/local-import.spec.mjs tests/persistence.spec.mjs
```

The UI tests use isolated temporary profiles and generated WAV fixtures. They exercise both themes at 1440 × 960 and 1024 × 680, check horizontal overflow, visible playback controls, theme-preview containment, slider target sizes, inspector dismissal/reopening, and primary-button contrast across all five accents at rest and on hover. Primary-button text clears WCAG 4.5:1 in all 20 combinations; keyboard focus retains a visible 2px outline. This is targeted contrast coverage, not a claim of a full accessibility audit.

## Screenshots

These are captures of the running Electron app with generated fixture audio and sample titles, not the user's music library.

Library, dark theme, 1440 × 960:

![Dark Library with track inspector and persistent player](assets/ui-overhaul/library-dark-1440.png)

Library, light theme, minimum window:

![Light Library at 1024 by 680](assets/ui-overhaul/library-light-1024.png)

Downloads, minimum window; composer and inspector remain side by side:

![Downloads at 1024 by 680](assets/ui-overhaul/download-dark-1024.png)

Settings, dark theme:

![Settings theme and accent previews](assets/ui-overhaul/settings-dark-1440.png)
