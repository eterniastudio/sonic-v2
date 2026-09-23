# Persistence, shutdown, and analysis verification — 22 September 2026

The 23 September follow-up has fresh source-bound packaged close/reopen evidence in [RELIABILITY-FOLLOWUP-2026-09-23.md](RELIABILITY-FOLLOWUP-2026-09-23.md). This document retains the earlier incident record and its unproven original `ENOENT` cause.

## Evidence categories

**Confirmed defects:** shutdown did not await owned work, completion callbacks could restart scheduling, queue controller ownership was cleared before settlement, asynchronous sidecar read/modify/write updates could lose another revision, and the editor reset discarded the other field's draft. Queue migration also discarded saved manual final values. A failed library publication could lose its retained pending snapshot to a later write from committed state; subsequent writes now cannot do that.

**Historical packaged failure, cause unproven:** PID 32376 threw ENOENT in `renameSync(profile/queue.json.32376.tmp, profile/queue.json)`, from `QueueService.persist` in its debounce timer. Loaded interaction assertions completed, then teardown timed out behind the native uncaught-exception dialog. The surviving evidence is `test-results/packaged/interactions-loaded-analysis-plus-playback-and-picker-input/{trace.zip,error-context.md,diagnostics.json,loaded.json,profile}`. The old app.asar was overwritten by a rebuild before a source manifest was recorded. The shared runner JSON was later overwritten by component runs; it is not available as an immutable historical report.

