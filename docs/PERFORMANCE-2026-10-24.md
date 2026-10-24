# Large-library performance — October 24, 2026

This pass follows the [October 4 review](PERFORMANCE-REVIEW-2026-10-04.md) and the
[October 20 review](IMPROVEMENTS-2026-10-20.md). Those already batched imports, kept
transient statuses off disk, windowed the lists and queue, reused the search index for
unindexed changes, and cached playback identity. Nothing here redoes that work. The
target is a 5,000–20,000 track library: what each library change costs on Sonic's main
thread, what crosses to the window, and what the window does with it.

Persisted formats, IPC channel validation and the trust boundary are unchanged. The
library file is byte-for-byte what it was (compact JSON of the same array). Commits are
still synchronous, flushed and atomically replaced, with the previous commit as backup.

## What changed

1. **A library commit serializes only the records that changed.** The library store now
   keeps each committed record frozen, together with its JSON text. A commit reuses the
   text of every untouched record and serializes and copies only new ones, instead of
   `JSON.stringify` plus a full `JSON.parse` copy of the whole library each time.
   Unchanged records stay the same objects across commits. Writing and flushing the file
   remain, and are now most of a commit's cost (`src/main/lib/jsonStore.ts`, opt-in
   `recordCache`, used only by `library.ts`).
2. **Library pushes send a delta.** The window was sent every record after every change:
   47.6 MB of structured clone at 20,000 tracks, which the window then deep-compared
   record by record. Because unchanged records keep their identity (1), the main process
   now sends the ordered ids plus only the changed records on a new `library:delta`
   channel (declared in the shared channel list, so preload validation covers it). The
   window rebuilds the same list, keeping unchanged row objects. If most records changed,
   the full list is sent as before. If an id is unknown, for example when a push races
   the first load, the window fetches the full list (`src/main/broadcast.ts`,
   `src/main/libraryDelta.ts`, `src/renderer/src/store/snapshots.ts`).
3. **The search index is built only when you search.** Every change to an indexed field
   rebuilt MiniSearch, even with no query typed. When a batch analysis fills in tempo and
   key, that happened once per track. The index now builds on the first query, or after
   the library has been quiet for 1 s in idle time. The built index is the same as before,
   built from the same documents in the same order, so results and their order do not
   change (`librarySearch.ts`).
4. **Faster index reuse check.** Records that kept their identity are skipped, and the
   field comparison is written out field by field rather than looped.
5. **Key filters parse each key spelling once per search** instead of once per row.
6. **Import review checks each file against an index of the library.** Inspecting a file
   used to copy the library and canonicalize every record's path, twice per file: 100 ms
   per file at 20,000 tracks, so about 100 s of main-thread time for a 1,000-file review.
   One path and fingerprint index is now built per library revision. Matches are the
   same: the newest record wins, as `Array.find` did (`localImport.ts`,
   `libraryService.ordered()`).
7. **Playback track lookups use an id map**, rebuilt only when the library array changes,
   instead of a linear search per lookup (`playbackSession.tsx`). This one is minor and
   was not measured separately.

## Measurements

Windows 11, Node 24.14, the same machine for both revisions. Other agents were running
builds and tests on it at the same time, so disk-bound numbers vary widely. Each cell
is the median of 3 alternating runs (6 for the 20k import). "Before" is `HEAD`
(`9727f1f`) measured by the same benchmark code via `SONIC_BENCH_REF=HEAD`.

| Operation | Library | Before | After |
| --- | ---: | ---: | ---: |
| Commit one analysis result (`storage-commit-benchmark`, ms per track) | 5,000 | 124.7 | 31.3 |
| | 20,000 | 685.2 | 133.9 |
| Import 1,000 files in 4 commits (ms) | 5,000 | 506 | 165 |
| Import 250 files in 1 commit (ms) | 20,000 | 281 | 232 |
| First load of `library.json` (ms) | 5,000 | 59 | 73 |
| | 20,000 | 251 | 303 |
| Import review, library lookups per inspected file (ms) | 5,000 | 29.6 | 0.18 |
| | 20,000 | 101 | 0.58 |
| Push one changed record to the window: serialize + deserialize + reconcile (ms) | 5,000 | 111 | 2.8 |
| | 20,000 | 953 | 17.9 |
| Bytes pushed for that change | 5,000 | 11.9 MB | 70 KB |
| | 20,000 | 47.6 MB | 296 KB |
| Indexed field changes while no search is typed (ms) | 5,000 | 27.1 | 0.15 |
| | 20,000 | 130.9 | 0.6 |
| Index reuse check, unindexed change (ms) | 20,000 | 2.45 | 0.22–0.40 |
| Key filter `Am` (ms) | 5,000 | 2.24 | 0.19–0.36 |
| | 20,000 | 19.3 | 0.8–1.8 |

