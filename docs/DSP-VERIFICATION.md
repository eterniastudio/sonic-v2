# DSP correctness pass — 2026-09-22

The original synthetic cohort improves from **15/22 to 19/22 under its unchanged historical annotations**, or **20/22 with the demonstrably incorrect percussion/no-tempo annotation corrected**. The two strict exact-key requirements still fail. `npm run test:dsp` deliberately exits **1**, not green, for those unresolved cases. All 45 added evidence regressions pass.

## Reproduction and evidence

Run from the project directory in PowerShell:

```powershell
$env:SONIC_DSP_REPORT = 'test-results/dsp-agent/final.json'
npm run test:dsp *> test-results/dsp-agent/final.log
$LASTEXITCODE # expected 1 while the two exact-key cases remain unresolved
.\node_modules\.bin\tsc.cmd --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --skipLibCheck src/main/analysis/dsp.ts
node --check scripts/dsp-selftest.mjs
```

`test-results/dsp-agent/baseline.log` is the directly reproduced 15/22 starting result. `final.log` and `final.json` contain the final result, full candidate lists, per-field statuses, expectations held outside the analyzer, measured regression durations, and SHA-256 source identities. The source build is compiled directly through the existing esbuild harness, not loaded from an old packaged executable. No UI or package result is established by this DSP-only test.

Final DSP SHA-256: `db642859920c731344998e600591dee86ada09878ff684d3073f03fbce02cbbf`.

Final harness SHA-256: `5d432a767e043b89823d8deb7e4f19e11f4c5db93638fce38b903d8e7a92ddf5`.

The isolated DSP TypeScript check, whole-project `npm run typecheck:node`, and harness syntax check pass. Final application integration verification belongs to the lead-agent run. The shared engine identity is `sonic-dsp/2` so older cached results do not masquerade as the new algorithm.

## Confirmed defects and changes

1. **Incorrect prominence geometry.** The lag conversion supplied `framesPerSecond / 60`, although BPM-to-lag requires `framesPerSecond * 60 / bpm`. This evaluated the wrong/empty local neighborhood and inflated prominence. The conversion is corrected.
2. **Octave alternatives were suppressed by their own lookup.** The half/double lookup called a predicate explicitly rejecting half/double relationships with the primary. It now excludes only already reported identical rates when looking for octave alternatives.
3. **Weak or stationary evidence was normalized into a strong-looking curve.** Uncompressed log flux amplified near-zero FFT leakage in stationary tones. Signal-relative `log1p` compression, a stationary-spectrum floor, and an absolute autocorrelation gate now precede candidate normalization and the tempo prior. Local prominence and actual correlation are separate from disagreement about the metrical level. The thresholds are engineering choices evaluated on the reported synthetic cohort, not universal musical guarantees.
4. **The old comb measurement sampled only the initial eight teeth from time zero.** Despite its comment, it did not integrate all phases. Phase-folded coherent energy now uses the complete excerpt and contributes a smaller corroborating weight. Every reported period is refined against autocorrelation; a longer supported period reduces frame-grid quantization. Supported half/double alternatives remain visible. Agreement on a longer phrase cannot by itself override ordinary duple/triple metrical choices.
5. **Global key accumulation overweighted louder/lower-register observations.** Usable frame histograms are normalized before aggregation. Pitch-class rotation and canonical shared Camelot mapping remain intact, with all twelve transposed major progressions tested. When the leading relative major/minor correlations differ by less than 0.12, the result is inconclusive with both leading acoustic candidates preserved, rather than a confident major-key guess. No filename, title, expected label, tag, or source-assisted reconciliation enters the DSP.

## Baseline versus final results

| Measurement | Baseline | Final |
| --- | ---: | ---: |
| Original tempo positives, exact primary (±2 BPM) | 8/10 | 8/10 |
| Additional exact result present only among alternatives | 0/10 | 1/10 |
| Additional half/double-only result | 0/10 | 1/10 |
| Original tempo positives satisfying unchanged required tolerances | 8/10 | 10/10 |
| Original tempo estimate coverage | 10/10 | 10/10 |
| Original key exact primary | 4/6 | 4/6 |
| Original key estimate coverage | 6/6 | 4/6 |
| Incorrect relative-major primary results | 2/6 | 0/6 |
| Inconclusive key results preserving expected key among alternatives | 0/6 | 2/6 |
| True original tempo-negative false positives | 2/5 | 0/5 |
| Original key-negative false positives | 0/6 | 0/6 |
| Deterministic repeated outputs | 4/4 | 4/4 |