Neither temporary-file existence nor parent-directory existence was captured at the failing rename. A missing temp and a missing directory both produce ENOENT. No worker or second JsonStore that writes this queue was found. Ordinary JavaScript callbacks cannot interleave inside this synchronous write. Two plausible actors remain: Inspector-induced reentrant `app.quit()` (Playwright's old `app.close()` implementation), and a later test run clearing a still-live app's output/profile directory. Neither actor is proven to have caused this particular historical failure. The new tests label storage fault injection separately; they do not retroactively establish its cause.

The recovered failing paths were `C:\Users\kevin\Desktop\Sonic V2\test-results\packaged\interactions-loaded-analysis-plus-playback-and-picker-input\profile\queue.json.32376.tmp` and the same directory's `queue.json`. Recovered frames identify `Object.renameSync`, old bundled `JsonStore.write` at `out/main/index.js:1345:13`, `QueueService.persist` at `3900:16`, and its timer at `3896:12`. A complete contemporaneous filesystem/process snapshot, intended revision, application-instance UUID, and source-bound native/JavaScript diagnostic were not retained. The new diagnostic format supplies those identities and write-stage observations for future failures.

**Patched and revalidated:** the final-source results and artifact identity are recorded below. Unique filenames alone are not the correctness argument: commits have shared per-path cache/revision state, reentrant writes are rejected, teardown is deferred out of close callbacks, and asynchronous sidecar transactions serialize the complete logical update. The historical ENOENT actor remains unproven; the tested injected mechanisms are explicitly separate evidence.

## Persistence contract

| Store | Acknowledgement and pending state | Restart/recovery |
| --- | --- | --- |
| Settings/library | A successful IPC result follows synchronous replacement. Cache changes only after success. Failed snapshots remain pending; unrelated committed-state writes are rejected until explicit retry, preventing stale snapshots from discarding failed changes. | Primary JSON is authoritative. Malformed/truncated data is copied to an operation-unique damaged file; a validated previous backup is used. Without a valid backup, loading fails explicitly, never silently initializes an empty library. |
| Queue | User mutation IPC flushes before acknowledgement. Progress/stage producers remain debounced. The queue owns the current working snapshot and may replace its own older pending snapshot. | Final ordering and manual overrides survive reload. Active jobs become recoverable; unacknowledged progress may be lost on a crash. |
| Sidecars | Library commits independently, with persisted pending/synced/error output status. Per-path full read/merge/replace uses fresh committed metadata, analysis, provenance and overrides. Retry synchronizes output without rerunning DSP. | A failed optional output does not relabel acoustic success as analysis failure. Persistent feedback survives restart. Audio tags remain unchanged on correction; re-export writes them. |
| Analysis cache/window | Cache is optional: write failure does not invalidate acoustic results. Latest window geometry is an authoritative replaceable snapshot. Storage failures retain diagnostic/retry state. | Engine version `sonic-dsp/2` prevents stale old-DSP cache reuse. Transient library analysis indicators are normalized on restart. |

A write uses an exclusive, operation-owned temp file, flushes its bytes, and atomically renames it; it never deletes the last valid destination to force replacement. A previous validated snapshot is retained in `.backup`. The app does not recreate a directory removed after store initialization. A failed replacement has one automatic attempt and an explicit retry action; there is no unbounded retry loop. Diagnostics record operation stage, file/temp paths, existence checks, process and app-instance identity, attempted/committed revisions, byte count and duration. They go to `profile/persistence.jsonl`, with an OS-temp fallback if the profile is gone.

The guarantee tested is normal-close persistence and recovery of acknowledged commits after intentional process termination. Backup recovery after deliberate primary corruption may restore the **previous** valid revision. No guarantee is made for power loss, storage-controller cache failure, arbitrary external edits, or preserving an uncommitted operation after forced termination. Local diagnostics contain paths and should be reviewed before sharing.

## Shutdown and ownership

The first close request closes admission, stops rescan scheduling, and defers teardown outside the event callback. Repeated requests share one operation. Queue/probe cancellation retains ownership until tasks settle. Analysis cancellation awaits worker termination and scratch cleanup; all owned IPC operations, scans, sidecar writes, and child-process promises settle before final queue/window/storage flush and `app.quit()`.

A 20-second wait limit produces an intentional error explaining that Sonic remains open. It does not force exit or report successful saving. Fixing storage and retrying/closing can continue. Windows `query-session-end` requests this path and the `session-end` callback attempts a bounded synchronous queue flush, but OS logout/forced shutdown behavior has not been exercised and is not equivalent to normal-close evidence.

Test profiles have random identities under `%TEMP%/SonicV2-owned-tests`, outside Playwright's output cleanup. Test logs record actual Electron main PID separately from its Windows shell launcher, process creation identities, descendants, close request, exit and survivors. Profiles are retained. Forced cleanup is recorded as failure; intentional crash simulation is a separate test category. No real library/profile/audio was used.

## Multi-artifact outcomes

Publication exclusively reserves audio and sidecar paths, so a competing export cannot be overwritten. Rollback checks operation-owned file identity. If library commit fails after output is complete, valid exports remain available and the pending library snapshot can be retried. Partial deletion retains its record and reports which artifact was removed; it never describes partially removed files as untouched. This is a recoverable sequence, not a transaction spanning filesystem artifacts.

## Verification

Source SHA-256 manifest: `d220b9d1202a6a6c220794334125f2274de1877992deb3efd4edc579eebe2b84`. This workspace is not a Git repository. `test-results/verified-source-manifest.json` and `verified-package-manifest.json` have identical source hashes. The former includes the old executable only as a pre-build inventory; **the latter identifies the tested package**.

| Artifact | SHA-256 |
| --- | --- |
| `release/win-unpacked/Sonic V2.exe` | `409dd8db24f1b7bba46ad93ab1c5cc848c02f04eb61159a6177079b97e084c59` |
| `release/win-unpacked/resources/app.asar` | `014274f6c3065ec96d0a48376b83115b79b8828cdd8e120dfc5d8cc245e2c6a0` |
| Main bundle | `5e2951f7d5df04d188cfd7ae0ae8d9beae62bf76c844f1b23764247de8385b43` |
| Analysis worker | `3d7ddd3c9b50808d6ed01d8d589674bb2ee1272d5da5f1be799b767a2e9068d2` |

All seven files under packaged `out/`, including renderer, preload and shared analysis chunk, were extracted in memory and matched byte-for-byte against the build: `test-results/verified-packaged-bundles.json`. No older executable was selected from `release/`.

| Final-source check | Result | Evidence in `test-results/` |
| --- | --- | --- |
| Typecheck and build | Pass | `verified-typecheck.log`, `verified-build.log` |
| Process ownership | 7/7 | `verified-ownership.log` |
| Storage/capture regression groups | 16/16 | `verified-capture.log` |
| Service groups, including FLAC tag readback | 13/13 | `verified-services.log` |
| Editor and overlay browser groups | 8/8, zero retries | `verified-components.json` |
| Development offline, CDP | 10/10 consecutive, zero retries | `verified-idle.json` |
| Development loaded, CDP | 3/3 consecutive, zero retries | `verified-loaded.json` |
| Development persistence, CDP | 6/6, zero retries | `verified-development-persistence.json` |
| Windows unpacked package build | Pass | `verified-package.log` |
| Packaged offline / loaded, CDP | 1/1 and 3/3, zero retries | `verified-packaged-offline.json`, `verified-packaged-loaded.json` |
| Packaged persistence, CDP | **6/6, zero retries; all teardown/reopen checks passed** | `verified-packaged-persistence.json` |
| Development window/sweep, Inspector | 2/2 Chromium/control groups pass; 1 Win32 pointer group skipped for foreground denial | `verified-development-window.json` |
| Packaged window/sweep, Inspector | 2/2 Chromium/control groups pass; 1 Win32 pointer group skipped for foreground denial | `verified-packaged-window.json` |
| Legacy isolated development smoke | Pass; seven live-source-dependent groups explicitly skipped; not normal-close proof | `verified-smoke.log`, `smoke-1790066515133/report.json` |
| DSP | **Required 20/22; exit 1**. Historical unchanged annotations 19/22, baseline 15/22. Added regressions 45/45; determinism 4/4. | `verified-dsp.log` |

The six persistence cases include three normal-close/reopen cycles (settings last, correction last, active analysis plus playback), sidecar failure/retry and reopen, deliberate crash/reopen of acknowledged commits, and deliberate truncated-primary recovery. Every reopen is a new actual app process. Repeated close requests are tested three at a time; forced termination is never counted as a normal close. Renderer assertions also inspect queue final metadata and ordering, persisted library overrides, effective sidecar metadata/analysis, and restored state. Seven editor regressions independently cover both reset/draft combinations, untouched fields receiving revisions, a revision arriving during save, partial failure, canonical validation and intentional clearing.

Across these final interaction/persistence/window runs, the lifecycle audit records **56 normal app-process closes, zero failed closes, zero forced cleanup actions, and two separately labeled intentional crash tests**. The final creation-qualified process audit found **zero owned survivors** (`verified-final-process-audit.json`). The final manifest still matches the source and package hashes above (`verified-final-manifest.json`). Profiles retain `restored.json` assertions, store files, sidecars, tool inventories, and lifecycle/commit diagnostics. Packaged execution used restricted PATH and provisioned per-profile FFmpeg/ffprobe whose managed origin/path/version were asserted; no development-workspace codec path was used.

This verifies development Electron and the packaged **unpacked executable**. No installer was created or installed in this pass. Win32 foreground denial leaves final OS-pointer title dragging/edge coverage blocked; Chromium dispatch does not replace it. Observed renderer display scale was 1; other DPI settings and multi-monitor transitions remain untested. Windows logout/session termination is also untested.

CDP launches the runtime directly with a Chromium debugging endpoint, without Node Inspector or Playwright's Electron loader. Inspector remains necessary for main-process window-state assertions and the Win32 pointer test. Direct-launch passes are not evidence that the earlier Inspector-connected access violation is understood or fixed.

Exact reproduction commands are in [INTERACTION-VERIFICATION.md](INTERACTION-VERIFICATION.md#reproduction-from-the-frozen-workspace). The recipe uses ten development offline repetitions and one packaged offline repetition, plus three loaded repetitions and all six persistence cases for each runtime, matching the final matrix. Retries are disabled in `playwright.config.ts`; the recipe retains the failing DSP exit at its end.

## Measured workload and remaining performance limit

The 180-second generated mono 22,050 Hz pulse/chord workload ran preview, one acoustic worker, queue IPC updates up to 20 Hz and four menu open/Escape cycles per run. All 12 measured cycles in each three-run cohort occurred while analysis was active. No workload was disabled or assertion replaced by an arbitrary sleep.

| Measurement | Final development CDP | Final packaged CDP |
| --- | ---: | ---: |
| Menu-cycle range / median | 78.0–143.9 / 98.6 ms | 67.4–274.9 / 109.2 ms |
| Queue updates per run | 19, 18, 20 | 18, 19, 12 |
| Maximum sampled renderer frame interval | 24.9 ms | 24.9 ms |
| Loaded-store commits, median / p95 / maximum | 6.28 / 34.62 / 48.87 ms (72 commits) | 4.19 / 33.55 / 191.97 ms (64 commits) |
| Persistence-suite commits, median / p95 / maximum | 5.65 / 18.92 / 22.57 ms (104 commits) | 3.89 / 29.93 / **1314.90 ms** (104 commits) |

The slowest commit was the first 745-byte settings save in packaged correction cycle 2, PID 2692, profile `488b4551-80a9-4907-9728-73aad25db14b`, at `08:39:18.006Z`. Its acknowledged state survived reopen, but this synchronous-save latency is a real unresolved responsiveness limit. The diagnostic measures whole serialization/backup/flush/replacement time; it does not attribute the outlier to a particular syscall, antivirus, or scheduler. No claim of unchanged tail latency is made. Historical menu timings of 60–116 ms are context, not a controlled performance comparison across identical transport/runtime conditions. Full measurements and profile links are in `verified-evidence-summary.json`.

These are bounded generated-audio measurements, not a universal performance benchmark. Real licensed, independently annotated music sample count is **zero**. See `DSP-VERIFICATION.md` for exact-primary versus alternatives, abstentions, unchanged strict failures, and the corrected periodic-percussion annotation.

## Final-pass first attempts retained

`test-results/final-components.json` passed 8/8 and `final-idle.json` passed 10/10. The first loaded repetition report `final-loaded.json` is **2/3**, not accepted as a clean three-run result: repeat 1 exited with Windows code `0xC0000005` after the diagnostic `shutdown-saved`. Valid queue/library/cache files remained; no owned processes survived. No native stack/dump or upstream diagnosis establishes the cause. All three runs printed the normal Inspector-disconnect message, so that message is not diagnostic proof. A direct-launch/CDP comparison is separate evidence and cannot erase this instrumented failure.

The first six-case final development persistence report is 5/6. The reported survivor in the correction cycle was a **harness ownership bug**, not a Sonic child: Windows reused launcher PID 29176, and an older DiscordSystemHelper process (PID 29132, born more than three hours before the launcher) retained that parent number. Cleanup attempted to terminate it. A fresh check confirmed the same Discord helper remained running. This incident was disclosed during execution. Before testing resumed, ownership was repaired and independently reviewed: creation-time-aware ancestry, exact profile-option anchors, seven deterministic regressions, and termination through a single creation-verified kernel handle replaced recursive tree killing. This is retained as a failed first attempt, not relabeled a pass.
