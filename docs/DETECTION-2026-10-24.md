# Better and faster tempo, key and title detection — October 24, 2026

This change moves the analyser from `sonic-dsp/4` to `sonic-dsp/5` and extends the
title/description parser. Producer-style beats that were read at the wrong meter
now read at the labelled tempo. Keys that were confidently a fifth away now become
inconclusive with the right key kept as an alternative. The DSP takes about half
the time it did. Library tracks analysed by `sonic-dsp/4` count as stale and
reanalyse; manual corrections are untouched. The window plan and merge rules did
not change, so `ANALYSIS_PIPELINE` stays `windows/1+merge/1`.

Every number below compares the previous engine (`HEAD` at
`9727f1f`, loaded in the same process with `--baseline-ref HEAD`) with the new one on
the same input. Synthetic fixtures are engineering evidence about the algorithm,
not a measurement of accuracy on real productions.

## Results

| Measurement | sonic-dsp/4 | sonic-dsp/5 |
| --- | ---: | ---: |
| **Producer-style beats** (new, 43 tempo positives): tempo exact | 24/43 | **40/43** |
| ↳ tempo half/double instead of exact | 4 | 2 |
| ↳ tempo at a wrong meter (3:2, 4:3, …) | 8 | **0** |
| ↳ tempo inconclusive | 7 | 1 |
| ↳ labelled tempo among primary + alternatives | 28/43 | 42/43 |
| Producer-style beats (43 key positives): key exact | 15/43 | 15/43 |
| ↳ confidently wrong key (incl. drums-only false key) | 15 | **2** |
| ↳ inconclusive, label kept as an alternative | 11 | 22 |
| Negative controls (4 tempo: pad, noise, sine, 4 s clip; 4 key: drums, noise, sine, 4 s clip) | 7/8 inconclusive | **8/8** |
| Existing tempo matrix (`benchmark:tempo`), exact ±0.5 BPM | 128/132 | 128/132 |
| Existing triple-meter controls | 16/16 | 16/16 |
| Existing key matrix (`test:key`), exact / tuning / negatives / ambiguities | 144 / 144 / 18 / 12 | 144 / 144 / 18 / 12 |
| `test:dsp` primary exact tempo | 9/10 | **10/10** |
| `test:dsp` required cases | 20/22 | 20/22 |
| `test:dsp` evidence regressions / tempo false positives | 76/76 / 0/18 | 76/76 / 0/18 |
| 28 GuitarSet recordings: tempo exact primary | 14/28 | **18/28** |
| ↳ wrong primary tempo (incl. octave) | 12 | 9 |
| ↳ tempo abstained | 2 | 1 |
| 28 GuitarSet recordings: key exact primary | 14/28 | **16/28** |
| ↳ wrong primary key | 9 | **4** |
| ↳ key abstained | 5 | 8 |

| Time (Node 24, same machine, same process) | sonic-dsp/4 | sonic-dsp/5 |
| --- | ---: | ---: |
| Key DSP, 12 s fixture, median of 9 alternating runs | 29.77 ms | **14.25 ms** (−52%) |
| Tempo DSP, 150 s matrix window, median of 66 cases | 362.2 ms | **221.2 ms** (−39%) |
| Tempo DSP, 14 s matrix window, median of 66 cases | 33.8 ms | **19.0 ms** (−44%) |
| Producer beat, 67 s tempo window, median of 47 cases | 190.3 ms | **95.7 ms** (−50%) |
| Producer beat, 67 s key window, median of 47 cases | 155.2 ms | **65.1 ms** (−58%) |

`benchmark:analysis` (decode and PCM load only, no DSP) is unchanged: 202.2 →
90.4 ms median, identical key samples.

The GuitarSet corpus is the same 28 CC BY 4.0 recordings as the
[September benchmark](DSP-BENCHMARK-2026-09-23.md). They are solo/comping
guitar, not beats, and earlier key work was already tuned on them, so they are
**not a held-out set**. They were used here only as a regression check. One
threshold, the 0.68 scale-residual gate, was placed below the lowest value seen
there (0.70).

## What changed in tempo detection

