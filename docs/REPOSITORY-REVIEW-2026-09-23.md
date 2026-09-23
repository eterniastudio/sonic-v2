# Sonic V2: architecture review and next implementation priorities

Reviewed on 2026-09-23 against `main` commit
`4db36ea6eb38bbf5109018c3a3ad7a22bd307cb1`.

This is a source review of the current Electron application, not the older Sonic
Tauri project. It covers the core intake, analysis, persistence, export, library,
IPC and renderer flows. It is not a claim that every component, native Windows
interaction, dependency or DSP output has been exhaustively verified.

## Product model

Sonic is a local-first producer workspace, not a general streaming client:

```text
Authorized YouTube URL(s)
  -> probe/source inspection
  -> metadata review and per-field manual overrides
  -> acquisition + embedded-tag readback
  -> local acoustic analysis (FFmpeg decode -> worker-thread DSP -> cache)
  -> recipe conversion / tagging
  -> exclusive publication + provenance sidecar + library record
  -> search, waveform audition, correction, safe rename, re-export
```

The important distinction is between **what the uploader declared**, **what a
container tag says**, **what the audio suggests**, and **what the producer chose**.
An acoustic estimate must not silently replace a manual correction or masquerade
as source evidence. Improving this trust model is more valuable than adding
another decorative panel.

### Current ownership boundaries

| Layer | Responsibility | Source entry points |
| --- | --- | --- |
| Electron main | Lifecycle, privileged IPC, tools and filesystem operations | `src/main/index.ts`, `src/main/ipc.ts` |
| Export queue | URL intake, source probes, job state, recovery and orchestration | `src/main/services/queue.ts` |
| Analysis service | Cache identity, decoding windows, worker execution, shared capacity | `src/main/analysis/service.ts`, `worker.ts`, `decode.ts` |
| Library coordinator | Library request scheduling, cancellation, applying analysis outcomes | `src/main/analysis/libraryAnalysis.ts` |
| Library service | Persisted records, metadata overrides, identity checks, rename/delete/sidecar operations | `src/main/services/library.ts` |
| Publication | Exclusive output creation, sidecars, library registration, owned-output cleanup | `src/main/services/publish.ts` |
| Persistence | JSON snapshots, flushed temporary writes, atomic replacement, backups and retryable revisions | `src/main/lib/jsonStore.ts` |
| Shared domain | Metadata authority, independent BPM/key outcomes, musical naming, verification | `src/shared/analysis.ts`, `metadata.ts`, `music.ts` |
| Renderer | Zustand mirror, search/filter views, inspectors and waveform playback | `src/renderer/src/store/app.ts`, `features/library/` |

The current store is **JSON-based**, not SQLite. Renderer state mirrors main-process
responses and push events; it is not the filesystem authority. Exported audio,
its sidecar, and the library record are separate artifacts that can fail at
different stages. A successful acoustic calculation alone does not prove all
three are synchronized.

## What should be preserved

- Separate tempo/key outcomes, alternatives and explicit inconclusive results.
  `src/shared/analysis.ts` already makes these independent.
- Field-level manual ownership. The current `MetadataCorrection` component in
  `PreviewTransport.tsx` already distinguishes untouched fields from deliberate
  empty values; do not reintroduce whole-form overwrites.
- Conservative file ownership checks. `LibraryService.applyAnalysisLocked`
  rechecks input bytes, while deletion and rename operations protect owned files.
- Publication safety. `publish.ts` reserves outputs exclusively, checks ownership
  before rollback, and preserves published exports when the library commit needs retry.
- Persistence truthfulness. `JsonStore` keeps a failed pending revision and rejects
  a different mutation until it is retried. Its cached state changes only after
  replacement succeeds; it must not be treated as an optimistic write-through cache.
- Shutdown coordination. `index.ts` waits for owned operations and intentionally
  keeps the application open if safe shutdown cannot finish.

## Implemented in this PR

The production change is confined to `src/main/analysis/libraryAnalysis.ts`.
There are no schema, dependency, recipe, DSP or visual-design changes.

1. Deduplicate batch IDs before counting or scheduling them; reject records that
   are already missing and avoid duplicate work across overlapping batches.
2. Clear a stale queued status when a file becomes missing before its turn, without
   blocking subsequent entries or resurrecting a removed record.
3. Restore the status derived from an existing analysis when a retry is cancelled,
   rather than relabeling an already analyzed beat as never analyzed.
4. Keep a coordinator cancellation marker so a successful service reply arriving
   after cancellation cannot start applying its result. This guard is before
   `applyAnalysis`; it does not roll back a library mutation already in progress.
5. Scope coordinator-wide cancellation to `beat:` requests, leaving download
   `job:` requests to their owner. Application shutdown still invokes the shared
   service's global shutdown separately.
