# Sonic music workspace UI

Updated September 25, 2026. Sonic keeps compact navigation and an efficient Library while giving artwork, musical metadata, and the persistent audio transport a clearer hierarchy.

## What changed

- The 180px sidebar and title bar form a darker outer shell. A lighter workspace, distinct inspector, and dedicated transport surface provide tonal depth. Light theme uses the same hierarchy. Page titles and track names have stronger emphasis; secondary labels remain readable. Inter is bundled locally with its OFL license.
- Library retains 52px rows and saved layout preferences. Batch selection uses checked boxes and a restrained accent tint; inspection adds an edge marker and detail icon; playback has an explicit Playing/Paused label; hovering reveals the play action. Keyboard focus has a visible outline. Missing files retain readable labels and an accessible warning.
- The inspector leads with actual source artwork and track identity, followed by prominent BPM/key and recorded provenance. At shorter window heights, 72px artwork sits beside the title so metadata and Play remain visible. Corrections, file details, notes, and tags remain below. Distinct React keys also fix duplicate inspector content when switching tracks directly.
- The 77px player includes 52px artwork, track/producer identity, readable BPM/key with recorded provenance, a clear accent play button, and the existing audio-derived waveform. The single playback owner and waveform mount remain intact. Library subscribes only to track/status changes, avoiding rerenders on every playhead update.
- Downloads adopts the same tonal inspector and clearer typography, retaining 68px queue rows. Settings retains straightforward preference rows with clearer labels. Primary actions, playback progress, focus, and selection use the selected accent; other controls remain quiet.

Artwork uses the app's existing source-thumbnail capability. Absent or failed images show a neutral audio icon. This change does not add embedded-cover extraction. Metadata provenance follows the existing decision model; unknown values remain unknown. There are no fabricated analysis results, confidence values, decorative waveforms, gradients, or glowing panels.

The Library and player were implemented and visually inspected in the running Electron app before the direction was propagated to Downloads and Settings. Four agents handled bounded implementation areas; a further read-only review checked playback ownership, independent states, accessibility, and provenance. [Hallmark's skill](https://github.com/nutlope/hallmark/blob/main/skills/hallmark/SKILL.md) and relevant guidance were read remotely, without downloading or installing the skill.

## Before and after

The baseline is commit `b91931a`. Both sets use the same 14-track fixture library: real image elements supplied with clearly labelled original test artwork, absent artwork, a deliberately failed image, a long title, unknown BPM/key, a missing audio file, active playback, multiple selections, and an open inspector. The compared states play Midnight Transit, inspect The Last Train Home, and batch-select two other tracks. Playback time differs because the revised test also exercises seeking.

| Theme and window | Before | After |
| --- | --- | --- |
| Dark, 1440 × 960 | [Before](assets/ui-overhaul/comparison/before-library-dark-1440.png) | [After](assets/ui-overhaul/comparison/after-library-dark-1440.png) |
| Dark, 1024 × 680 | [Before](assets/ui-overhaul/comparison/before-library-dark-1024.png) | [After](assets/ui-overhaul/comparison/after-library-dark-1024.png) |
| Light, 1440 × 960 | [Before](assets/ui-overhaul/comparison/before-library-light-1440.png) | [After](assets/ui-overhaul/comparison/after-library-light-1440.png) |
| Light, 1024 × 680 | [Before](assets/ui-overhaul/comparison/before-library-light-1024.png) | [After](assets/ui-overhaul/comparison/after-library-light-1024.png) |

All four comparisons were visually inspected. The first pass revealed that large inspector artwork pushed metadata below the fold at minimum size; the compact arrangement fixes that. Additional captures cover absent/failed artwork, missing-file controls, unknown metadata, and simultaneous focus/hover. Test artwork is intercepted offline, and the audio is generated WAV content. These are fixtures, not the user's library; displayed musical values are explicitly manual annotations, not measurements of the generated audio.

![Library with distinct artwork, inspection, selection, and playback](assets/ui-overhaul/library-dark-1440.png)

![Minimum-size Library and transport in light theme](assets/ui-overhaul/library-light-1024.png)

![Downloads at minimum window size](assets/ui-overhaul/download-dark-1024.png)

![Settings with clearer preference rows](assets/ui-overhaul/settings-dark-1440.png)

## Behavior and verification

This PR is stacked on Library workspace continuity PR #7. Search, filters, selection, range anchor, scroll, and inspector restoration remain separate from the captured playback queue. Import, export, correction, collections, queue management, theme settings, reduced motion, and native window controls retain their behavior. The only main-process change in the complete PR remains the default layout for new Library workspaces, from grid to list; existing saved views are preserved. IPC contracts, storage formats, and analysis algorithms are unchanged.

Typechecking and the production build passed. The final regression run passed 44 cases in 5.4 minutes, with one Windows OS pointer case skipped and no retries or failures. It covers eight component cases, five Library workspace cases, collections, playback, interactions, and three visual/contrast cases. Local report: `test-results/reports/music-workspace-final-20260925.json`.

Windows foreground locking prevented the OS pointer case from receiving input. Chromium pointer coverage for window controls, including their edges, passed. A subsequent focused run passed after adding a keyboard-modality assertion for the selection checkbox's visible 2px outline in both themes; report: `test-results/reports/music-workspace-focus-20260925.json`. Captures show [dark keyboard focus with hover](assets/ui-overhaul/comparison/after-focus-hover-dark-1024.png), [light keyboard focus with hover](assets/ui-overhaul/comparison/after-focus-hover-light-1024.png), and [unknown metadata in the player](assets/ui-overhaul/comparison/after-player-unknown-light-1024.png).

```powershell
npm run typecheck
npm run build
node scripts/build-component-harness.mjs
npx playwright test tests/music-workspace.spec.mjs tests/ui-redesign.spec.mjs tests/components.spec.mjs tests/library-workspace.spec.mjs tests/interactions.spec.mjs tests/collections.spec.mjs tests/playback.spec.mjs
```

The visual tests cover both themes at 1440 × 960 and 1024 × 680, independent playing/inspected/selected tracks, direct inspector switching, play/pause/seek, image fallback, unknown metadata, missing-file restrictions, visible metadata and Play at minimum size, local fonts, horizontal overflow, unobstructed controls, inspector dismissal/reopening, slider targets of at least 24px, and primary-button contrast across all five accents at rest and on hover. Primary-button text passed 4.5:1 in all 20 combinations. This is targeted contrast coverage, not a full accessibility audit. Packaged/installed-app execution is outside this verification.