**Band-equalised onset envelope.** Spectral flux sums every bin that gets louder,
so the band with the most changing bins dominates: usually hats and noise above
2.5 kHz. A four-on-the-floor house groove with open off-beat hats then read as
81 BPM, three half-beats, instead of 122. Half of the envelope is now the plain
flux. The other half is the three accent bands (<200 Hz, 200 Hz–2.5 kHz,
>2.5 kHz), each rescaled to equal mean onset energy. A band holding under 5% of
the flux is left out of that half. Full equalisation fixed the same cases but
turned the 3/4-at-180 control into 60. The 50/50 mix keeps all 16 triple-meter
controls.

**Metrical-consistency scoring.** A beat repeats at its own period and also at
its half bar and bar. A cross-rhythm does not: the dotted-eighth pulse of a
tresillo, or the 3+3+2 figure of afrobeats and dembow. Every periodicity peak, plus
its 2× and ½×, is now scored as the mean fractional autocorrelation at 1, 2, 3 and
4 periods. The search is ±2% around the peak, and multiples stay within half the
envelope. The score is multiplied by the existing log-Gaussian prior (centre 120 BPM,
σ 0.8 octave). The 2×/½× candidates matter: an afrobeats groove has no
autocorrelation peak at its beat at all, only at its half bar. The existing 3:2
grouping rule and the method cross-check now compare this score rather than raw
autocorrelation. The rhythmic-evidence gate also accepts it, for the period itself
or its half. That is what turns the selftest's tresillo from 47.9 into 96.0. The
prominence-based confidence keeps its original scale.

**Producer octave folding.** Trap and drill are labelled at their hat-driven
130–165 BPM rate, even though the snare lands once per bar. The plain prior
therefore read them at 65–82. A slow reading S now folds to 2S when 2S ≤ 165 and either:

- a band repeats at a subdivision of 2S (half or a third of its period,
  correlation ≥ 0.15), or
- S < 83 and a band pulses at 2S (correlation ≥ 0.2).

The second rule is the "octave folding into 70–160 by onset density" idea: at
65–82 BPM, a hat pulse at the double is the deciding cue. The thresholds sit
between the measured values. Trap and drill hat bands at 2S were 0.21–0.32, while
lo-fi at 72–88 was −0.13 to −0.21, so lo-fi stays slow. Boom bap at 85–95 doubles
past 165 and is never folded. The other octave remains a reported alternative.

## What changed in key detection

**Key-signature eligibility.** Pearson correlation against a profile does not
punish a missing leading tone much. A loop that leans on its flat-seventh chord
(Am–G–F–G, with 808 and melody also on G) therefore correlated best with G major,
although F♯ was absent and F♮ strong. A key may now lead only if the chroma mass on
its scale is within 0.04 of the best-fitting scale. Minor keys count the better of
natural and harmonic minor. Excluded keys stay visible as alternatives. In this
cohort, every key that changed went from "confidently a fifth away" to
"inconclusive between the relative pair, label kept". The relative-key ambiguity
rule was not relaxed, and no minor-key preference was added. Doing either would
break the twelve balanced-loop gates in `test:key`, which must stay inconclusive.

**Scale-residual gate.** Remove the strongest pitch class, and tonal music still
puts most of the remaining chroma on one 7-note scale. A drum loop whose only
pitched content is a kick drum's pitch sweep sits near chance (7/11 ≈ 0.64; the
fixture measured 0.66). It had been reported as B minor with 0.67 correlation.
Below 0.68 the result is now inconclusive. Measured minima elsewhere: tonal
producer fixtures 0.94, key-matrix fixtures 0.90, GuitarSet recordings 0.70.

## Faster

- **Half-size real FFT.** Both analysers transformed real frames through a
  full-size complex FFT with a zero imaginary part, then used only magnitudes.
  Frames are now packed as N/2 complex samples, transformed once, and split into
  the N/2+1 magnitudes. The result matches a direct DFT within 2·10⁻¹¹ at N = 8192.
  The butterfly no longer tests a nullable imaginary array per sample.
- `Math.hypot` → `Math.sqrt(re² + im²)` in the onset flux. On its own this cut
  producer-fixture tempo time from 7.4 s to 6.0 s with identical outcomes.
- Band flux accumulates over contiguous bin ranges in locals, and the
  previous-frame buffer is swapped rather than copied.
