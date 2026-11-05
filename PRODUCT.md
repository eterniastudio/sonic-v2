# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Electron desktop app for Windows 10/11; the renderer is a React + Tailwind v4 web surface in a frameless window.)

## Users

Beatmakers and music producers on Windows. They pull reference beats and samples from YouTube and SoundCloud, confirm tempo and key, and drag the tagged files into their DAW (FL Studio most often). Sonic usually runs next to the DAW during long, often late-night sessions in a dim studio.

## Product Purpose

Turn authorised YouTube and SoundCloud tracks into organised, tagged, producer-ready audio files, and keep a local library of them to audition, annotate, collect, analyse, and re-export. Success: a producer pastes links, trusts the BPM/key that comes back, and has a correctly named file in their DAW within seconds.

## Positioning

Sonic keeps every tempo and key value traceable to where it came from: source text, embedded tag, local audio estimate, or manual correction, kept as separate layers (`declared → embedded → suggested → final`) with manual always authoritative. It shows disagreements instead of hiding them, and reports inconclusive analysis instead of guessing.

## Operating Context

- Intake: paste one or many links; YouTube playlists open a selection review; SoundCloud share links resolve first.
- Review: metadata inspector per job; source-vs-audio disagreements; adopt measured values.
- Export: eight recipes (MP3 320, MP3 V0, M4A AAC 256, FLAC, WAV 44.1/24, WAV 48/24, Opus 192, original), naming template with live preview, embedded tags, cover art, sidecar.
- Library: import local audio, persistent playback dock, notes, tags, collections/playlists, batch analyse/export, reconnect missing files.
- Global command palette (Ctrl+K). Frameless window with a custom title bar.

## Capabilities and Constraints

- Local-first; no accounts, no cloud. Strict CSP: fonts and scripts must be bundled locally (no hosted font stylesheets).
- Renderer never touches file paths; audio arrives through `sonic-media://`.
- Styling stack stays Tailwind v4 with CSS custom-property tokens (the "SASS redesign" request means a full visual redesign, not a Sass/SCSS migration).
- Existing Playwright UI tests reference roles, labels, and some test ids; behavior and accessible names must survive the redesign.
- Does not bypass DRM, authentication, private access, or geo-restrictions.

## Brand Commitments

- Name "Sonic" and the level-meter logo mark stay.
- Light and dark themes both remain first-class.
- The five-accent picker and the current sidebar/dock layout are not binding.

## Evidence on Hand

No testimonials, user counts, or press. Do not invent any. Measured analyser accuracy lives in `docs/IMPROVEMENTS-2026-10-14.md` and `docs/IMPROVEMENTS-2026-10-20.md`.

## Product Principles

1. Provenance over polish: every value says where it came from.
2. Uncertain stays uncertain; never fake confidence.
3. Stay out of the DAW's way: fast, quiet, keyboard-reachable.
4. The producer's corrections always win.

## Accessibility & Inclusion

Keep keyboard reachability, visible focus, reduced-motion support, and accessible names the existing test suite depends on.
