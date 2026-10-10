# Download / Library audio handoff

Completed downloads now use **Preview in Sonic** and the same playback controller
as Library audition. The queue's stable library ID resolves renamed/recovered
tracks; older entries without an ID may resolve their existing library path.
Removed records show feedback instead of launching an external media app.

There were two independent ways to leave audio playing. Download's old button
called `shell.openPath`, which launched a separate default player. Also,
WaveSurfer treats the WebAudio backend as external media: destroying its waveform
does not pause that backend. Sonic now explicitly pauses it before destruction.
Already-open external applications are not closed or controlled by this fix.

The new real-application regression instruments actual AudioBufferSourceNode
start/stop calls, exercises Download → Library → Download and repeated Preview,
and checks a maximum of one active source, zero sources after Pause, one waveform,
and zero external-player launches. It also checks removed-record feedback.
The first attempt failed with two active sources, exposing the cleanup defect;
`test-results/preview-handoff-first.{json,log}` preserves that evidence.

Verification: typecheck/build pass; 21 controller tests pass. The corrected
handoff regression passes in development and the exact unpacked package below.
The broader Download/playback interaction run passed 15/15 with zero retries
in 1.8 minutes (`test-results/preview-handoff-final.json`). The packaged handoff
run passed 1/1 (`test-results/preview-handoff-packaged.json`).

Tested package: `release/preview-handoff-20261005-2/win-unpacked/Sonic V2.exe`.
app.asar SHA-256: `3a5687e2cc8a89efa2d8a391bcd796b09bfc1024bfd4b627149e07c1f7f3e305`.
All 15 packaged application files match the final production output. Source and
executable hashes are in `test-results/preview-handoff-source.json`.
The earlier `preview-handoff-20261005-1` package predates the cleanup fix and is
not the verified handoff artifact. Installer execution was not tested.

Reproduce from the repository root:

```powershell
pnpm typecheck
node --test tests/playback-controller.test.mjs
pnpm build
node scripts/build-component-harness.mjs
pnpm exec playwright test tests/playback.spec.mjs tests/download-editor.spec.mjs
$env:SONIC_PACKAGED_EXE=(Resolve-Path 'release/preview-handoff-20261005-2/win-unpacked/Sonic V2.exe').Path
pnpm exec playwright test tests/playback.spec.mjs --grep 'Download previews'
```
