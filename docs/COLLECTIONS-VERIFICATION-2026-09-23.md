# Collections and batch workflows — implementation and verification

This branch starts from `origin/main` at `24adf763d5948b9c63165aeae48abcac09845066`, after safe local import and the independent real-audio benchmark were merged. Collections extend the existing library and search view. No audio database, DSP algorithm, export recipe, or imported-original ownership policy was replaced.

## Data and operation contract

`organization.json` is a versioned, validated JsonStore for producer annotations (favorite, user tags, plain-text notes), manual collections, smart rules, and the active view. It is separate from source declarations, embedded tags, acoustic estimates, and manual BPM/key corrections. A successful organization command means its revision was committed before IPC acknowledgement. One metadata batch produces one logical store write. A failed replacement retains the last committed state and an unsaved revision for explicit `storage:retry`; malformed data is preserved for diagnosis and only a validated backup can restore it. Legacy library rows retain their IDs and need no migration to load with empty annotations.

Manual membership and ordering use stable beat IDs. Tracks can appear in several collections without copying files. Removing membership or deleting a collection only changes `organization.json`; it never invokes library deletion or touches audio. Missing files retain their membership. Smart collections save bounded version-1 rules and derive their membership through the existing search predicates. Rules distinguish unknown BPM/key from numeric zero and can distinguish an externally owned imported original from a Sonic-owned export derived from it. An origin of `local` alone includes both, so the interface labels that option “Local source.”

Selection uses beat IDs and is separate from preview and keyboard focus. Shift-click follows displayed order, Ctrl/Cmd-click toggles, native checkboxes support keyboard selection, and select-all targets all matching results rather than mounted rows. Scope/search/filter changes clear selection; sort and layout changes preserve it. When manual membership or smart results change, hidden tracks are pruned from the selection and new results are not silently added. The annotation editor keeps unsaved tags and notes independently and submits only edited fields, so an incoming update to the other field is retained. Batch actions snapshot IDs at admission, revalidate each target, use bounded sequential analysis/export ownership, and report completed, failed, skipped, cancelled, and pending-save items separately. Tag addition and removal preserve unrelated tags and notes. A cancelled export already published to disk remains completed; later items are cancelled.

An export that created audio and sidecar but failed to commit its library record returns `pending-save` with the exact output path and new beat ID. A later batch retry never republishes that item. It counts as recovered only when storage retry has committed that exact Sonic-owned record **and** the current output file hashes to its saved fingerprint. Missing, replaced, or unregistered outputs remain failed for manual recovery. Batch sessions are process-local; after an app restart, the library and exported files remain the durable record, while the prior per-item session report is not retained.

Imported originals remain external references. Collection and annotation commands do not rename, retag, move, or delete them. Explicit export creates a new Sonic-owned copy. All destructive and fault-injection tests below used isolated, test-owned profiles and files.

## Verification of the final application source

| Check | Result |
| --- | --- |
| Typecheck, Electron/Vite build, offline smoke | Passed |
| Organization and batch focused service tests | 13/13 passed; includes failed revision retry, no duplicate export after pending save, missing/replaced output rejection |
| Analysis coordinator | 26/26 passed |
| Existing Electron service regressions and isolated local-import selftest | Passed |
| Development Playwright full suite | **45 passed, 1 skipped**, one worker, zero retries; collections 15/15, editor, existing interactions, import, and persistence pass. Windows foreground lock skipped the separate OS-pointer case. |
| Development repeated interactions | Offline **10/10** and loaded **3/3**, zero retries, CDP transport |
| Development additional close/reopen cycles | **6/6**, zero retries (three annotations/collections and three UI shortlist cycles) |
| Fresh unpacked Windows executable | Collections and persistence **21/21** passed, zero retries; includes normal close/reopen, active analysis close, interrupted-save recovery, and imported-original byte checks |
| Repeated packaged normal close/reopen | **9/9** passed, zero retries: settings, correction, active analysis, each repeated three times |
| Packaged offline and loaded interactions | **2/2** passed with CDP in a standalone run. Packaged Windows OS-pointer test was **skipped** when Windows denied foreground input. |
| Required synthetic DSP | **20/22**; expected nonzero exit, with two strict relative-key cases inconclusive. This milestone did not change acoustic detection. |

