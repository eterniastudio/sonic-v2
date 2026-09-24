# Persistent auditioning — implementation and verification

This branch starts at `origin/main` commit `01b4f31c8d89bbb064a4879a76b2cb796bc9266a` (merged collections PR #5). It moves audition playback out of the keyed Library view into one application-shell owner. It does not change the DSP, import ownership, export recipes, or library database.

## Listening contract

`PlaybackProvider` owns one WaveSurfer decoder and mounts outside the view that changes when Library, Downloads, or Settings opens. The Library inspector still owns metadata editing and inspection, but never creates audio. A card, inspector, context menu, collection toolbar, selected-count toolbar, and command palette send explicit Play commands to that same owner. A dock stays visible across navigation. Beat inspection, keyboard focus, batch selection, active audio, and the audition queue are separate identities.

Play one starts one track. Play displayed results and Play selected copy stable beat IDs in displayed order at the instant the command starts; later sorting, filtering, annotation, and smart-collection changes cannot rewrite the queue. Next scans forward at most the captured queue length and skips missing/unreadable entries with feedback. Previous restarts the current track after 3 seconds; near the start it scans backward. Manual navigation retains a paused state. Natural completion advances a multi-track queue, except explicit track-repeat takes priority. The final entry ends without wrapping. A removed current record releases its decoder; deleting a collection alone does not remove the captured beat IDs or audio.

Each track load has a generation. Stale ready, error, time, finish, play-promise, or identity replies cannot control a newer track. Pause or Stop during loading removes pending autoplay. A late finish after a user Pause cannot restart or advance playback. The existing `sonic-media://beat/<id>` boundary still resolves local paths in main; the renderer never receives an arbitrary playback path. The existing WebAudio backend is unchanged.

## Saved-session contract

`playback-session.json` is a separate, versioned, validated `JsonStore`. It records last active beat ID, volume, and at most 128 recent positions. A position carries stable beat ID plus SHA-256 of the **current file bytes**, not only the immutable acquisition fingerprint in the Library record. Main hashes the ID-resolved file before each new load and rejects a file that changes while being checked. An owned-file rename with unchanged bytes keeps its position; changed bytes invalidate it. The extra hash is asynchronous but may delay initial playback of a large file by up to the 15-second read bound; no large-library latency benchmark is claimed here.

A successful `playback:checkpoint` IPC acknowledgement means the snapshot was synchronously serialized, flushed, and atomically replaced by `JsonStore`. Volume and active-track changes enqueue checkpoints immediately; seek, pause, stop, track switch, and a bounded 20-second playback interval checkpoint position. Renderer checkpoints are serialized and coalesced without replacing a revision already in flight. After a failure, the last valid committed snapshot stays intact, the failed revision remains pending, and both the dock and global storage banner offer retry. Retry commits the pending main revision and replays newer renderer changes. Malformed IPC payloads are rejected at main.

Normal close first refuses new app work, asks the renderer to pause and drain its playback checkpoints, then settles the existing queue/analysis/import/export owners and final storage. The renderer locks playback controls after this close request. The close handshake has an eight-second bound; a save failure keeps the app open with explicit feedback instead of claiming a clean exit. Reopen always restores paused, including a track that completed before shutdown. Forced termination guarantees only IPC-acknowledged checkpoints, not every uncheckpointed millisecond. File fsync and atomic replacement do not establish power-loss-safe directory metadata.

Imported originals remain externally owned. Auditioning reads them through the existing media protocol and does not rename, retag, move, or delete them. The tests compare their exact path and bytes before and after playback and close.

## Verification

The final source manifest is `test-results/playback-source-final.json` (SHA-256 source set `2f775e74944d2c878160296e5eb81364515a332f8f1d26df76799213c30820b9`). It matches the pre-package source hash. The fresh unpacked executable is `test-results/playback-package-20260923-230237/win-unpacked/Sonic V2.exe` (SHA-256 `48e6043965d33c5cb540fe3d4d322a5471c06d885ca032be2a0c9074b832fc12`); its `resources/app.asar` is SHA-256 `8eafa4400a82e0c92e62f94f76e43a792a51ec9a7a55df7af24d07ed22a8b2ae`. `out/main/index.js` is SHA-256 `bac63ae89e50d522bd77b3418050720919ccf935c79a8a150d09f5fdf908b7fd`. The package command used a new output directory; no old `release/win-unpacked` executable was used for the packaged tests.

| Check | Result |
|---|---|
| Typecheck, build, smoke | Passed from the final application source. The smoke's invalid-IPC diagnostics are intentional rejection cases. |
| Playback controller and checkpoint-drain unit tests | 15/15 passed after the final runtime changes. |
| Analysis, organization/batch, service, import regressions | 26/26 analysis, 13/13 organization/batch, service selftest, and local-import selftest passed. |
| Full development UI | 52 passed, one native OS-pointer skip, zero retries on the final application build (`test-results/reports/1790218132226-b07bf7a1-d8ec-413a-be21-63e5d6a7496c.json`). The additional collection-queue close/reopen assertion was added afterward and passed as a focused development test. |
| Repeated development interactions | 10/10 offline and 3/3 loaded passed, zero retries. |
| Fresh unpacked Windows app | 33/33 playback, collections, import, and persistence cases passed, zero retries (`test-results/reports/1790218987681-419779b0-0eab-4510-a978-f2474d416d0c.json`). The strengthened collection-queue close/reopen assertion is included. |
| Packaged immediate close/reopen | 3/3 additional repetitions passed, zero retries (`test-results/reports/1790219299324-358f6625-875a-4e41-a1ef-1531f9631b7a.json`). The reopened profile restored 10.1–10.2 seconds at volume 0.95, paused, in the three isolated runs. Normal exit code and absence of surviving owned processes are test assertions. |
| Packaged interactions | 2/2 offline/loaded passed with restricted `PATH`, isolated test-owned app data, and managed local FFmpeg/FFprobe (`test-results/reports/1790219340902-d50e-7174-e790-4475-a643-cb2ea5c1c77b.json`). |
| Packaged Windows OS pointer | Skipped because Windows denied foreground input. Chromium pointer coverage passed; it does not prove OS hit testing. |
| Strict synthetic DSP | 20/22 required cases, exit 1; the two exact relative-key cases remain inconclusive. No DSP algorithm or benchmark changed in this milestone. |

The first full development UI attempt had 51 passes, one OS-pointer skip, and one generic `Process failed to launch!` before the collections export test body ran. Its retained profile has a Chromium `DevToolsActivePort`, but no app lifecycle log, stdout/stderr, surviving process, or matching Windows crash event. The cause is unproven. The same export case passed alone, then passed in the full rerun and the 33-case package run. This first attempt is retained in `test-results/reports/1790217599257-4f896d16-b01d-4126-84e5-ad0720ca778e.json`; it is not counted as a passing run.

The packaged loaded workload used 180 seconds of generated 22,050 Hz mono pulse/chord audio, one acoustic analysis worker, WebAudio auditioning, 31 queue updates, and four radial-menu cycles. The four menu-cycle measurements were 112.8, 151.0, 122.8, and 127.0 ms; 575 sampled frame intervals had 4.2 ms median, 8.3 ms p95, and 49.8 ms maximum. These describe this generated workload, not a general performance benchmark. Installer creation and installed-app execution were not tested.

To reproduce from the same source, run these commands in PowerShell at the repository root. Tests create unique retained profiles under the system temp directory; the test harness restricts `PATH` itself and verifies process ownership before cleanup. The package directory name may differ on a new run.

```powershell
npm ci
npm run typecheck
npm run build
node --test tests/playback-controller.test.mjs tests/playback-checkpoint-drain.test.mjs
npm run test:analysis
node --test tests/batch-operations.test.mjs tests/organization-service.test.mjs
npm run test:services
node scripts/local-import-selftest.mjs
npm run test:ui
$env:SONIC_TEST_TRANSPORT='cdp'
npm run test:idle
npm run test:loaded
Remove-Item Env:SONIC_TEST_TRANSPORT
node scripts/run-smoke.mjs
$packageDir = Join-Path (Get-Location) ('test-results/playback-package-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
npx electron-builder --win --dir "--config.directories.output=$packageDir"
$env:SONIC_PACKAGED_EXE = Join-Path $packageDir 'win-unpacked/Sonic V2.exe'
npx playwright test tests/playback.spec.mjs tests/collections.spec.mjs tests/local-import.spec.mjs tests/persistence.spec.mjs
npx playwright test tests/playback.spec.mjs --grep 'immediate normal close' --repeat-each=3
$env:SONIC_TEST_TRANSPORT='cdp'
npx playwright test tests/interactions.spec.mjs --grep 'offline pointer|loaded analysis'
Remove-Item Env:SONIC_TEST_TRANSPORT
npx playwright test tests/interactions.spec.mjs --grep 'Windows OS pointer'
node scripts/source-manifest.mjs test-results/playback-source-final.json (Join-Path $packageDir 'win-unpacked')
Remove-Item Env:SONIC_PACKAGED_EXE
npm run test:dsp # expected exit 1: 20/22 required synthetic cases
```

## Manual acceptance

Open a manual collection, select several candidates, and start **Play selected tracks**. Navigate to Downloads and Settings, then return to Library; the dock should keep the current track, position, volume, and captured order. Edit a different track's notes while listening, use Next and Previous, seek and pause, close Sonic normally, then reopen the same profile. The last valid position should return paused, while annotations, memberships, and imported originals remain intact.
