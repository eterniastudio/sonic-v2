# Safe library recovery — 2026-10-04

This milestone adds **Locate file…** to unavailable-track menus and the inspector,
and **Find missing files…** for unavailable records in the current Library view or
selection. Both open a native picker, produce a read-only review, and use the
same main-process validation and commit implementation. No reimport is required.

## Checkout and reproducible identity

The inspected checkout is `eterniastudio/sonic-v2`, branch
`es/premium-ui-overhaul`, HEAD `b861151b38c22b24bb3db395700de5af97fb52da`.
Existing uncommitted performance and SoundCloud work was preserved. HEAD alone
does not identify the implementation tested here. The repository uses pnpm;
neither dependencies nor either existing lockfile was changed.

Final reproducible source manifest:
`test-results/recovery-final-source-complete.json`.
Source SHA-256: `6e912d02c27555cc8e241d1052d5ab247c4ef01f289cfed6ee37689b4fd63b27`.
The manifest covers source, scripts, tests, package configuration and both existing
lockfiles. It intentionally excludes generated evidence and this document.
Two further service regressions and an opt-in UI performance experiment were
added after packaging; application source and all packaged application bytes
remained unchanged. The earlier manifests are retained separately.

Fresh unpacked package:
`C:\Users\kevin\Desktop\Sonic V2\release\recovery-20261004-2113\win-unpacked\Sonic V2.exe`.
The output directory was new; no user-started instance was closed to free it.

| Artifact | SHA-256 |
| --- | --- |
| Sonic V2.exe | `c5695b7cb022da42281dd7269a7420f3a34a87c12eb01468ddf6c682553f866b` |
| resources/app.asar | `81f6f6600a57fee7dab077b2ef950825a572baf5b293de5ea374f37248179feb` |
| out/main/index.js | `39cd66a75ec052be71d26ddad1e254a3b62c040361d067cc5ee211cb700b3285` |

All 15 application files extracted from app.asar match the current production
output byte-for-byte (`test-results/recovery-artifact-identity.json`). This is
unpacked packaged execution; installer creation and installed-app execution
are not claimed.

## Recovery contract

The main process owns picker paths and plans. Renderer requests carry a library
ID or an owner-scoped plan/candidate ID, never a proposed filesystem path. Runtime
argument checks, trusted-sender checks and operation shutdown coordination apply.
Returned reviews are detached snapshots; changing one cannot authorize a path.

Verification reads the complete file through SHA-256. Names, relative paths and
saved sizes only prioritize or narrow candidates. A stable opened file and the
path naming it are checked before and after hashing. Missing identity, wrong
bytes, access failures, incomplete scans and multiple identical locations are
reported separately. Multiple matches start excluded and require a location
choice. Incomplete scans also require explicit selection of any verified matches.

Folder recovery checks likely relative paths and basenames, then visits approved
descendants with size filtering. Directory iteration is streamed, links are
rejected, and canonical paths must remain within the picked root. Limits are
10,000 requested records, 25,000 entries, depth 12, 20 candidates per record,
two concurrent verifications, 2 GiB per file, 8 GiB of candidate audio per scan,
ten minutes per scan and two minutes per file. Reaching a limit leaves an
explicitly incomplete review. No unrelated drives are searched. Library rescans
retain permission failures and unavailable roots as access errors; purge does
not treat an offline root as proof of deletion.

Apply reserves affected records through the existing mutation coordination,
drains related sidecar tasks, rehashes chosen files and checks record identity,
location and ownership again. An identical-byte replacement at a different
physical file is rejected as a stale candidate. Metadata edits remain fresh:
the commit patches locations into the current records, not a scan-time library
snapshot. Removed records cannot be resurrected. Duplicate submission shares
the in-flight operation. Location conflicts are rejected.

The valid subset is saved as **one coherent library revision**. Invalid selected
entries retain their old records and show their own errors. Success is reported
only after a committed save. Failed replacement retains the previous committed
library and a pending revision. The existing Retry saving route revalidates the
files again before committing that revision. If a file changed while pending,
retry fails and the review can be cancelled and started again. Unrelated writes
cannot overwrite an unresolved pending library revision.

Cancel waits for all hash workers and applies no pending paths. Cancelling a
completed commit reports its committed result. Normal shutdown aborts scans and
uncommitted apply/retry work, drains it, and abandons pending recovery paths while
keeping the last acknowledged library snapshot. The underlying storage error
remains retryable. No recovery callback may commit after shutdown begins. Normal
close can still report an unresolved disk error rather than claim it saved.

## Identity, ownership, sidecars and listening

Recovery preserves IDs, source kind and backlink, artwork, title and producer,
overrides and evidence, analysis, annotations, collection membership and saved
positions. It does not write, rename, move or delete audio or sidecars, and does
not launch acoustic analysis. Existing collection, correction and export paths
continue to operate on those same IDs.

Content identity does not grant file ownership. Imported originals stay external
and read-only. Newly published Sonic exports save a physical ownership receipt
(device, file ID and creation timestamp). A moved export retains ownership only
when its saved receipt still identifies the verified audio. Copies, legacy
exports without receipts, cross-volume moves and unsupported physical IDs fail
closed to read-only recovery. Source kind stays YouTube/SoundCloud/local even if
file ownership becomes external. Existing rename/delete paths recheck available
ownership receipts before modifying recovered files.

