# Safe local-audio import — implementation and verification

This feature branch starts from `origin/main` at `a185a02`. It adds file and folder import to the existing library without changing the analysis algorithm, dependency lockfile, storage format, or export recipes. Import is a reference-in-place operation: the original path and bytes remain owned by the user. Sonic saves corrections and acoustic results in its managed library; an explicit re-export creates a separate Sonic-owned file with the effective BPM/key filename, sidecar, and supported audio tags.

## Ownership and recovery contract

`LibraryBeat.fileOwnership` is `external` for imported originals and `sonic-export` for newly published outputs. An absent field on a legacy record restores as `sonic-export`; an unknown explicit value restores conservatively as `external`. A fingerprint identifies the file but does not grant permission to rename, retag, move, or delete it. External records have no sidecar path. Library rename and metadata correction commit only the record, and analysis commits only managed state. Removing an external record keeps its source file. The main process rejects a request to remove it with `deleteFiles=true`, even when the renderer is bypassed.

File and folder paths come only from Electron's native picker in the main process. The renderer passes a session ID and reviewed item IDs to confirm. The scanner reports unsupported/unreadable/failed candidates independently. Same-path imports are skipped without replacing existing records or overrides; same-content files at different paths receive a warning and remain separate choices. Folder recursion is explicit. Limits are 1,000 entries, 12 directory levels, 2 GiB per file, 8 GiB of inspected files per review, 10 minutes per review, 120 seconds per inspection, and two concurrent probes. An incomplete enumeration cannot be confirmed. Windows junctions and symlinks are not followed; directory realpaths are tracked to stop cycles. Native filesystem calls themselves cannot be forcibly interrupted, but shutdown waits for the service's owned work to settle.

An acknowledged import has committed its library revision. If replacement fails, the previous committed library remains valid and the review retains a pending-save error; the user must retry storage before dismissing it. After an explicit retry, the session reconciles saved records by path and can retry analysis admission without importing or overwriting the original again. Analysis admission failure is shown separately from the saved import. Cancellation does not claim that already committed records were rolled back. The established shutdown sequence aborts reviews, waits for import work and analysis tasks, then flushes stores and exits.

## Evidence from the final application source

All fixtures and profiles were test-owned. No test selected the user's library or media folders. Playwright used one worker, zero retries, and retained each profile and process log. The test harness verifies normal process exit and no surviving owned children before passing a close test.

| Check | Result |
| --- | --- |
| Typecheck and Electron/Vite build | Pass after the last application change |
| Analysis coordinator, service, search, ownership | 26/26, 21/21, 11/11, 1/1 pass |
| Isolated local-import service regression | Pass: four imports, duplicates, partial failures, cancellation, scan limit, real isolated library replacement failure and explicit retry, analysis admission retry |
| Development import workflow | 5/5 pass: review, preview/search, correction/analysis, FLAC re-export/tag and sidecar readback, restart, duplicate and partial failure, recursion/cancel, invalid IPC and ownership labels |
| Existing editor and persistence workflow | 5/5 and 6/6 pass |
| Development interactions | 10/10 offline and 3/3 loaded, zero retries on the final build |
| Fresh unpacked Windows import | 5/5 pass, zero retries; includes normal close and same-profile reopen |
| Fresh unpacked Windows persistence | 6/6 pass, including three normal close/reopen cycles, zero retries |
| Fresh unpacked Windows interactions | 1/1 offline and 1/1 loaded pass |
| Offline smoke | Pass; invalid import path argument rejected before native picker |
| Required synthetic DSP | **20/22**; expected nonzero exit; two relative-key cases remain inconclusive |

The first development run of the fifth import test failed because its locator matched both modal Close buttons; the locator was made specific, and the full five-test run then passed. The first repeated offline interaction run failed because the new UI hid an existing disabled sidecar menu item; the existing disabled item was restored, the app was rebuilt, and the next single pass and ten consecutive passes succeeded. These first attempts are retained in `test-results/reports/` and are not counted as passing runs.

The tested **unpacked** executable is `test-results/local-import-package-20260923-103829/win-unpacked/Sonic V2.exe` (SHA-256 `6CD3905DDD3362ED7E121D1B8148991F6141D7F4295B6210AD1362851278DA25`). Its `resources/app.asar` SHA-256 is `FAFECE5620D64EFA45CD18A4E0F6B57FE63C5E817DB3043EFC546D67BE0CEBB6`. The package was built after the final application-source change, directly into that unique output directory; no older `release/` executable was tested. Playwright reports for the final development import, repeated offline, loaded, packaged import, packaged persistence, and packaged interactions are respectively `1790173735483-934d20c5-69fe-4d59-8694-4c63eb33c1be.json`, `1790174091690-6aa8776d-d9fd-4262-ad23-4dedf95a470a.json`, `1790174250478-5968ef6e-a3f0-4d45-b081-f594dc8891cf.json`, `1790174332207-ec270653-10f2-469e-aacb-7a35657d8490.json`, `1790174371137-cc306d72-6a3a-4642-9d45-c23eaa57f27d.json`, and `1790174420498-98419ac9-bae8-4a65-b0cc-fffeff9c9ce2.json` under `test-results/reports/`.

The locally imported WAV stayed at its original path with the same SHA-256 after analysis, manual BPM/key correction, FLAC export, normal close/reopen, and record-only removal. The exported FLAC was a different path with a Sonic-owned record; its sidecar fingerprint matched its output bytes, and `ffprobe` read back 136 BPM and F# minor from the audio tags. The test fixture engine came from its isolated profile under a restricted PATH.

This milestone does not verify an NSIS installer or installed-app execution, every Windows display scale, or a large-library responsiveness benchmark. The separate real-recording DSP benchmark is not evidence that this import feature improved the analyzer; the synthetic 20/22 result is unchanged.

## Reproduce on Windows

From the project root, using the checked-in lockfile:

```powershell
npm ci
npm run typecheck
npm run build
npm run test:analysis
npm run test:services
node tests/library-search.test.mjs
node --test tests/ownership-import.test.mjs
node scripts/local-import-selftest.mjs
npx playwright test tests/local-import.spec.mjs tests/editor-corrections.spec.mjs tests/persistence.spec.mjs --workers=1
$env:SONIC_TEST_TRANSPORT = 'cdp'
npx playwright test tests/interactions.spec.mjs --grep 'offline pointer' --repeat-each=10 --workers=1
npx playwright test tests/interactions.spec.mjs --grep 'loaded analysis' --repeat-each=3 --workers=1
Remove-Item Env:SONIC_TEST_TRANSPORT
$packageDir = Join-Path (Get-Location) ('test-results/local-import-package-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
npx electron-builder --win --dir "--config.directories.output=$packageDir"
$env:SONIC_PACKAGED_EXE = Join-Path $packageDir 'win-unpacked/Sonic V2.exe'
npx playwright test tests/local-import.spec.mjs tests/persistence.spec.mjs --workers=1
$env:SONIC_TEST_TRANSPORT = 'cdp'
npx playwright test tests/interactions.spec.mjs --grep 'offline pointer|loaded analysis' --workers=1
Remove-Item Env:SONIC_PACKAGED_EXE
Remove-Item Env:SONIC_TEST_TRANSPORT
node scripts/run-smoke.mjs
npm run test:dsp # currently exits 1 with two strict relative-key failures
```

The import and persistence Playwright tests use Electron Inspector by default because they inspect the main process. The interaction tests above explicitly use CDP. Every test profile is unique and retained; forced cleanup is recorded as failure, never as a passing close.
