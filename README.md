# Sonic V2

A local-first Windows desktop workstation for turning authorised YouTube beat uploads
into organised, tagged, producer-ready audio files.

Built from the ground up as an Electron application — new architecture, new interface,
no code or design language carried over from the original Tauri build.

> **Use responsibly.** Sonic is for media you own or are authorised to download. It does
> not bypass DRM, authentication, private-video access, or geographic restrictions, and
> it is not affiliated with or endorsed by YouTube.

---

## What it does

| | |
| --- | --- |
| **Intake** | Paste one link or fifty. Sonic reads each one, shows you what it found, and queues it. |
| **Parse** | Tempo, key, Camelot position, detune and producer are read from the title, description and container tags — every value traceable to the exact substring that produced it. |
| **Review** | A four-layer metadata model (`declared → embedded → suggested → final`) keeps what the source said separate from what you decided. |
| **Export** | Eight recipes, a naming template with live preview, embedded tags, cover art, a versioned sidecar, and no-clobber publication. |
| **Library** | A searchable archive with waveform auditioning, tempo correction, filters and conservative deletion. |

Library cards show the credited producer when one is known, otherwise the saved YouTube channel. Right-click a beat to open its saved YouTube link, refresh an older channel name, rename the beat and audio file, reveal the file, or delete it. Source links and channel names are stored in the local `library.json` record; the sidecar carries the same source provenance when enabled. User profiles, downloads, and test artifacts are excluded from the source repository.

Export filenames include every known BPM and key even when a custom naming template omits those tokens. Later manual corrections and accepted analysis rename Sonic-owned audio safely, with collision suffixes and a matching sidecar. A rename leaves existing audio tags unchanged; **re-export** to rewrite tags. FL Studio can read specific WAV tempo-sync metadata, but a BPM printed in a filename does not by itself set the FL Studio project tempo. Check the BPM badge and set or confirm the project tempo when importing; Sonic's acoustic estimate can be inconclusive or wrong.

### Producer metadata Sonic understands

Sonic distinguishes **four independent ways** a tempo or key can arrive. They are never
conflated, and each value in the interface says which one produced it.

| | Capability | Where it comes from | Reliability |
| --- | --- | --- | --- |
| **A** | **Source text** | Parsed from the video title, description or filename (`144 BPM`, `F#m`, `prod. by …`) | Depends entirely on what the uploader wrote |
| **B** | **Embedded tag** | Read back from the file's own container tags (`TBPM`, `TKEY`, `artist`) | Depends on whoever tagged the file |
| **C** | **Audio estimate** | Measured from the decoded audio by the local analyser | Real signal analysis; reported with a quality indicator and can be inconclusive |
| **D** | **Manual correction** | Typed, tapped, or adopted by the producer | Authoritative — never overwritten by A, B or C |

**A and B are not evidence that C works.** A track whose title and tags contain no tempo or
key will show nothing at all until the audio itself is analysed — which is exactly the case
Sonic V2 is built to handle.

#### Reconciliation rules

- Authority order is **manual → source text → embedded tag → audio estimate**.
- Source text and tags are statements a human made about the track; an audio estimate is
  inference. Inference **fills gaps and never overrides a statement**.
- When they disagree, **both values are kept** and the disagreement is surfaced in the
  metadata inspector under *Source vs audio*, with the option to adopt the measured value.
- Uncertain results stay uncertain. Silence, noise, single-pitch material and very short
  clips produce an explicit **inconclusive** result rather than a plausible-looking default.
- Overrides are tracked **per field**. Editing a title no longer freezes the BPM and key
  fields, so a later analysis can still fill them.

#### What the analyser does

- Decodes once through ffmpeg to **22050 Hz mono** float PCM — no second download, no
  upload, no Python, no native module, no WASM, and no copyleft dependency.
- **Tempo:** spectral-flux onset envelope → autocorrelation *and* a comb filter, combined
  with an Ellis-2007 log-Gaussian tempo prior, then octave-aware peak picking. Half- and
  double-time readings are reported as alternatives rather than collapsed away.
- **Key:** a frequency-weighted pitch-class profile (1/f weighting, because the FFT is
  linear in frequency) → Krumhansl–Schmuckler correlation against all 24 rotated profiles,
  with a tuning estimate and the runner-up keys reported alongside the winner.
- Runs on a **worker thread**, so a multi-second analysis never blocks the UI, with bounded
  concurrency, cancellation, timeouts and scratch-file cleanup.
- Results are cached by **input hash + engine version**, and the stage order is
  download → tags → **analyze** → cover → convert → tag readback → publish, so accepted
  estimates reach the file name, the embedded tags and the sidecar.

#### Text declarations Sonic parses (capability A)