Sidecars are independent. Adoption requires retained audio ownership, a saved
sidecar physical receipt and ID, matching content fingerprint, filename and
source association within the chosen root. A merely neighboring JSON file is
insufficient. Missing, malformed, replaced or unrelated sidecars leave saved
library corrections and analysis intact; recovery clears obsolete sidecar paths
and reports the unresolved sidecar. Valid adopted sidecars use the existing
pending/sync/retry contract. Receipt checks also protect subsequent sidecar
rename, deletion and synchronization.

Recovery progress lives in component-local state and never emits library
snapshots. Reviews paginate at 50 records. Committed changes use the existing
snapshot sharing and search-index reuse. Search, filters, sort and inspection
follow the existing Library workspace rules, including pruning selections that
leave the Missing filter after recovery.

The sole playback controller keeps the captured queue and content position when
an active file becomes unavailable. A repaired path releases stale path-dependent
decoder state without starting playback. The next explicit Play reloads the
repaired path and its valid saved position. Recovering another record leaves
unrelated playing audio and queue order alone.

## Verification evidence

The pre-change baseline, captured before implementation, is preserved in
`test-results/recovery-baseline/`. It passed typecheck/build, 114 unit tests,
26 analysis, 16 capture/storage and 21 service checks. Strict DSP remained 20/22;
57 additional evidence checks and four determinism checks passed. No pre-change
full UI run is claimed. Existing implementations and reports confirmed local
import, collections, persistent playback, workspace continuity and SoundCloud
support; no competing relink implementation existed.

| Final-source check | Result / evidence |
| --- | --- |
| Node and renderer typecheck | Pass; `recovery-typecheck-fifth.log` |
| Production build | Pass; `recovery-final-build.log`, also rebuilt by final UI command |
| Complete unit suite | 149/149 pass; `recovery-final-unit-second.log`; earlier 147/147 run retained |
| Recovery service subset | 32/32 pass, included in unit total; `recovery-service-rerun2.log` |
| Analysis | 26/26 pass; `recovery-final-analysis.log` |
| Capture/storage | 16/16 pass; `recovery-final-capture.log` |
| Services | 21/21 pass; `recovery-final-services.log` |
| Full development application suite | 81 pass / 1 native-pointer skip / 0 failures, zero retries, 11.8 min; `recovery-final-development.json` |
| Exact unpacked executable, selected application suite | 59 pass / 1 native-pointer skip / 0 failures, zero retries, 8.8 min; `recovery-final-packaged.json` |
| Strict DSP | 20/22 required; unchanged A-minor/G-minor key failures; `recovery-final-dsp.log` |
| Additional DSP evidence / determinism | 57/57 and 4/4; no relaxed assertions |
| Additional 10,000-record UI experiment | Blocked before readiness on three launches; no browser responsiveness result claimed |

All log/report paths in this table are under `test-results/`. The development
report is one complete 82-case run, including SoundCloud intake, search and
affected-row rendering checks. The packaged report is one selected 60-case run
against the executable above, covering recovery, import, collections, workspace,
playback, persistence, interaction and theme checks. Each includes 12/12 passing
recovery cases. These reports are not aggregated into a fictitious clean suite.

`recovery-integrated-summary.json` records 95 development and 89 packaged normal
process closes, zero failed closes, zero forced cleanup and zero verified owned
survivors. One intentional crash simulation per run is counted separately. The
only skip in each run was the Win32 pointer case: Windows refused foreground
input. Chromium pointer and window-control cases passed; they do not establish
native Windows pointer behavior.

Recovery interaction
tests use real UI buttons, review, choices, apply, cancellation and feedback with
the real IPC handlers. Only the native picker's returned test-owned selection is
stubbed. They exercise same-profile normal close/reopen, mixed source folders,
wrong content, ambiguity, changed/disappeared candidates, failed-save retry,
concurrent edits/removal, unresolved sidecars, read-only legacy/import ownership,
unrelated advancing playback and explicit position resume. Deterministic service
barriers cover scan/apply/retry cancellation and close races without sleep-based
timing assumptions. All damaged files and failures are isolated fixtures.

Both 1024 × 680 theme checks pass with 24 long-title/path results; header, footer,
Cancel and Reconnect stay visible while results scroll. The two screenshots in
`recovery-suite-first-20261004-210624/` were visually inspected with no layout
issues found. Keyboard focus, Escape and announcements reuse the existing modal
and native control behavior. Native Windows pointer results are reported
separately from Chromium interaction checks.

First attempts remain distinct. `recovery-first-unit.log` exposed the new identity
module missing from an isolated test loader. `recovery-service-first.log` and the
first performance attempt exposed cancellation returning before all workers
settled and a retry crossing shutdown; these application defects were fixed.
Two focused single-file UI attempts had incorrect test assumptions about library
ordering and intentional search-sort changes. The first complete recovery UI run
was 11/12; its playback assertion captured an old timestamp before a normal track
switch. After correcting that capture, the focused case passed. None of those
runs is relabeled a clean full-suite pass. The artifact checker's initial Windows
separator error is recorded in `recovery-artifact-first-attempt.txt`.

