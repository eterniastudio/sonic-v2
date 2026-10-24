# What has changed in Sonic

This history brings together all nine pull requests merged before the current
improvement work. Dates are merge dates in Eastern Time (America/New_York).
Each entry describes what became useful in the app, with links to the original
change and its verification notes. Historical test results describe that version;
they are not a claim that every later version has been tested the same way.

## October 24, 2026

### Large libraries stay responsive — [details](PERFORMANCE-2026-10-24.md)

With 5,000 to 20,000 tracks, everyday library changes do much less work:

- **Saving a change rewrites only what changed.** Sonic still saves the whole library file after each change, but it now re-encodes only the tracks that changed. Saving one analysis result took 685 ms at 20,000 tracks and now takes 134 ms, most of which is writing the file. At 5,000 tracks it went from 125 ms to 31 ms. The file format is unchanged.
- **The window receives only what changed.** A one-track change sent all 47.6 MB of the library to the window. It now sends 296 KB. Delivering and applying it took 953 ms and now takes 18 ms.
- **Search indexing waits until you search.** Filling in tempo and key no longer rebuilds the search index for every track analysed. It is built when you type a query, or once the library is quiet. Search results are unchanged.
- **Import review no longer slows down as the library grows.** Checking each file against the library took 101 ms at 20,000 tracks and now takes under 1 ms.
- Key filters are about ten times faster.

Opening the library is 14–52 ms slower, because saved tracks are now protected against accidental in-place edits. The first search after a change costs what an index rebuild cost before.

## October 21, 2026

### White Label: a full visual redesign

Sonic has a new look built on promo white-label records. In the dark theme, label-white type sits on black vinyl. In the light theme, the interface is the label stock itself. Square-cut panels, one-pixel rules and a single stamp-blue ink replace the old graphite cards and the five-accent picker. Saved accent settings still load and now resolve to stamp blue.

Every tempo and key value now shows where it came from, wherever you read it: library rows, the inspector, and the player.

| Mark | Meaning |
| --- | --- |
| **Bold printed figure** | Read from the source title, description or file name |
| Blue stamped box | Read from the file's own embedded tag |
| Dotted underline with three dots | Measured from the audio; the dots show analyser confidence |
| Handwritten figure | Your own correction, which always wins |

A legend above the library table spells this out. The inspector shows the track as a record. Its centre label carries the artwork, or, when there is none, the tempo and key written in their marks. The player's record turns while audio plays.

Type is now Archivo, with condensed caps for headings and figures, and Shantell Sans for manual corrections. Both are bundled locally under the SIL Open Font License, and Inter was removed. Layout, controls, keyboard access and accessible names are unchanged.

## October 9, 2026

### Test the app without interrupting your desktop — [PR #9](https://github.com/eterniastudio/sonic-v2/pull/9)

Routine interface checks can run with Sonic's windows hidden using
`npm run test:ui:hidden`. They still exercise the real application, so working on
Sonic no longer has to open a series of test windows over your other work.
Tests that need real Windows window controls or pointer input still use the
visible test command. This changes the development workflow, not audio playback
or processing speed. Intermittent native Electron shutdown crashes were observed
in testing; successful reruns did not establish a fix for them.

### A clearer workspace, more sources, and faster library work — [PR #8](https://github.com/eterniastudio/sonic-v2/pull/8)

The Library became a compact music workspace with source artwork, distinct
selection and playback states, a persistent waveform player, and clearer
tempo/key evidence. Dark and light themes use the same layout. The inspector
keeps the important controls visible at the minimum supported window size.

The final merged change also included later work beyond the PR's original design
description:

| What you can do | What changed |
| --- | --- |
| Bring in more music | Download individual SoundCloud tracks and review a YouTube playlist before choosing tracks to queue. Playlist reviews have explicit size limits; SoundCloud playlists and profiles are unsupported. |
| Reconnect moved audio | Use **Locate file…** or **Find missing files…** to verify matching audio and reconnect existing library records while keeping notes, collections, corrections, and listening positions. Imported originals remain read-only. |
| Preview downloads inside Sonic | **Preview in Sonic** uses the Library's player, avoiding a separate default media player and overlapping audio sources. |
| Browse with less repeated work | Playback notifications are bounded, unchanged search indexes and library records are reused, and file checks run with bounded concurrency. Queue progress and unrelated metadata changes no longer require every row to render again. |

The recorded 10,000-track search fixture averaged **1.16 ms** to reuse an index
versus **44.77 ms** to rebuild one. Controlled playback streams produced **10
notifications per second**, previously 60 or 120. These measure specific internal
operations on test fixtures; they do not establish overall app CPU use or a
universal speedup. Key detection was unchanged in this PR.