Commit times include the file write and flush, which is now most of the cost: about
50 ms for the 46 MB file at 20,000 tracks. Push times use `v8.serialize`/`deserialize`,
the serializer Electron's IPC uses. They exclude the pipe itself and React rendering, so
the real saving per push is larger than shown.

**What got slower or stayed the same:**

- **First load is 14–52 ms slower** because the loaded records are frozen. The commits
  above save that much on every change.
- **The first query after an indexed change costs what a rebuild cost before.** The
  same index is built, only later. Measured on its own at 20,000 tracks, building plus
  the first query took 133–148 ms, against 126–148 ms for the old rebuild followed by a
  query. Inside the benchmark process this figure drifts (136–260 ms) depending on what
  earlier sections left on the heap.
- **Title sorting is unchanged.** Measured on its own, 0.57–0.62 ms against 0.55–0.60 ms
  at 5,000 tracks.

Reproduce:

```powershell
node tests/storage-commit-benchmark.mjs
$env:SONIC_BENCH_EXISTING=20000; $env:SONIC_BENCH_IMPORTS=250; $env:SONIC_BENCH_ANALYZED=30; node tests/storage-commit-benchmark.mjs
$env:SONIC_BENCH_SIZES='5000,20000'; node tests/library-performance-benchmark.mjs
# Prefix either with $env:SONIC_BENCH_REF='HEAD' to measure a git revision.
```

`storage-commit-benchmark.mjs` now also reports first-load time and the import-review
lookups. `library-performance-benchmark.mjs` now covers pushes, indexed changes and
filtered search, and can measure a git revision.

## Safety notes

- Committed library records are frozen. Code that mutated one in place would now throw
  instead of silently diverging from what is on disk. The full unit and UI suites found
  one such case, a test that instrumented records after loading. That test now
  instruments them while they load.
- Failed writes, the pending-revision guard, `stage()` and storage retry behave as
  before. `tests/performance-paths.test.mjs` covers identical bytes, record identity,
  copy-on-commit, retry, delta reconstruction and fallback, and lazy and eager index
  equality.

## Measured and left alone

- **Provenance per row.** `beatOrigins` costs 2.9 ms per 5,000 rows. Windowed lists
  mount only a few dozen rows, so caching it would save almost nothing.
- **Title sort with `Intl.Collator`.** `localeCompare` is already on V8's fast path here
  and showed no measurable cost.
- **Buffer-based writes.** Writing cached UTF-8 buffers instead of a string saved about
  30% of the write (51 → 37 ms at 46 MB) but doubled the store's memory. Not adopted.
- **The `sonic-media` Range path.** Playback uses WaveSurfer's WebAudio backend, which
  fetches the whole file to decode it, so Range support would not change playback today.
- **Queue deltas.** Queue jobs are changed in place, so identity cannot reveal what
  changed, and the queue's job-assignment code is being edited in parallel. Progress
  pushes stay coalesced at 80 ms with full snapshots.

## Remaining opportunities

1. **Replies to edits still return the full library.** `library:updateMetadata`,
   `library:remove`, `library:rescan` and `library:refreshSource` reply with every record:
   about 1 s per edit at 20,000 tracks (the full-push figure above). The same change
   already arrives as a delta, so these replies could return nothing, or a delta. That
   changes the IPC contract, so it was left for a coordinated change.
2. **Create the window before loading the library.** That could overlap renderer start-up
   with the 250–300 ms parse at 20,000 tracks. It needs an Electron start-up measurement,
   and the failure path must still show no window.
3. **Move the library write off the main thread.** This needs a new definition of an
   acknowledged save.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `node --test tests/*.test.mjs` | 233/234; the one failure is the known `export-tags` Opus header case |
| Required hidden UI specs (render, virtualization, playback, persistence, music workspace) | 22/22 on the first full run. After the last code change: 20/22, then both failures passed on rerun (one Electron exit 3221225477, one 120 s timeout in the music-workspace test, which takes 2.0 min when it passes) |
| Also run: local-import, recovery, library-workspace, collections | All 38 passed across reruns. Failures came from `tests/app-lifecycle.mjs` failing to parse the OS process list, plus exit 3221225477 |

The process-list failures came from other sessions on the same machine. Their shell
command lines contained raw line breaks, which the snapshot script emits unescaped, so
the test harness could not parse it as JSON. This was captured while it happened; the
failures are not caused by these changes.
