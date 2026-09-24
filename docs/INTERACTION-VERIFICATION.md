# Sonic V2 interaction verification — 22 September 2026

**23 September persistent auditioning:** The shell-owned playback runtime, saved listening position, fresh unpacked Windows build, close/reopen results, and current test limits are recorded in [PLAYBACK-VERIFICATION-2026-09-23.md](PLAYBACK-VERIFICATION-2026-09-23.md). The counts below describe earlier builds unless explicitly labeled otherwise.

**23 September follow-up:** PR #1 is merged into `main`. The subsequent analysis lifecycle, metadata, IPC, search, and re-export changes were verified on branch `work/sonic-reliability-2026-09-23`; see [RELIABILITY-FOLLOWUP-2026-09-23.md](RELIABILITY-FOLLOWUP-2026-09-23.md) for the new source manifest, fresh unpacked executable, first-attempt failures, and close/reopen results. Counts and artifact hashes below describe the earlier September 22 builds.

This persistence pass preserved the tested interface and targeted saving, shutdown, and acoustic correctness. Its source manifest is `d220b9d1202a6a6c220794334125f2274de1877992deb3efd4edc579eebe2b84`. Development CDP runs passed **10/10 offline, 3/3 loaded, and 6/6 persistence**. Its unpacked executable passed **1/1 offline, 3/3 loaded, and 6/6 persistence**, including same-profile reopen. All had zero retries and successful required shutdowns. Final native OS-pointer tests were blocked, two strict DSP cases remained failing, and a slow save remained a performance limitation. This workspace has no Git repository; manifests identify source and artifact hashes.

A later Theme selector change uses the Settings Magnet Tabs spring/hover indicator with compact pill styling and radio keyboard semantics. Its source manifest is `255c8102d490ef4466bd362e93bcf70290850598aa2859ad3a16d752756ab4e8`. Typecheck and build passed; the focused development Theme plus offline tests passed 2/2, and the focused packaged Theme test passed 1/1, all with zero retries and clean shutdown. The current test artifact is `release/theme-magnet/win-unpacked/Sonic V2.exe` (SHA-256 `e48eaa827990bce604e84b109b3e1b0433f487036d92597a5fd43a544ecb798a`); its archive is `62f67ddf55b8c70298b63f7287ca023f77e0060670a941a95da5ab0906165215`. Seven packaged bundles match the current build byte-for-byte (`test-results/theme-magnet-artifact.json`). The ordinary `release/win-unpacked` directory was locked by a running user-profile Sonic instance, so it was left intact. The broader persistence/DSP results below belong to the earlier source manifest; this UI-only follow-up did not repeat those entire suites.

The persistence contracts, original ENOENT investigation, incidents, and final artifact identity belong in [PERSISTENCE-ANALYSIS-VERIFICATION.md](PERSISTENCE-ANALYSIS-VERIFICATION.md). Acoustic measurements and unresolved requirements are in [DSP-VERIFICATION.md](DSP-VERIFICATION.md).

## Preserved interaction behavior

| Area | Implemented behavior and verification scope |
|---|---|
| Pickers and overlays | Portaled dropdowns/tooltips, viewport placement and scrolling, shared ordered Escape/outside dismissal, modal focus trapping/restoration, keyboard navigation, and inert closing content. Original clipping was reproduced using pointer events and `elementFromPoint`; evidence remains in `test-results/baseline/`. |
| Confirmations and settings | Awaited operations, pending locks, visible errors, stable deletion targets and integrity checks; settings success follows persistence. Clipboard reads use typed IPC. Completed/processing job formats remain locked independently of the default format. |
| Preview and correction | Playback survives theme changes; accessible seek/volume remain. Correction tracks edited fields separately, preserves unrelated drafts during reset, accepts fresh untouched fields, and derives canonical key/Camelot. Audio-tag rewriting remains visibly disabled; re-export is supported. |
| Circle Menu and Magnet Tabs | Existing visual design retained with shared dismissal, keyboard operation, effective motion preference, roving tab focus, panel associations, measured indicators, and persisted active section. |
| Queue, analysis, and window controls | Pending-analysis splice repair retained; queue manual final values now survive migration/reopen. Chromium pointer assertions and Win32 pointer tests remain distinct. Title controls retain the resized geometry below the native resize strip. |

## Persistence coverage

Stores commit caches after successful replacement, retain failed pending revisions, protect them from later stale writes, use owned temporary files, and preserve diagnostics and validated recovery data. Queue command acknowledgement includes persistence; background progress has a separate debounced contract. Normal shutdown closes admission, stops scheduling, settles owned work, completes final writes, and then quits. Repeated close requests share that sequence. Storage failure has an intentional retry path.