See the [visual review](UI-REDESIGN-VERIFICATION-2026-09-24.md),
[performance measurements](PERFORMANCE-REVIEW-2026-10-04.md),
[file recovery contract](RECOVERY-VERIFICATION-2026-10-04.md),
[playlist behavior](PLAYLISTS-2026-10-05.md), and
[playback handoff verification](PLAYBACK-HANDOFF-FIX-2026-10-05.md).
Live YouTube playlist downloads were not exercised in the documented playlist
verification; it used extractor fixtures and an isolated packaged smoke test.

### Keep your place while moving between views — [PR #7](https://github.com/eterniastudio/sonic-v2/pull/7)

Switching from Library to Download or Settings and back now restores your search,
filters, selected tracks, inspector, and scroll position. Your listening queue
keeps the tracks you originally chose, even if you browse a different collection.
This browsing context lasts for the current app session. Unsaved edits and open
confirmation dialogs are not restored or submitted automatically.
See [workspace verification](LIBRARY-WORKSPACE-VERIFICATION-2026-09-24.md).

## September 24, 2026

### Keep listening across views and resume where you stopped — [PR #6](https://github.com/eterniastudio/sonic-v2/pull/6)

Audio continues when you leave Library because one app-wide player owns playback.
**Play one**, **Play results**, and **Play selected** create a stable listening
queue in the order you chose. Restarting Sonic restores your last track, volume,
and saved position paused, ready for you to resume. Saving problems remain visible
and can be retried. See [playback verification](PLAYBACK-VERIFICATION-2026-09-23.md).

## September 23, 2026

### Organize a project shortlist and work on several tracks — [PR #5](https://github.com/eterniastudio/sonic-v2/pull/5)

Save notes and tags, build manual collections, or create smart collections from
search rules. Select several tracks to analyze or export together, with progress,
cancellation, and per-track failures. Collections follow stable track identities
instead of filenames, so a rename does not lose your shortlist. Retrying an export
after a library-save failure reconciles the existing output instead of making
another copy. See [collections verification](COLLECTIONS-VERIFICATION-2026-09-23.md).

### Check key and tempo against independently labeled recordings — [PR #4](https://github.com/eterniastudio/sonic-v2/pull/4)

Added a repeatable audio benchmark so analyzer changes can be checked against
known musical references, without feeding titles or tags to the analyzer. In the
original 28-recording guitar cohort, the analyzer's primary answer matched the
reference key on **11/28** recordings and tempo on **10/28**. Some other results
were inconclusive or half/double-time readings. These were baseline measurements,
not an improvement to the detector and not an accuracy claim for a full beat
library. The corpus had no real negative examples, so false positives on real
nonmusical recordings were not measured. See the
[benchmark and its limits](DSP-BENCHMARK-2026-09-23.md).

### Import your own audio without changing the originals — [PR #3](https://github.com/eterniastudio/sonic-v2/pull/3)

Add local files or folders, review duplicates, and analyze, preview, search, or
correct their library metadata. Sonic references those files in place. Renaming
or removing an imported record affects the Library entry, while the original
audio stays untouched. Choose **re-export** to create a separate Sonic-owned copy
with your reviewed metadata. Failed imports can be retried individually.
See [local import verification](LOCAL-IMPORT-VERIFICATION-2026-09-23.md).

### More dependable analysis, clearer metadata, and better search — [PR #2](https://github.com/eterniastudio/sonic-v2/pull/2)

Analysis batches wait until their queued state is saved, and cancellation and
shutdown settle their status more consistently. Concurrent re-exports use separate
temporary folders. The metadata editor explains whether a value came from source
text, tags, audio, or your correction, keeps untouched fields up to date, and
reports whether file tags or sidecars still need attention. Library search gained
relevance sorting and BPM, key, and review filters.
See [reliability verification](RELIABILITY-FOLLOWUP-2026-09-23.md).

### Stop cancelled or failed analysis from looking successful — [PR #1](https://github.com/eterniastudio/sonic-v2/pull/1)

Repeated batch requests no longer schedule the same track twice. Cancelled
reanalysis preserves the previous result, late cancelled results are rejected,
and missing or removed tracks do not leave misleading queued badges. A failed
save is reported as a failure even when the audio calculation completed. The
change also added coordinator regressions and an architecture review. Its first
verification covered those focused tests; the full Windows app and packaging
were not verified in that PR's original environment.
See the [repository review](REPOSITORY-REVIEW-2026-09-23.md).

## Reading the older accuracy and verification notes

PRs #1–#9 did not improve the acoustic key estimator. Their repeated **20/22**
synthetic result refers to the same historical detector, including two strict
relative-key cases that returned inconclusive. Later key changes need their own
results; old passing interface tests do not establish musical accuracy.

Several milestones were checked in an unpacked Windows application. That is
different from running an installer and testing an installed release. Each linked
verification note retains its original scope and unresolved failures.
