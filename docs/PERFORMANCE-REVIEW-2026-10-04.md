# Performance and reliability review — 2026-10-04

Five GPT-6.1 Sol workers at xhigh reviewed and implemented separate areas; a sixth
Sol xhigh agent independently reviewed main-process integration. Changes preserve
the existing interface and use the existing dependencies.

## Changes and evidence

| Area | Improvement | Evidence |
| --- | --- | --- |
| Playback | Bound React playhead updates while retaining exact pause/save positions; cache active-track lookup | Controlled 60 Hz and 120 Hz event streams both produce 10 notifications per second, previously 60 and 120 |
| Playback reliability | Waveform seeks save their position and can resume a finished track; failed decoder construction/setup releases resources | Controller regressions and a real waveform seek/reopen scenario |
| Library search | Reuse the search index when searchable fields have not changed; include numeric BPM in the search box | 29 search/index assertions; final 10k-track status-only fixture averages 1.16 ms to reuse versus 44.77 ms to rebuild over 20 iterations |
| Renderer updates | Retain unchanged library/queue records across IPC snapshots; isolate row rendering | A 100-job queue progress update renders one row; isolated 100-card list/grid fixtures render one row for selection or metadata changes and two for moving playback/inspection |
| Library storage | Cache sorted records and ID lookups per committed revision | Repeated reads perform no additional sorting; tests cover failed writes and storage retry |
| File scans | Share simultaneous rescans and check up to eight files at once, with one filesystem call per record | A 40-record fixture makes exactly 40 stat calls, at most eight concurrently |
| File safety | Preserve records when permission/drive errors prevent a check; purge only confirmed missing paths | Tests cover inaccessible files and edits, moves, removals and additions during a scan |
| Analysis | Check cached results before resolving media tools or measuring duration; bound preparation work by available capacity | Cache-hit fixture makes one content hash and zero tool resolutions or metadata probes; cancellation while waiting starts no extra read |
| Queue | Prevent repeated Start from launching duplicate workers; carry cancellation through metadata/tool setup and analysis | Isolated worker, probe, readback, cancellation and shutdown regressions |
| Editing | Prevent duplicate queue submissions; preserve newly typed links and metadata drafts across background updates; show save failures | Component scenarios cover keyboard/button submission, pending work, failed writes and retry |
| Verification tooling | Track the Electron component launcher; rebuild the application before UI checks; expose the complete unit suite | Fresh checkouts no longer depend on an ignored launcher or stale production output |

The playback figures count controller notifications, not total application CPU
usage. Scan figures count filesystem operations under controlled tests. Index
timings compare a full rebuild with the same code's reuse path, excluding IPC
transport and React rendering. None establishes universal latency or throughput
on every machine. Reproduce the index fixture with
`node tests/library-performance-benchmark.mjs`.

## Verification

| Check | Result |
| --- | --- |
| Node and renderer typechecks, production build | Pass |
| Complete Node suite | 102/102 pass, including the expanded search assertions |
| Services and process/storage capture | 21/21 service checks and 16/16 capture checks pass |
| Offline application smoke | Pass; live-download groups remain outside this run |
| Application GUI | Initial full run: 66/67 pass with no skips; the one shutdown test timing issue was corrected and passes 3/3 targeted repetitions |
| Isolated library list/grid rendering | 2/2 pass; combined with the corrected application scenario, all 69 distinct UI scenarios are verified |
| DSP accuracy | Existing required gate remains 20/22; all 57 additional evidence regressions pass |

The shutdown scenario originally let a single analysis finish during its OS
process snapshot, then asserted that it was still running. The saved result and
normal close were both successful. The test now queues the other three distinct
audio fixtures, retains both active-work assertions and process capture, and
verifies that no active or queued state survives reopening. Only the test changed;
the complete GUI suite was not rerun after this test-only correction.

All application fixtures use isolated profiles and generated audio. Local evidence:
`test-results/improvement-unit.log`, `improvement-typecheck.log`,
`improvement-services.log`, `improvement-capture.log`, `improvement-smoke.log`,
`improvement-ui.json`, `improvement-active-close.json`, `improvement-dsp.json`, and
`improvement-library-benchmark.log` (all under `test-results/`). The separate row
report is `test-results/reports/1791142631725-95396229-d8cc-4445-9aaa-689c95b65291.json`.

## Remaining opportunities, ranked

1. **Improve acoustic key accuracy against independent recordings.** The existing
   synthetic DSP gate still passes 20/22 required cases; two strict key cases
   remain unresolved. This pass does not change the estimator or relax assertions.
   The separate [recording benchmark](DSP-BENCHMARK-2026-09-23.md) documents the
   limitations of the existing real-audio baseline.
2. **Measure and virtualize very large libraries.** Rows still mount for the full
   filtered result set. Profile first-load, scrolling and selection at 1k/10k/50k
   records, then add viewport-based rendering while preserving keyboard range
   selection, inspector context and scroll restoration.
3. **Batch durable import writes.** Each imported file still commits a full JSON
   library snapshot and emits a full IPC snapshot. Any batching must preserve
   acknowledged saves, failed-revision recovery and cancellation semantics.
4. **Reduce repeated audio identity hashing where safe.** Playback hashes files
   on loading to detect external replacement. A future cache needs reliable
   invalidation and changed-file tests before trading that guarantee for speed.

## Reproduce

```powershell
pnpm typecheck
pnpm test:unit
pnpm test:capture
pnpm test:ui
pnpm test:services
pnpm smoke
pnpm test:dsp
```

The final DSP command intentionally remains a failing gate until its two existing
accuracy requirements are met. Live downloads, network engine installation, and
an installed Windows release need their own verification.