The library is authoritative for corrections and analysis. Sidecar synchronization serializes the entire logical update, carries fresh metadata/analysis/provenance/overrides, and records pending/error/synced status independently. Retry does not rerun acoustic analysis. Publication uses exclusive creation and ownership-checked cleanup; incomplete deletion identifies artifacts actually removed. The focused report defines the normal-close and crash-recovery boundaries without claiming untested power-loss guarantees.

Tests reopen the actual app against the same isolated profile and inspect restored settings, library, queue, and sidecars. Service tests read actual FLAC tags. Controlled barriers exercise concurrent correction/analysis; invalid destinations exercise failure and retry. These injected failures do not establish the original packaged ENOENT actor.

Readiness is workflow-specific: selected record, loaded preview decoder, visible menu, acknowledged save, completed analysis, or settled shutdown. Finding `main` and `window.sonic` is only a boot check. A passing test includes teardown; forced cleanup is a recorded failure.

## Evidence ledger

| Evidence | Result and limit |
|---|---|
| Earlier interaction acceptance | Historical offline **10/10** and loaded **3/3**, zero retries. These predate persistence changes and do not establish final-build acceptance. |
| Original packaged failure | Loaded assertions completed, then queue temporary-file rename threw ENOENT and a native exception dialog blocked close. Exact cause remains unproven; the old package lacked an immutable source manifest. |
| First final-pass component/offline runs | `test-results/final-components.json`: **8/8**; `final-idle.json`: **10/10**. These are retained first-attempt results; the final transport/package matrix is separate. |
| First final-pass loaded/persistence runs | `final-loaded.json`: **2/3**, including unexplained native exit `0xC0000005` after `shutdown-saved`. First development persistence: **5/6**, including PID-reuse false ownership of an older Discord helper. Cleanup attempted to terminate that unrelated process; a fresh check confirmed the same helper remained alive. Both failures remain recorded; see the focused report. |
| DSP cohort | **15/22 → 19/22** under unchanged historical annotations; **20/22** after the documented periodic-percussion annotation correction. Two strict exact-key requirements still fail. `npm run test:dsp` exits **1**; this is not full accuracy acceptance. |
| Final source and packaged checks | `verified-*` reports: typecheck/build/package pass; 16 storage/capture, 13 service, 7 ownership and 8 editor/overlay groups pass. Development and packaged repetition/persistence counts appear above. The focused report records executable/archive hashes, readback evidence and all commands. |
| Final lifecycle and native results | **56 normal process closes**, zero failed closes/forced cleanup and zero verified owned survivors; two intentional crash tests recorded separately. Chromium window/control groups pass in development and package; each Win32 pointer group is skipped specifically for foreground denial. Installer creation/execution was not tested. |

The ownership defect is repaired with creation-time-aware ancestry, exact profile anchors, and identity verification on the same kernel handle used for termination. There is no recursive tree killing. UUID profiles live outside Playwright output cleanup and are retained with failed diagnostics. Seven pure ownership regressions cover reused PIDs, stale identities, invalid anchors, and cleanup ordering.

The native access violation is not explained by the Inspector-disconnect message: successful runs printed it too. Direct-launch Chromium CDP comparison is separately labeled evidence and cannot erase the instrumented failure.

## Reproduction from the frozen workspace

Use the existing `package-lock.json` dependency set and keep source unchanged between development and package runs. Set `SONIC_TEST_REPORT` for each invocation so its JSON evidence has an explicit destination; do not copy a stale shared report. Required failures retain nonzero exit codes. The DSP failure is captured explicitly and remains a failed acceptance item.