The 140 BPM fixture now reports approximately 69.9 BPM with 139.8 as its supported double-time alternative; it is not counted as exact-primary accuracy. The 96 BPM tresillo reports approximately 47.9 BPM, a supported half-time phrase rate; it is not counted as an exact 96 BPM result. This is better candidate accuracy with honest metrical uncertainty, not proof that the intended primary metrical level is solved.

The two unresolved strict key requirements are Am–F–C–G (`A minor`) and Gm–Eb–Bb–F (`G minor`). Their global pitch distributions also support C major and Bb major respectively. The detector now abstains while retaining both modes, but **the original exact-key assertions remain unchanged and failing**. An abstention is not reclassified as a correct key. These looping relative-mode progressions lack the stronger cadential evidence present in the other fixtures; no annotation is silently changed to make them pass.

## Percussion annotation correction

The original `percussionOnly` builder calls `addHit` every 0.25 seconds: a 240-onsets/minute periodic train, including a short 300 Hz thump. Its comment claiming noise-only content and its assertion that *both* fields must be inconclusive were false descriptions of its generated signal. The same PCM fixture is retained unchanged. Key must remain inconclusive; tempo must contain 240 BPM or a supported half/double reading within the original ±2 BPM tolerance. The final candidate set includes approximately 240.2 BPM, although its 80.4 BPM primary is still the wrong metrical level. This is explicitly candidate-level success, not exact-primary accuracy. The report separately prints the unchanged historical score (19/22) to make the one-point annotation effect explicit.

## Added regression scope and performance

The 45 new cases comprise 18 tempo negatives (110/440/1000 Hz stationary tones and three independent noise seeds at 22.05/44.1/48 kHz), nine positive pulses (90/128/174 BPM at those sample rates, each with a 317 ms offset), twelve transposed major progressions, one labeled injected branch-local input-read failure, four actual worker-thread missing-PCM regressions, and one multi-window merge regression. Positive tempo coverage is 9/9; tempo-negative false positives are 0/18; transposed key matches are 12/12.

The worker now catches tempo input failures and each key-window input failure independently. Tests prove missing tempo PCM retains successful key, missing key PCM retains successful tempo, a missing window retains a successful key from another window with a warning, and a missing window retains both relative-key alternatives from an inconclusive window. Each assertion waits for the actual test worker's clean exit before cleanup. Missing paths and the direct API exception are deliberate fault injection, not spontaneous filesystem failures or reproduction of the packaged JSON-save issue.

Multi-window merging no longer compares one section's confidence heuristic to another candidate's raw correlation, and no longer drops the winning key when returning an inconclusive result. The optional `KeyAnalysis.correlation` stores a new result's raw leading-profile Pearson coefficient without breaking old persisted records. Disagreeing tonal sections return inconclusive with both leading candidates and true correlations; a failed window cannot erase acoustic alternatives from an inconclusive one. The dedicated merge test verifies both leading coefficients are preserved exactly. Older records without a leading coefficient cannot retroactively supply that acoustic evidence.

The measured final run analyzed the 27 added tempo samples in a median **33.34 ms**, maximum **84.81 ms** per case; twelve key samples in a median **35.67 ms**, maximum **38.40 ms** per case. These are generated 12–20 second signals in a Node process, excluding fixture creation/decoding and packaging. They are not application UI timing, a before/after benchmark, or a universal performance guarantee.

All synthetic samples are passed as PCM with sample rate/duration only. Opaque IDs and independent expectations are in the JSON report; the DSP receives neither names nor labels. Local audio inventory found generated service/interaction fixtures, not a documented licensed and independently annotated real-music benchmark. **Credible real-music reference sample count: 0.** Real-music BPM/key accuracy remains unverified; no unlabelled downloaded beat is represented as validation.