- Metrical scores are memoised per candidate.

## Text detection

`src/shared/metadata.ts` now reads:

- **Tempo:** `140bpm`, `bpm:140`, `140 - 145 BPM` (a range keeps its first
  number), `70 - 140 BPM` and `bpm 140/70` (half-time pairs), `@ 140` and
  `@140bpm`.
- **Bracketed tempo:** `[140]`, only when it is the one bracketed number in the
  text and lies in 60–200.
- **Key:** `C sharp minor`, `B-flat major`, `in the key of G` (no mode means
  major), and Camelot with a leading zero (`08A`, `Key: 08A`, `Camelot 04B`).
- **Producer:** `prod. @handle` credits.
- **Title:** `Free for profit` / `FREE FOR PROFIT` is removed from clean titles.

Forms that already worked are now covered by tests: `Db maj`, `F#min`,
`Key - Am`, `Ebm`, `G♯m`, `Bbmin`, `(prod by X x Y)`, `prod. X & Y`.

New negative fixtures confirm these are never read as tempo or key:

- years (`Type Beat 2026`, `[2026]`)
- `808`, `[808]`, `Room 808 - 140bpm` (reads 140)
- `Track 12 - 140 BPM` and `Episode 95 - 140 BPM` (both read 140)
- two bracketed numbers, `(Part 2)`, `@2026`, `@100k`, `Episode 140`
- `Key of the Night`, `the key of a lifetime`, `a sharp minor turn`, and the
  existing `a minor setback`

## Evaluated and dropped

| Idea | Result | Decision |
| --- | --- | --- |
| SuperFlux (max-filtered previous frame) | Fixed 2 producer cases, broke 3 (boom bap → 170/190) and one tempo-matrix case | Dropped |
| Metrical-sum curve blended into peak picking | Created spurious peaks (tresillo → 140) | Replaced by candidate scoring |
| Accent-based octave demotion (140 → 70 for kick-on-beat patterns) | Made the matrix 132/132 but contradicts trap's half-time labelling | Dropped |
| Median-filter harmonic/percussive separation for chroma (5–9 frames) | No category changed; key time +40% | Dropped |
| Shaath + Krumhansl + Temperley ensemble | Broke all 12 balanced relative-key gates; 16 relative confusions | Dropped |
| Multi-excerpt tempo voting with intro/outro exclusion | Not implemented: sparse-intro fixtures were already 3/3 after the changes above, and it would multiply tempo cost | Not done |
| Calibrated confidence | No labelled real beat corpus to calibrate against; confidence remains an evidence indicator | Not done |

## Limits

- The producer fixtures are generated by `scripts/benchmark-producer-beats.mjs`
  and labelled by producer convention. Trap and drill are labelled 130–160. The two
  R&B fixtures labelled 64 and 70 are built like half-time trap and read 128/140,
  with the label kept as the half alternative. These cases are ambiguous by
  construction.
- 4 of the 132 original tempo-matrix cases still read 140 for a 70 BPM label
  (kick-on-beat, hat-off-beat). That matches the previous engine.
- The two relative-mode historical `test:dsp` cases (Am–F–C–G, Gm–Eb–Bb–F) remain
  inconclusive, as designed, so `npm run test:dsp` still exits 1 at 20/22.
- Most changed producer keys became inconclusive rather than exact. A
  flat-seventh loop is genuinely ambiguous between the minor key and its relative
  major without knowing where the loop starts. The inspector shows both.
- Real drum-heavy beats with independent annotations are still unavailable (see
  the September benchmark notes). Real-beat accuracy and the real negative
  false-positive rate remain unmeasured.

## Reproduce

```powershell
npm run test:dsp            # exits 1 by design (20/22 required)
npm run test:key -- --baseline-ref 9727f1f
npm run benchmark:tempo -- --baseline-ref 9727f1f
npm run benchmark:analysis
node scripts/benchmark-producer-beats.mjs --baseline-ref 9727f1f --report test-results/producer.json
node --test tests/analysis-producer-detection.test.mjs tests/metadata-parsing.test.mjs
node scripts/benchmark-real-audio.mjs --manifest <guitarset manifest> --report <path>
```

The measured reports from this run are in the ignored
`test-results/detection-2026-10-24/` directory.
