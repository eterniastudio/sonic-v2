# Sonic improvement review — October 14, 2026

This review builds on the [history of the first nine pull requests](CHANGELOG.md).
The focus is more dependable musical analysis, less repeated audio processing,
usable keyboard and screen-reader controls, and predictable setup and downloads.
Measurements below identify the operation they measure; they are not promises of
the same speed or musical accuracy on every library.

The real-recording check improved from **11/28 to 14/28 correct primary keys** on
the existing development corpus. It still produced nine incorrect primary keys
and five inconclusive results. Some tracks still require candidate review or a
manual correction.

## Better pitch and tuning evidence for key detection

The old tuning fold divided its correction by 100 twice. A detected 35-cent offset
therefore applied only about 0.35 cents of compensation. The key pass also spread
FFT peak energy across adjacent pitch classes and overemphasized lower notes.
These faults could shift the evidence toward a wrong key, especially on detuned
audio and inverted chords.

The updated `sonic-dsp/3` analyzer locates narrow spectral peaks, refines their
frequencies with log-magnitude interpolation, gives each usable frame equal
weight, and applies the tuning correction in consistent units. It compares the
resulting pitch distribution with published Shaath major/minor profiles.
Complete tonic-triad observations can corroborate close relative-key decisions;
balanced relative-key evidence still returns inconclusive with alternatives.
No filename, source title, or expected test label enters the signal calculation.

| Controlled key regression matrix | Previous detector | Updated detector |
| --- | ---: | ---: |
| Exact primary key | 116/144 | 144/144 |
| Tuning within 5 cents of the generated pitch | 72/144 | 144/144 |