```powershell
$run = Join-Path 'test-results' ('verify-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $run | Out-Null
function Require-Pass([scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "Required command failed with exit $LASTEXITCODE" }
}
function Run-Ui([string]$label, [scriptblock]$command) {
  $env:SONIC_TEST_REPORT = (Join-Path $run "$label.json")
  & $command
  $code = $LASTEXITCODE
  Remove-Item Env:SONIC_TEST_REPORT
  if ($code -ne 0) { throw "$label failed with exit $code" }
}
node scripts/source-manifest.mjs "$run/source-before.json"
Require-Pass { npm run typecheck }
Require-Pass { npm run test:capture }
Require-Pass { node --test tests/process-ownership.test.mjs }
$env:SONIC_DSP_REPORT = "$run/dsp.json"
npm run test:dsp *> "$run/dsp.log"
$dspExit = $LASTEXITCODE
Set-Content "$run/dsp-exit.txt" $dspExit
Remove-Item Env:SONIC_DSP_REPORT

# Service regressions load the built analysis worker from this source.
Require-Pass { npm run build }
Require-Pass { npm run test:services }
Require-Pass { node scripts/build-component-harness.mjs }
Remove-Item Env:SONIC_TEST_TRANSPORT, Env:SONIC_PACKAGED_EXE -ErrorAction SilentlyContinue
Run-Ui 'components' { npx playwright test tests/components.spec.mjs --output="$run/components" }

foreach ($target in @('development', 'packaged-unpacked')) {
  if ($target -eq 'packaged-unpacked') {
    Require-Pass { npm run package }
    $env:SONIC_PACKAGED_EXE = (Resolve-Path 'release/win-unpacked/Sonic V2.exe').Path
    node scripts/source-manifest.mjs "$run/package-manifest.json"
  }
  $env:SONIC_TEST_TRANSPORT = 'cdp'
  $offlineRepeats = if ($target -eq 'development') { 10 } else { 1 }
  Run-Ui "$target-offline" { npx playwright test tests/interactions.spec.mjs --grep 'offline pointer' --repeat-each=$offlineRepeats --output="$run/$target-offline" }
  Run-Ui "$target-loaded" { npx playwright test tests/interactions.spec.mjs --grep 'loaded analysis' --repeat-each=3 --output="$run/$target-loaded" }
  Run-Ui "$target-persistence" { npx playwright test tests/persistence.spec.mjs --output="$run/$target-persistence" }
  Remove-Item Env:SONIC_TEST_TRANSPORT
  Run-Ui "$target-window-and-sweep" { npx playwright test tests/interactions.spec.mjs --grep 'native window controls|Windows OS pointer|bounded offline control sweep' --output="$run/$target-window-and-sweep" }
}
Remove-Item Env:SONIC_PACKAGED_EXE -ErrorAction SilentlyContinue
Require-Pass { node scripts/run-smoke.mjs }
node scripts/source-manifest.mjs "$run/source-after.json"
if ($dspExit -ne 0) { throw "DSP required cases remain failing (exit $dspExit); inspect $run/dsp.log" }
```

Compare before/package/after `sourceHash`; retain executable and `app.asar` hashes. Review normal-close records, final stored revisions, restored assertions, and required skips before acceptance. The persistence suite includes three normal-close/reopen cycles, sidecar failure/retry, deliberate forced termination, and damaged-library recovery. Retries remain disabled.

`SONIC_TEST_TRANSPORT=cdp` directly launches the runtime and attaches to Chromium without Node Inspector or Playwright's Electron loader. Offline, loaded, and persistence groups use this transport. Window-state and Win32 pointer/sweep groups retain Electron Inspector for their main-process APIs. Report these launch conditions separately.

## Scope and remaining limits

The library context regression is `npx playwright test tests/interactions.spec.mjs --grep 'library context menu'`. It seeds only an isolated test profile, right-clicks a beat, verifies saved channel and backlink availability, renames the physical audio file, then closes and reopens the app against the same profile. `npm run test:services` also checks channel preference over uploader and a BPM/key filename correction against the persisted library path. Opening the external browser is intentionally not part of the offline test; source-link validation runs in main-process IPC.

- Development Electron, the packaged **unpacked executable**, installer creation, and installed-app execution are distinct. `npm run package` uses `--win --dir`; installer creation and installed-app execution remain unverified unless separately documented.
- Fixtures use generated local audio, restricted PATH, and explicitly copied per-profile managed FFmpeg/ffprobe binaries. Their paths and versions are asserted. This verifies local analysis using provisioned tools, not bundled installer delivery or network installation.
- Win32 pointer tests report foreground denial as a specific skip. Historical packaged Win32 testing passed when foreground became available. Neither that run nor Chromium coverage proves all display scales, monitors, or final native hit regions.
- The loaded workload uses 180 seconds of mono 22,050 Hz generated pulse/chord audio, playback, one analysis worker, queue updates up to 20Hz, and four menu cycles. Final development cycles were 78–144ms; packaged cycles 67–275ms; maximum sampled frame interval was 24.9ms in each cohort. One packaged settings commit took **1.31 seconds**, an unresolved synchronous-save latency outlier. See the focused report and `verified-evidence-summary.json`; no unchanged-latency claim is made. The active-close fixture uses 600 seconds of generated audio. Neither workload is a universal performance benchmark.
- Exact-primary accuracy remains 8/10 tempo and 4/6 key on the original positive cohorts; supported alternatives and two relative-key abstentions are separate outcomes. True original tempo-negative false positives fell to 0/5; 45 added evidence regressions pass. Independently annotated real-music sample count is **0**. Live acquisition and external file associations remain outside these offline results.