An earlier full UI run was 37/44 because the older component harness's fake beat lacked the `sources` object now required by the metadata editor. The harness crashed before rendering. Its fixture and reset-button selectors were updated without changing assertions; that intermediate source passed 44/44. A later focused selection test first saw the development app exit before its initial click (cause unproven), then exposed an ambiguous test locator; the locator was fixed. The annotation regression first failed against the prior renderer build, then passed after the editor fix and rebuild. A packaged native-pointer invocation on the intermediate package used CDP, which has no `app.evaluate`; an Inspector rerun passed on that intermediate package. Final-source development and packaged native-pointer runs were skipped because Windows would not grant foreground input. These first attempts and skips remain in `test-results/reports/` and are not counted as native-input proof for the final artifact.

The tested artifact is the **unpacked executable**, not an installer: `test-results/collections-package-20260923-214318/win-unpacked/Sonic V2.exe` (SHA-256 `3A908F1979813C95440D4D7FD17A3372E22BECF0E822C698118EA85745ECDB89`). Its `resources/app.asar` SHA-256 is `81404C36255C37DBA035707523E3FA49F28833FD13A66564B0D0ECFBAA49F686`. `test-results/collections-source-manifest-20260923.json` records source hash `F5451DDC365C2201745013B2BE039E272AC3058D5F8A9A1C651BD3A1FF360AFB` and the exact package hashes; it was rechecked after testing. The package was built from the same `out/` app build used by the development checks, directly into a unique directory instead of reusing `release/`.

The final full development, offline repeat, loaded repeat, packaged collections/persistence, packaged offline/loaded, packaged native-pointer skip, and repeated packaged persistence Playwright reports are respectively `1790213521242-bc4e9992-348d-45bc-a7f2-42ffdf6c746e.json`, `1790213913411-4d4a2caf-e2c8-4199-a110-fde763717558.json`, `1790214155208-96cf4ab0-fe03-451f-bf1f-9dbfe8ffc665.json`, `1790214233434-091f27e7-dfc2-4a85-9d71-159d9ae6f87e.json`, `1790214519034-49d2036f-aa95-4fd5-a572-449f0ae9f1fb.json`, `1790214556704-5233eb2c-4f77-40a8-889d-4b2de74bd439.json`, and `1790214421952-1f0ef323-8c92-4c85-8cdf-f1bea5b5b210.json` in `test-results/reports/`. The final-source six-cycle development collection report is `1790214644322-3404be92-1000-4715-a093-f4f062ead928.json`. Every close test waits for exit and owned children, and profiles and diagnostics are retained.

An NSIS installer and installed-app execution were not verified. The final-source native OS-pointer case was blocked by Windows foreground access; Chromium pointer coverage passed, and a prior package revision had passed native input, but neither establishes final-artifact native hit testing. Other display scaling configurations were not measured. The separate 28-recording real-music benchmark in `docs/DSP-BENCHMARK-2026-09-23.md` remains the current acoustic reference and is not evidence of improved DSP in this branch.

## Reproduce on Windows

```powershell
npm ci
npm run typecheck
npm run build
node --test tests/batch-operations.test.mjs tests/organization-service.test.mjs
npm run test:analysis
npm run test:services
node scripts/local-import-selftest.mjs
npm run test:ui
$env:SONIC_TEST_TRANSPORT='cdp'
npm run test:idle
npm run test:loaded
Remove-Item Env:SONIC_TEST_TRANSPORT
$packageDir = Join-Path (Get-Location) ('test-results/collections-package-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
npx electron-builder --win --dir "--config.directories.output=$packageDir"
$env:SONIC_PACKAGED_EXE = Join-Path $packageDir 'win-unpacked/Sonic V2.exe'
npx playwright test tests/collections.spec.mjs tests/persistence.spec.mjs
npx playwright test tests/persistence.spec.mjs --grep 'normal close/reopen cycle' --repeat-each=3
$env:SONIC_TEST_TRANSPORT='cdp'
npx playwright test tests/interactions.spec.mjs --grep 'offline pointer|loaded analysis'
Remove-Item Env:SONIC_TEST_TRANSPORT
npx playwright test tests/interactions.spec.mjs --grep 'Windows OS pointer'
node scripts/source-manifest.mjs test-results/collections-source-manifest.json (Join-Path $packageDir 'win-unpacked')
Remove-Item Env:SONIC_PACKAGED_EXE
node scripts/run-smoke.mjs
npm run test:dsp # currently exits 1 for two strict relative-key cases
```

Manual acceptance: import or download several tracks; select a shortlist, add a user tag and favorite, create a manual project collection from the selection, then create a smart collection such as favorite tracks in a BPM range. Close and reopen Sonic, confirm the annotations, memberships, active collection, layout and sort, then export the shortlist with an existing recipe. Confirm the new Sonic-owned outputs in the library while imported originals retain their paths and bytes.