6. Forward only well-formed library progress and reject new work after this
   coordinator has shut down, even without relying on the global lifecycle flag.
7. Report a rejected apply as removed **or changed input**, and attempt to clear
   a stranded analyzing status for a surviving record.
8. Return `ok: false` when library/sidecar saving fails after DSP succeeds, while
   retaining the acoustic result in the outcome. An already committed analysis is
   not erased just because its sidecar failed. The previous `ok: true` result
   caused the existing renderer to display a success toast and ignore the error.
9. Surface error outcomes from background batches through the existing notice
   route; expected failures resolve as outcomes and were not caught by a
   promise-rejection handler alone.

Status cleanup is best-effort when storage itself is failing. The PR deliberately
does not overwrite a failed pending revision to make a status badge look finished.
The real-store regression verifies that explicit retry can commit that revision.

## Remaining work, ranked

### P0: Validate the privileged IPC boundary at runtime

**Evidence:** `src/main/ipc.ts`'s `handle` wrapper ignores the sender event and
casts unknown arguments to TypeScript DTOs. Its `app:openPath` and
`app:revealPath` handlers accept renderer-supplied paths. A typed/preload-allowlisted
bridge is useful, but does not itself validate the caller or payload.

**Change:** Validate the sender/frame and each command's runtime schema. Prefer
beat-ID scoped open/reveal actions resolved in main; retain directory/tool choices
through explicit native dialogs and tightly scoped settings operations. Review
all paths, URLs, enum values, array bounds and metadata strings crossing IPC.