## Performance measurements and practical limits

`node tests/recovery-performance.mjs` loads the actual recovery, identity and
search sources, with real file I/O and SHA-256 and an in-memory library boundary.
The fixture has 10,000 saved unavailable records, 24 real moved/renamed 8 MiB
files and 512 unrelated-size files. Evidence is in
`test-results/recovery-performance/run-1791162659421/`.

| Measurement | 24 selected | 10,000 selected |
| --- | --- | --- |
| Scan completion observed by polling | 378 ms | 3,824 ms |
| Synchronous plan creation | 1.6 ms | 93.6 ms |
| Same search sequence p95, before / during / after | 7.11 / 10.47 / 9.48 ms | 9.43 / 9.49 / 9.59 ms |
| Maximum callback delay while scanning | 10.7 ms | 183 ms |
| Maximum scanning snapshot size | 428 bytes | 432 bytes |
| Final review clone / serialized size | 0.29 ms / 13 KB | 17.3 ms / 2.54 MB |

Both scans visited 538 entries, hashed exactly 24 files / 192 MiB, skipped hashing
all 512 unrelated-size files, and used at most two workers. Cancellation after a
real 256 KiB hash chunk settled in 1.388 ms with zero active workers or later
hashes. Preview/cancel left the fixture library unchanged. A separate repeated
search-index workload measured 10,000-record rebuild/reuse at 50.77/1.17 ms; the
previous same-workload report measured 44.77/1.16 ms. These shared-machine figures
preserve the reuse benefit but do not establish universal latency.

Before/during/after means paired identical activity around a current scan, not a
historical recovery speedup; the baseline had no recovery service. The service
experiment measures no Electron IPC, React rendering or audio playback. Startup
and final-review costs remain visible. Real UI playback and interaction checks
are separate evidence, and full-library rendering is still not virtualized.

An additional opt-in real-application experiment prepares a 10,000-record profile
with a saved 25-record shortlist and 24 actual candidate files. Three launches
failed at the existing inspector harness's main-process-ID evaluation with
“Resulting promise was garbage collected,” before readiness or any interaction
assertion. The third attempt ran after the other test instances had closed, so
concurrency alone does not explain it. Attempts stopped there. The doubtful
assumption is reliable inspector initialization of this generated profile; the
root cause remains unproven. No 10,000-record browser timing is claimed.

The experiment is `tests/recovery-ui-benchmark.mjs`, with an explicit benchmark
configuration separate from the 82-case correctness suite. Its launch failures
are preserved in `recovery-performance-ui.json`, `-second.json` and `-third.json`,
with scope in `recovery-performance/UI-LIMITATION.md`. Keeping the experiment
separate does not turn those failures into passes. The 10,000-record service
measurement, actual smaller-library UI checks and blocked large-profile UI
measurement are three different pieces of evidence.

## Exact reproduction

From `C:\Users\kevin\Desktop\Sonic V2` in PowerShell:

```powershell
pnpm typecheck
pnpm test:unit
pnpm test:capture
pnpm test:services
pnpm test:analysis
pnpm test:dsp # Intentionally still exits nonzero: two unchanged strict failures.
node tests/recovery-performance.mjs
node tests/library-performance-benchmark.mjs
# Separate UI experiment; currently blocked at inspector launch:
pnpm exec playwright test --config tests/recovery-ui-benchmark.config.mjs

$env:SONIC_TEST_RUN_ID='recovery-final-development-20261004'
$env:SONIC_TEST_REPORT='test-results/recovery-final-development.json'
Remove-Item Env:SONIC_PACKAGED_EXE -ErrorAction SilentlyContinue
pnpm test:ui

pnpm exec electron-builder --win --dir --config.directories.output=release/recovery-20261004-2113 --publish never
node test-results/recovery-artifact-check.cjs
$env:SONIC_PACKAGED_EXE=(Resolve-Path 'release/recovery-20261004-2113/win-unpacked/Sonic V2.exe').Path
$env:SONIC_TEST_RUN_ID='recovery-final-packaged-20261004'
$env:SONIC_TEST_REPORT='test-results/recovery-final-packaged.json'
pnpm exec playwright test tests/recovery.spec.mjs tests/local-import.spec.mjs tests/collections.spec.mjs tests/library-workspace.spec.mjs tests/playback.spec.mjs tests/persistence.spec.mjs tests/ui-redesign.spec.mjs tests/interactions.spec.mjs
node scripts/source-manifest.mjs test-results/recovery-final-source-complete.json release/recovery-20261004-2113/win-unpacked
```

Those are the recorded run names; use fresh run IDs, report paths and package
directories when reproducing so first-attempt evidence is not overwritten.
Profiles retain their ownership receipts. Cleanup compares process creation
identity and never terminates by application name or a broad process tree.
Network-dependent downloading remains separate from required offline recovery;
no YouTube or SoundCloud connection is needed to reconnect known audio.
