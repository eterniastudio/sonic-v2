# Sonic improvement review — October 20, 2026

This review follows the [October 14 review](IMPROVEMENTS-2026-10-14.md). It fixes
bugs found in a full read of the app: links that would not queue, titles misread
as keys, renames that failed on external drives, missing tags, tempo octave errors,
and a slow library store. Measurements identify what they measure. Synthetic
fixtures are not evidence of accuracy on real music.

## Everyday fixes

- **Large pastes queue.** The intake panel sent the whole paste as one string, and
  main rejects strings longer than 4,096 characters, so about 90 or more links failed
  together. It now sends each parsed link, in batches of up to 1,000, and the toast
  counts links that were actually added.
- **Titles are no longer read as keys.** "Am I Dreaming", "I Am Music", "DM me on
  IG" and "10 AM upload" used to produce A minor, D major or A major. A compact key
  without an accidental must now sit beside a tempo token or between separators.
  `F#m`, `[Am]`, `| Cm |`, `140 BPM Am` and `Key: F#m` still parse.
- **Tempo text reads the right number.** "140 BPM 2024" produced 202 and
  "140 BPM 100% FREE" produced 100. Both now give 140. `beat_140bpm_F#m`,
  `KEY=Am`, `key:11A`, curly-quoted titles such as “Night”, and "Love (Key)"
  in templates are handled too.
- **A half- or double-time alternative stays with its tempo.** It now comes from the
  same source as the main tempo, and only when it is half or double that tempo.
- **Open folder works.** The handler checked for a file, so it always refused folders.
- **Startup errors are shown.** A failed startup no longer leaves "Opening your
  workspace…" on screen forever; the splash shows the error with Retry and Close.
- **Sonic closes after the window crashes or hangs.** Shutdown no longer stops new
  work before the window confirms playback was saved. If the window has crashed,
  that step is skipped. If saving fails, Sonic asks whether to keep it open or close
  anyway.
- **Analysis failures name the cause.** If every audio window fails to decode, the
  FFmpeg error is shown instead of "The analyser did not return a result."

## Files and edits are protected

- **No duplicate exports after a failed library save.** Exports were copied before
  checking whether the library could record them, so every retry wrote
  `Title (2).mp3`, `(3)` and so on. Sonic now checks first. A job whose record is
  waiting to be saved completes in place once **Retry saving** succeeds.
- **Renames work on exFAT, FAT32 and network drives.** If the drive cannot create
  hard links, the rename falls back to a move that refuses to overwrite.
- **Edits wait for the job to finish.** Editing a job while it converted left the old
  title in the tags and the new one in the file name, and edits after completion
  never reached the library. Download metadata now becomes read-only once conversion
  starts and points to the Library inspector.
- **Drafts are saved.** Notes, tags and BPM/key corrections are saved when you leave
  the field, switch tracks or close the inspector, instead of being discarded.
- **Other updates are no longer lost.** A rename no longer overwrites a source
  refresh or analysis status that finished while the file was being hashed.
- **Resuming after a crash ignores partial files.** Partial outputs and fragments
  are never picked as the source audio, and leftovers are cleaned at startup.
- **Simultaneous jobs with the same name** take the next free name instead of failing.

## Analysis (`sonic-dsp/4`)

Tempo now uses a smoothed onset envelope and fractional-lag refinement over up to 16
beat periods. It settles 3:2 readings by which reading repeats more regularly. The two
tempo methods are compared in the same 60–200 BPM band before the result is marked
as disagreeing. Reproduce with `npm run benchmark:tempo`.

| Synthetic tempo matrix, 132 cases (click, kick + off-beat hat, kit; 11 tempos 70–174; 14 s and 150 s; clean and swing/noise/jitter) | Previous | Updated |
| --- | ---: | ---: |
| Primary tempo within ±0.5 BPM | 53 | 128 |
| Right level, 0.5–2 BPM off | 53 | 0 |
| Wrong level (half / double / 2:3) | 26 (12 / 4 / 10) | 4 (0 / 4 / 0) |
| Expected tempo among primary or alternatives | 128 | 132 |
| Methods flagged as disagreeing | 118 | 2 |
| Triple-meter controls exact (16) | 8 | 16 |