| Source text | Interpreted as |
| --- | --- |
| `144 BPM`, `BPM: 144`, `bpm 144` | `144` |
| `72 / 144 BPM` | `144` with a `72` half-time alternate |
| `F# minor`, `F#m`, `Key: F# minor` | `F# minor` / Camelot `11A` |
| `11A`, `Camelot: 11A` | `F# minor` / Camelot `11A` |
| `detuned -18 cents`, `-0.25 st` | `-18 ¢` / `-25 ¢` |
| `Tuning: A=432Hz` | `-31.8 ¢` |
| `prod. by NAME`, `prod NAME`, `beat by NAME` | producer credit |
| `"Quoted Beat Name" Type Beat` | clean title |
| `Trap`, `Drill`, `Jersey Club`, … | genre hint |

### Export recipes

`MP3 320` · `MP3 V0` · `M4A AAC 256` · `FLAC` · `WAV 44.1/24` · `WAV 48/24` · `Opus 192` ·
`Original stream`

Processed recipes can preserve channels or force stereo/mono, optionally normalise to a
LUFS target, and embed the reviewed metadata.

---

## Architecture

```
src/
├─ main/                    Electron main process — owns every privileged operation
│  ├─ index.ts              Bootstrap, CSP, lifecycle, single-instance lock
│  ├─ window.ts             Frameless window, state persistence, navigation policy
│  ├─ protocol.ts           Privileged `sonic-media:` scheme for local audio
│  ├─ ipc.ts                Typed IPC handlers
│  ├─ smoke.ts              Headless self-check (see Verification)
│  ├─ lib/                  JSON store, child-process runner, downloads, hashing
│  └─ services/             Engine, probe, acquire, transcode, publish, library, queue
├─ preload/index.ts         The only bridge into the renderer (contextBridge)
├─ shared/                  Types + pure logic used by both processes
│  ├─ domain.ts             Domain model
│  ├─ ipc.ts                Typed channel contract
│  ├─ metadata.ts           Declared-metadata parser
│  ├─ music.ts              Key / mode / Camelot wheel
│  ├─ presets.ts            ffmpeg argument builders
│  └─ template.ts           Naming templates + Windows-safe sanitisation
└─ renderer/src/
   ├─ styles/               Design tokens + vendored transitions.dev motion system
   ├─ components/ui/        Primitives
   ├─ components/motion/    transitions.dev state machines
   ├─ components/obsidian/  Ported ObsidianUI components
   ├─ components/aceternity/ Ported Aceternity UI components
   ├─ features/             download · library · settings
   └─ store/               Zustand store
```

### Trust boundary

The renderer cannot execute processes or touch arbitrary files. It talks to the main
process through one typed, allow-listed `contextBridge` surface (`window.sonic`), running
with `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.

- Local audio reaches the renderer only through `sonic-media://beat/<library-id>`, which
  the main process resolves against the library. The renderer never handles a file path.
- Tools are spawned with an argv array, never a shell string.
- The Content-Security-Policy is strict (`script-src 'self'`) for every build; only a real
  Vite dev server gets the relaxed policy that HMR needs.
- Camera, microphone, geolocation and notification permissions are denied outright.
- Sidecars record the file *name*, not the local path, so they stay safe to share.

---

## Getting started

**Requirements:** Windows 10/11 x64, Node.js 22+, pnpm.

```bash
pnpm install
pnpm dev            # Vite dev server + Electron with HMR
```

`yt-dlp` is not bundled. On first run Sonic shows a **Media engine setup** banner and
downloads it into its own app-data folder, verifying the download against the publisher's
`SHA2-256SUMS` manifest. FFmpeg is used from the managed folder or your `PATH`; if it is
missing on Windows, Sonic can fetch a static build for you.

### Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Dev server + Electron with hot reload |
| `pnpm build` | Build main, preload and renderer into `out/` |
| `pnpm start` | Preview the production build |
| `pnpm typecheck` | Typecheck the Node and web projects |
| `pnpm smoke` | Headless boot self-check (DOM, theme, parser, templates) |
| `pnpm reset:state -- --yes [--library] [--settings] [--all]` | Clear runtime state during development; never touches the engine or your exports |
| `pnpm package` | Unpacked Windows build in `release/` |
| `pnpm dist` | NSIS installer in `release/` |

### Verification

`pnpm smoke` boots the real application — window, preload bridge, IPC, services — drives
the actual UI, and writes a JSON report, exiting non-zero on any failure. It fails on
**any** console error or warning, not just exceptions. The groups:

| Check | What it proves |
| --- | --- |
| `boot` | The window renders, the preload bridge exists, no console errors or load failures |
| `metadataParser` | Five producer-title conventions parse to the exact expected tempo, key, Camelot, detune and producer |
| `namingTemplates` | Token rendering, including that empty tokens leave no orphaned `[BPM]` group |
| `pipeline` | A real YouTube download through acquire → convert → tag → publish → sidecar → fingerprint → library |
| `themes` | Dark → light → dark via a settings push, with distinct backgrounds and transitions.dev colour tokens at each step |
| `mediaProtocol` | The published file streams back through `sonic-media:` with the exact expected byte length |
| `previewTransport` | The UI is driven to open the Library, select the beat, and the decoder reaches `ready`, reports the correct duration, and paints its waveform canvases |
| `rendererIpc` | Real `window.sonic.invoke` calls: metadata edits bump the revision, a key edit derives Camelot, the naming preview renders, a library record is corrected, and an unknown channel is rejected by the preload allow-list |
| `deletionSafety` | A file tampered with after export is refused, the file survives, and record-only removal still works |

To include the download-dependent groups, point it at a source you are authorised to use:

```powershell
$env:SONIC_SMOKE_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
pnpm smoke
```

The report lands at `%APPDATA%\Sonic V2\smoke-report.json`, and each group is reported as
`pass`, `fail` or `skipped`. Without `SONIC_SMOKE_URL` the five download-dependent groups
report as `skipped` and the rest still run, so it doubles as a fast offline build gate.
`pnpm reset:state -- --yes --library --settings` clears the records it creates.

---

## Where your data lives

Everything stays on your machine. There is no account, no analytics and no conversion
backend.

| Path | Contents |
| --- | --- |
| `%APPDATA%\Sonic V2\settings.json` | Preferences |
| `%APPDATA%\Sonic V2\library.json` | Beat library records |
| `%APPDATA%\Sonic V2\queue.json` | Queue state, used for crash recovery |
| `%APPDATA%\Sonic V2\engine\` | Managed yt-dlp / FFmpeg binaries |
| `%APPDATA%\Sonic V2\staging\` | In-flight downloads and conversions |
| Your chosen export folder | Published audio, plus `.json/` sidecars |

The queue is mirrored to disk on a short debounce and every interrupted job is returned to
the queue on the next launch, so a hard exit loses at most a moment of progress.

---

## Design system

**Dark is the default; light is a full peer.** Both themes are driven by one set of
semantic CSS custom properties (`--sonic-*`) exposed to Tailwind v4 through `@theme inline`,
so components are written theme-agnostically. Five accent hues are available.

### transitions.dev

`npx transitions-dev add --free` pulls the library's reference set into `transitions/`
(32 recipes). Fifteen of those, plus the universal motion-token scale
(`--duration-*`, `--ease-*`, `--distance-*`, `--scale-*`, `--blur-*`), are vendored into
`renderer/src/styles/transitions.css`, and fourteen are wired into the interface — each
keeping its original `t-*` selectors and its `prefers-reduced-motion` guard:

| Transition | Used for |
| --- | --- |
| `menu-dropdown` | Format pickers, sort menus, cookie source |
| `modal` | Confirmations, delete flows |
| `tabs-sliding` | Segmented controls everywhere |
| `toggle` | Every switch in Settings |
| `toast` | Notification stack |
| `success-check` | Export confirmations, success toasts |
| `skeleton-reveal` | Library artwork and preview loading |
| `accordion` | Evidence, conflicts, token help |
| `icon-swap` | Theme toggle |
| `tooltip` | Icon hints |
| `number-pop-in` | Library counters |
| `card-tilt` | Library grid cards |
| `error-state-shake` | Rejected links |
| `text-states-swap` | Status labels |

`panel-reveal` is vendored and available, but no surface currently needs it — the
collapsible regions in Sonic all want height collapse, which `accordion` does and
`panel-reveal` does not.

The snippets ship light-mode colour tokens only, so Sonic restates them per theme in
`styles/index.css`. Geometry tokens are left untouched — except `--toggle-travel`, which is
set inline on the switch to match its own dimensions.

`components/motion/usePresence.ts` implements the two-class open/close state machine those
snippets require, reading real durations from the tokens rather than hardcoding them.

### ObsidianUI

Ported and adapted to Sonic's tokens: **Apple Spotlight** (⌘K command palette and beat
search), **Arrow Fill Button**, **Jelly Loader**, **Folder Preview** (export destination),
**Draggable Marquee** (format strip), **Flip Text**, **Glowing Scroll Indicator**.

### Aceternity UI

Ported and adapted: **Stateful Button** (idle → loading → success CTA), **Multi Step
Loader** (engine setup and export pipeline), **Ambient Background** (aurora + sparkles +
grid compositions), **Card Spotlight**, **Animated Tooltip** (list-row previews), **Bento
Grid** (library statistics).

---

## Local-first, not offline

Network access happens only when you inspect or download a link, when the media engine is
being installed, or when a thumbnail is fetched. Nothing else leaves the machine.

## License

Source-available. See `LICENSE`.