**Acceptance:** Tests reject foreign senders, malformed payloads, arbitrary path
opens and invalid URLs while preserving legitimate library and settings flows.
This is a defense-in-depth finding, not a demonstrated exploit. See Electron's
[official security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
including validation of IPC senders.

### P0: Make metadata provenance and reset behavior consistent

**Evidence:** `PreviewTransport.tsx` labels a displayed field "audio" when an
estimate exists and the field has no manual override, even if its displayed value
was retained from source text or an embedded tag. In `library.ts`, clearing an
override restores the analyzed value or null, rather than applying the README's
complete source-text -> embedded-tag -> estimate priority.

**Change:** Share one provenance selector between queue, library, badges and
sidecars. Separate "reset to evidence priority" from "adopt measured value" as
explicit actions. Display field-level disagreement and synchronization state.

**Acceptance:** Fixtures covering conflicting source/tag/audio values and manual
nulls produce the same final values, labels and reset behavior across all views.
A successful save toast must distinguish saved metadata from a pending sidecar or
embedded tags that require re-export.

### P0: Recover interrupted batch admission after storage retry

**Evidence:** `libraryAnalysis.ts` currently persists queued status one record at
a time, while `JsonStore` blocks new mutations after a failed pending revision.
A failure partway through accepting a batch can separate persisted statuses from
the in-memory pending list. The PR does not add a new durable scheduler or pretend
that draining immediately after a failed write solves this barrier.

**Change:** Define an explicit admission/commit protocol and resume owned pending
work only after the failed library revision is successfully retried. Reconcile
status-only states without discarding pending metadata changes. Coordinate this
with `storage:retry`, cancellation and shutdown.

**Acceptance:** Inject failure on the second accepted beat, on the analyzing-status
commit, and during cancellation. Retry must neither duplicate work nor leave a
queued/analyzing badge with no owner. Use the real store, not only permissive doubles.

### P1: Apply cancellation and deadlines to the whole analysis request

**Evidence:** `analysis/service.ts` hashes/probes before acquiring a work slot;
its semaphore wait is not abortable. The advertised 180-second ceiling is created
inside `runWorker`, not around engine resolution, hashing, decoding and waiting.
The worker exit handler settles non-zero exits but not an exit without a reply
when the code is zero.

**Change:** Use one end-to-end deadline/AbortSignal, a cancellable semaphore and
bounded preprocessing. Settle every worker exit and clean up timers/listeners.
Report waiting, decoding and DSP phases accurately.

**Acceptance:** Cancel while queued, hashing, decoding and analyzing; simulate
silent worker exit and timeouts. All owned resources settle, and unrelated
library/download requests continue.

### P1: Serialize or isolate re-export operations

**Evidence:** `reexport.ts` derives staging paths from only beat ID and extension
(`reexport_<id>.<extension>`). Concurrent same-beat/same-format requests target the
same temporary path. Its new AbortController is not exposed to a cancellation
owner, and the publication call does not pass that signal.

**Change:** Give each operation a unique owned staging directory, serialize
conflicting per-beat operations, connect lifecycle cancellation, and verify the
record's identity before publication. Surface progress and errors in the queue.

**Acceptance:** Concurrent re-export, correction, deletion and shutdown cannot
cross-delete another operation's staging file or publish stale metadata silently.
This is a source-level concurrency risk; no destructive reproduction was run.

### P1: Make search behave like a producer's browser

**Evidence:** `LibraryView.tsx` initially ranks MiniSearch hits, then re-sorts the
results by the selected/default ordering, losing relevance. The index includes a
`genre as never` field and no explicit BPM field; the store's status pushes also
replace library snapshots that the index depends on.

**Change:** Add an explicit relevance sort, indexed numeric tempo and normalized
key/Camelot search, optional half/double-time matching, key/analysis-state filters,
and saved view state. Keep explicit newest/title sorting available. Add keyboard
navigation and preserve selected-preview context through filtering.

**Acceptance:** An exact title outranks a weak newer match in relevance mode;
`140` can find a beat whose filename omits tempo; `F#m` and `11A` can resolve the
same musical key; unknown BPM remains distinct from zero.

### P1: Establish an independent real-music DSP benchmark

**Evidence:** `docs/DSP-VERIFICATION.md` reports two unresolved strict exact-key
requirements and deliberately leaves `npm run test:dsp` failing. It reports
**zero** credible independently annotated real-music reference samples. Its
synthetic regressions are useful but do not establish accuracy on downloaded beats.

**Change:** Build a licensed, independently labeled corpus with opaque inputs,
held-out material, genre/sample-rate variation and ambiguous relative-key cases.
Report exact-primary BPM, octave alternatives, exact key, abstention rate and
false positives separately. Preserve the current strict assertions.

**Acceptance:** Results are reproducible without filenames/tags leaking labels
into DSP. Accuracy improvements do not come from relabeling abstentions as correct
or suppressing failing cases. No DSP accuracy improvement is claimed by this PR.

### P2: Profile before choosing a storage or rendering rewrite

**Evidence:** `JsonStore` serializes, backs up, flushes and replaces whole JSON
snapshots synchronously on the main event loop. `LibraryView` rebuilds an index
from the library snapshot and renders grid/list content in the renderer.

**Change:** Profile 1k/10k/50k-record libraries with simultaneous downloads,
analysis and corrections. Add incremental search updates, virtualized rendering,
selective subscriptions and batched status delivery where measurements justify
them. Consider a versioned SQLite migration only with transactional benefits,
verified backups, rollback and a migration test corpus.

**Acceptance:** Record p95 interaction latency, main-loop stalls, memory use and
write amplification. Avoid claiming a database migration is inherently faster
without these measurements.

### P2: Expand the producer workflow after reliability gates

Recommended additions, not implemented here:

- Native local-file/folder import, with a clear imported-versus-Sonic-owned file
  model. Import must not grant Sonic destructive ownership by default.
- Locate-missing-file flow, directory-root reconciliation, and duplicate grouping
  by source identity/content hash rather than filename alone.
- Favorites, tags, crates and saved smart collections; batch metadata review and
  export selections with per-item outcomes and cancellation.
- DAW handoff: reveal/drag export files, audition loops and clear tempo/key transfer
  guidance, without implying filename text automatically changes a DAW's tempo.

The current pipeline should remain one coherent workspace. More visual effects,
a cloud account requirement, or a speculative rewrite are not the next priority.

## Verification performed for this PR

```sh
npm run test:analysis
node --check tests/library-analysis.test.mjs
git diff --check
```

`test:analysis` uses the existing TypeScript development dependency and Node's
built-in test runner. It compiles the checked-in coordinator and shared analysis
helpers, isolates Electron/media/service dependencies, and includes a real
`JsonStore` replacement-failure/retry test using a disposable temporary directory.
It never opens user profiles or audio files or launches media tools.

| Same regression suite | Original coordinator | Changed coordinator |
| --- | ---: | ---: |
| Passing cases | 7 | 23 |
| Failing cases | 16 | 0 |
| Skipped cases | 0 | 0 |
| Process exit | 1 | 0 |

Ten additional runs of the changed suite passed (230/230 test-case executions).
The syntax and whitespace checks passed. These are scheduling, cancellation and
save-acknowledgement tests, not end-to-end acoustic accuracy measurements.

### Verification limits and merge gate

The review environment could read/write the private repository through GitHub,
but could not clone it or install its complete dependency tree over the network.
The tested original source copies were verified against Git blob hashes before
modification. Test execution used Node 22.16.0 and the available TypeScript compiler;
it did not reproduce the complete lockfile-resolved application environment.

Full Node/web project typechecks, production build, Electron/Windows UI tests,
packaged smoke checks and the DSP suite were **not run here**. Before marking this
PR ready, run the focused suite in the installed repository, then the existing
`typecheck`, `build`, `test:services` and Windows interaction/persistence checks.
Review the separately documented DSP failures rather than weakening that gate.
Keep the PR in draft until integration verification is attached.