The four remaining misses are clean 70 BPM kick/hat and kit patterns, now read as 140
with 70 as the alternative. They used to read 69.9, so this is a regression on those
cases. A clean kit at 70 is the same signal as a half-time beat at 140, and no rule was
added to force either reading. Median analysis time per window rose from 41 to 45 ms
(14 s) and from 441 to 502 ms (150 s).

**Key detection is unchanged.** The two difficult minor-loop cases ("Am F C G",
"Gm Eb Bb F") still return inconclusive, with the minor key as an alternative.
`npm run test:dsp` remains 20/22. Those loops are the same chords in the same
cyclic order as their relative-major pop loops, and the same progression as the 12
"balanced loops stay inconclusive" controls. Passing them would need a first-chord
rule or a threshold that breaks those controls. The 144-fixture key matrix is
144/144 before and after.

A single non-finite sample no longer makes a whole track count as silent.

Cached results are now keyed by analyzer and pipeline version. The Library's
**Analyze** count includes tracks measured by `sonic-dsp/3` or by an older pipeline.

## Tempo and key tags in every format

| Output | Before | After |
| --- | --- | --- |
| MP3 | ID3 `TBPM`/`TKEY` | unchanged |
| FLAC, Opus | non-standard `TBPM=`/`TKEY=` (Opus tags were also not read back) | Vorbis `BPM`/`INITIALKEY`, read back |
| WAV | dropped | ID3 chunk with `TBPM`/`TKEY` |
| M4A, including "original" | dropped | `tmpo` atom (whole BPM); FFmpeg cannot write an MP4 key atom |

Checked by round-tripping through FFmpeg 6 (`tests/export-tags.test.mjs`).

## Large libraries

- **Smaller, rarer writes.** The library store is written as compact JSON, and the
  backup hard-links the previous file where the drive allows it. Imports commit in
  batches. Transient "queued"/"analyzing" statuses are not written to disk.

  | `tests/storage-commit-benchmark.mjs` | Previous | Updated |
  | --- | ---: | ---: |
  | Import 1,000 files into a 5,000-track library | 498,681 ms, 1,000 commits | 974 ms, 4 commits |
  | Batch analysis, per track | 1,147 ms | 225 ms |
  | Library file size | 25.3 MB | 13.7 MB |

- **Windowed lists.** Library list and grid views, and queues, render a window of
  rows once they pass 150 items. The focused and revealed rows stay mounted.
  Closed dropdown menus are no longer mounted. Search input is deferred.
- **Search no longer replaces your sort.** Relevance applies only while a search is
  typed and is never saved, so a manual collection keeps its order.
- **Fewer repeated tool checks.** Tool locations are cached for 5 minutes. Playback
  identity is cached by file size, modification time and file id, so large files
  are not re-hashed on every play.

## Hardening

- The FFmpeg download is verified against the release's published SHA-256 checksums
  before extraction. The install fails if the checksum file or its entry is missing.
- The window can no longer set yt-dlp/FFmpeg paths through settings; only the native
  file picker can.
- A Content Security Policy `<meta>` tag backs up the response header.
- The smoke harness is unreachable in packaged builds.
- Cover art downloads atomically. Covers for removed jobs are pruned.

## Verification

On the Linux review machine, with a virtual display and the Electron sandbox disabled:

- `npm run typecheck` passes.
- `npm run test:unit` passes 230/230 (182 before).
- `npm run test:key` passes.
- `npm run build` passes.

The harness Playwright specs pass. The full-app specs need Windows binaries and were
run with Linux stand-ins, so Windows CI is the authoritative check.
