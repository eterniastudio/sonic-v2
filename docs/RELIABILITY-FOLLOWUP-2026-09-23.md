# Sonic V2 reliability follow-up — 23 September 2026

PR #1 (`8c646f3`) was independently checked and then merged into `main` as `9efec8d`. This follow-up was built from production-source commit `c53f247fb45e37df9ca81b476aa72115e5a76173` on `work/sonic-reliability-2026-09-23`. A later **test-only** change in `tests/interactions.spec.mjs` updated the expected search sort from Newest to Relevance. It did not change the application code or the packaged executable.

## Implemented behavior

The analysis coordinator now commits a batch's queued statuses in one library revision. A failed replacement keeps the batch gated until the pending revision is retried; cancellation and normal close restore queued statuses before reporting a completed save. One request deadline covers engine resolution, probing, hashing, capacity wait, decoding, and worker analysis. Cancelled capacity waiters are removed, and shutdown awaits owned work.

Re-export gives each operation an owned staging directory, serializes conflicting requests for one beat, checks source identity and metadata before publication, and aborts active work during shutdown. Metadata correction edits only touched fields, preserves the other draft across a reset, distinguishes evidence-priority reset from choosing the acoustic estimate, and shows library, sidecar, and audio-tag status. IPC validates the sender and payloads and resolves file actions from saved beat/job IDs. Library search has explicit Relevance sorting and musical filters.

The original packaged queue `ENOENT` actor remains **unproven**. Earlier investigation did not capture whether its temporary file and parent directory existed at the failure instant or whether another process/test removed them. Unique operation-owned temporary files, retained pending revisions, bounded retry, and shutdown tests establish resilience; injected failures do not reproduce that historical `ENOENT` cause.

## Final-source evidence

Application source manifest before and after packaging: `82aaa79130323d732dd6feb3ff046ecac5cde7d9b04baa89bf7423c291674799`. After the test-only selector correction, the complete source/test manifest is `9934eca6c925d566e26d376f7a0b508e4f79a17618322be3ec47f65ab0f3c0d4`.

| Check | Result |
|---|---|
| Typecheck and Electron/Vite build | Pass |
| Analysis coordinator regressions | 26/26 pass |
| Service regressions | 21/21 pass |
| Search helper and editor interaction regressions | 11/11 and 5/5 pass |
| Development offline and loaded interactions | 10/10 and 3/3 pass, zero retries |
| Development persistence | 6/6 pass |
| Fresh unpacked package offline and loaded interactions | 1/1 and 3/3 pass, zero retries |
| Fresh unpacked package persistence | 6/6 pass: three normal close/reopen cycles including active analysis, sidecar failure/retry/reopen, forced-termination recovery of acknowledged commits, and damaged-library backup recovery |
| Packaged theme/channel context interactions | 2/2 pass |
| Offline IPC boundary smoke | Pass: malformed settings patch, arbitrary path channel, and unknown event rejected; settings unchanged |
| Native Windows input with Inspector transport | Window controls and OS-pointer hit testing pass; bounded sweep passes 3/3 after the test-only sort assertion correction |
| Required DSP cases | **20/22**; exit code 1. Two relative-key cases abstain with plausible alternatives; no independently labeled real-music reference sample was available |

The supplemental native-control group first ran with CDP, which cannot provide the test's `app.evaluate` main-process API: 2 passed, 3 failed. A correct Inspector run then passed window controls and OS-pointer input but failed the bounded sweep's stale `Newest first` selector. After that one-line test correction, its Inspector rerun passed 3/3. These first attempts remain in the evidence directory; they are not recast as zero-retry native acceptance. Native input was exercised on the available display configuration, not every DPI scale. Installer creation and installed-app execution were not performed. The smoke run's fixture-dependent renderer IPC/pipeline/media groups were skipped.

The tested **unpacked** executable is `test-results/final-20260923-021951/package/win-unpacked/Sonic V2.exe`, SHA-256 `50970E12549A813787413FE607C1D13FDB8465FBB499CC6708F2159EF0BA1F16`; its `resources/app.asar` SHA-256 is `336EAFB697C6CFC42C6037D76A59E876E4F10804BE06B18A7B88D3B3BC2C0CD0`. The `release/win-unpacked` directory was not used as proof of this build. JSON reports, console logs, source manifests, and package hashes are under `test-results/final-20260923-021951/`. Test profiles were isolated and retained for diagnosis.

## Reproduce

From this repository on Windows with the checked-in lockfile and local generated fixtures:

```powershell
npm ci
npm run typecheck
npm run test:analysis
npm run build
npm run test:services
node tests/library-search.test.mjs
npx playwright test tests/editor-corrections.spec.mjs --workers=1
$env:SONIC_TEST_TRANSPORT = 'cdp'
npx playwright test tests/interactions.spec.mjs --grep 'offline pointer' --repeat-each=10
npx playwright test tests/interactions.spec.mjs --grep 'loaded analysis' --repeat-each=3
npx playwright test tests/persistence.spec.mjs
$packageDir = Join-Path (Get-Location) ('test-results/package-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
npx electron-builder --win --dir "--config.directories.output=$packageDir"
$env:SONIC_PACKAGED_EXE = Join-Path $packageDir 'win-unpacked/Sonic V2.exe'
npx playwright test tests/interactions.spec.mjs --grep 'offline pointer'
npx playwright test tests/interactions.spec.mjs --grep 'loaded analysis' --repeat-each=3
npx playwright test tests/persistence.spec.mjs
Remove-Item Env:SONIC_TEST_TRANSPORT
npx playwright test tests/interactions.spec.mjs --grep 'native window controls|Windows OS pointer|bounded offline control sweep'
Remove-Item Env:SONIC_PACKAGED_EXE
node scripts/run-smoke.mjs
npm run test:dsp # expected nonzero until the two strict key requirements are resolved
```

The native command requires Electron Inspector, unlike the CDP commands. `playwright.config.ts` sets one worker and zero retries; `SONIC_TEST_REPORT` can direct each JSON report to a unique path. Keep first-attempt reports when rerunning a failed group.

The existing generated-audio workload and menu-cycle assertions are bounded responsiveness checks, not a universal performance benchmark. No new 1,000/10,000/50,000-record scalability measurements were completed in this follow-up.