The comparison baseline is the
[previous merged version](https://github.com/eterniastudio/sonic-v2/commit/67b42008119cf5c1d88603c558fe750635ab3ebb).

The 144 fixtures cover all 24 keys with standard tuning, ±35-cent detuning, bright
harmonics, inverted chords at 44.1 kHz, and detuned audio at 48 kHz. All **18/18**
additional sine and harmonic-drone controls return inconclusive. These are
controlled synthetic regressions, not a measurement of real-music accuracy.
All **12/12** balanced relative-key loops also remain inconclusive and retain
both candidate keys.

On the same 28 independently annotated GuitarSet recordings used by the earlier
[real-audio benchmark](DSP-BENCHMARK-2026-09-23.md), the results changed as follows:

| Same 28-recording development corpus | Previous detector | Updated detector |
| --- | ---: | ---: |
| Exact primary key | 11/28 (39.3%) | 14/28 (50.0%) |
| Incorrect primary key | 13/28 | 9/28 |
| Inconclusive key | 4/28 | 5/28 |
| Recordings receiving a primary estimate | 24/28 | 23/28 |

The files and reference labels were unchanged. This narrow guitar corpus was
used to compare published profile choices during development, so it is **not a
held-out evaluation**. Attempts to acquire a fresh holdout failed with HTTP 502;
no new recordings were added. The result supports improvement on this cohort,
not 50% or 100% accuracy across a producer's mixed library. Unpitched real-audio
false positives remain unmeasured because the corpus has no negative recordings.

Key DSP itself also took less time on the measured 12-second, 22,050 Hz mono
fixture: median **19.5561 ms → 14.2022 ms**, a **27.4% reduction**, over nine
alternating runs after warmup. This isolates the key calculation and excludes
decoding and coordination; it should not be added to the decode reduction below
or represented as an overall app speedup.

The existing strict historical test remains **20/22**, with two unresolved
relative-key cases. Its expected answers were not relaxed. Improving broader
fixtures does not establish that every previously difficult excerpt is fixed.

The spectral-peak approach follows the documented
[parabolic interpolation principle](https://essentia.upf.edu/reference/std_SpectralPeaks.html).
The profile choice is grounded in
[Ibrahim Shaath's key-estimation research](https://www.ibrahimshaath.co.uk/keyfinder/KeyFinder.pdf),
with numerical values checked against the published Shaath tables in
[Essentia's key implementation](https://github.com/MTG/essentia/blob/master/src/algorithms/tonal/key.cpp).
Sonic retains its own implementation and adds no external analysis dependency.

Use the Library's **Analyze** action to refresh missing results and records measured
by older analyzer versions. Manual corrections remain authoritative. The inspector now shows
candidate keys even for inconclusive results, so you can review alternatives
and deliberately choose one without discarding an unsaved BPM correction.

## Less repeated decoding before analysis

The analysis pipeline now shares decoded audio between its key and tempo passes
when they use the same window. This avoids starting FFmpeg again and writing a
second scratch file for identical audio.
The worker also reuses the decoded buffer and views little-endian PCM directly,
avoiding a second allocation and a per-sample copy. Corrupt partial samples are
rejected, and the recorded analysis duration counts distinct audio actually
decoded rather than counting overlapping planned windows twice.

| Controlled 133-second FLAC fixture | Previous pipeline | Updated pipeline |
| --- | ---: | ---: |
| Median decode and PCM-load time | 241.525 ms | 102.267 ms |
| FFmpeg processes | 2 | 1 |
| Scratch audio written | 18,963,000 bytes | 11,025,000 bytes |

Across five alternating repetitions on the test machine, decode and load time
fell **57.66%**, and scratch bytes fell **41.86%**. The key-analysis PCM was
identical between both paths. These results use a generated fixture and a warm
filesystem cache, and exclude the DSP calculation itself. They do not describe
total download time or an end-to-end app speedup.

Reproduce with `npm run benchmark:analysis`.

## Search the whole library and use the controls from the keyboard

Global command search previously stopped building track commands after the first
400 library records. It now searches the whole library and shows up to 60 matches
with a count and guidance to narrow a large result set. Searchable text is indexed
once; closing the palette or receiving queue-progress updates does not rebuild
the catalog. Selecting a result clears any retained Library filters or collection
that would hide it, reveals the track, and moves focus to its Preview control.

The palette exposes its active result through combobox/listbox semantics and
restores focus when confirmed or dismissed. Dropdowns open with Enter or Space
and support typing to jump to an option. Dialog descriptions are connected to
their controls, invalid metadata fields identify and focus the error, and
**Ctrl+Enter** saves corrections with status feedback.

Focused coverage includes a 20,000-command search fixture and a hidden
1,000-track application fixture. The latter finds track 999 and observes no
additional title reads through 20 queue-progress updates. These establish
complete search coverage and avoided catalog work, not a timed whole-library
rendering speedup. Keyboard behavior and browser accessibility semantics were
tested; a real screen-reader compatibility audit remains separate.

## Media setup stays responsive and stops cleanly

FFmpeg archive extraction previously used a synchronous subprocess in Electron's
main process. While extracting, Sonic could not handle main-process requests and
its interface could appear stuck. Extraction now runs asynchronously, with a
five-minute deadline and bounded diagnostic output. Closing Sonic cancels active
setup, waits for its owned temporary files to be cleaned up, and blocks new setup
work from starting during shutdown.

yt-dlp setup now requires a valid SHA-256 checksum for the platform before it
downloads a replacement. Missing or malformed manifests produce a useful retry
message. A checksum mismatch discards the download, and the existing installed
tool remains untouched.

## Interrupted downloads release their files

Network, cancellation, and disk errors now close both the incoming stream and the
output file before removing partial data. This matters on Windows, where an open
file handle can prevent cleanup or a retry. A request cancelled before it starts
makes no network request. An HTTP failure before output is opened preserves an
existing destination, and failed HTTP responses release their unread bodies.

The targeted `tests/engine-download.test.mjs` suite passes **15/15** cases. It uses
local HTTP responses, temporary files, controlled disk errors, and isolated media
tool doubles. Coverage includes cancellation, disconnection, stalled transfers,
write failure, extraction timeout, setup shutdown, and checksum acceptance or
rejection. Node typechecking also passes. This does not claim a live engine
download or installation against the current upstream releases.

## Verify this change

Run from the repository root:

```powershell
npm run typecheck
npm run test:unit
npm run test:key -- --baseline-ref 67b42008119cf5c1d88603c558fe750635ab3ebb --report test-results/key-comparison.json
npm run test:ui:hidden
npm run benchmark:analysis
```

Validation completed for this change:

| Check | Result |
| --- | --- |
| Node and renderer typechecks | Pass |
| Complete unit suite | 181/181 pass |
| Complete hidden interface suite | 88 pass; two native-window checks skipped |
| Final rebuilt palette, editor, overlay, and analysis follow-up | 13/13 pass |
| Electron service regressions | 21/21 pass on the final build |
| Production build | Pass |

The full interface run preceded the last palette exit-animation refinement;
the 13 focused checks then passed against the final rebuilt source, including
the new immediate-inert regression. No failed interface checks were retried.
The original `npm run test:dsp` gate can also be reproduced; it still exits
nonzero for the two documented historical relative-key expectations.
The benchmark needs FFmpeg on `PATH`, or `SONIC_FFMPEG` set to its executable.
Hidden interface tests do not exercise native Windows window controls or pointer
input; those require the visible suite. No installed Windows release or live
network download is claimed by the checks in this report.

A Windows GitHub Actions workflow now runs typechecking, the complete unit suite,
the strict key-regression matrix, and a production build for pull requests and
updates to `main`. It has read-only repository permissions. The legacy DSP gate's
known failures are documented above and are not represented as a passing CI check.

### Reproducible evidence

The key reports identify exact source bytes and the same 28-recording manifest:

| Identity | SHA-256 |
| --- | --- |
| Updated DSP source | `95c7a93ca5ae4eacb0075c56320203bd1a42562acb19cbf457ade9659a7ddb36` |
| Previous DSP source | `db642859920c731344998e600591dee86ada09878ff684d3073f03fbce02cbbf` |
| GuitarSet manifest | `400d32719e0d590fb04e6e392c2be431ea17d86b2195ed3afa23d9d23db8abba` |

Local generated evidence is in `test-results/key-detection-final.json`,
`key-before-real.json`, `key-final-real.json`, `key-final-selftest.json`, and
`analysis-pipeline-benchmark.json`. These reports and the audio corpus are ignored
build artifacts; the committed scripts and benchmark documentation describe how
to reproduce them.

## Architecture observations

The existing separation between source metadata, audio estimates, and manual
corrections is worth preserving: a detector change must not overwrite a producer's
decision. So are read-only imported originals, content-based identity checks,
explicit storage failures, and one shared playback controller.

Two broader scaling opportunities remain separate from these fixes. Importing
many files still saves full library snapshots per track; batching those writes
needs to preserve acknowledged saves and recovery after a failed commit. Very
large filtered libraries still need dedicated measurements of mounted rows,
scrolling, and keyboard behavior before introducing viewport-based rendering.
The earlier [performance review](PERFORMANCE-REVIEW-2026-10-04.md) describes these
tradeoffs and its original measurements.
