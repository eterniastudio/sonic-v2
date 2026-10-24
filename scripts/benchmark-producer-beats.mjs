#!/usr/bin/env node
/**
 * Producer-style synthetic beats: drums, 808 and harmony mixed the way type
 * beats are, with an optional same-process baseline comparison.
 *
 *   node scripts/benchmark-producer-beats.mjs [--baseline-ref REF] [--report PATH] [--only ID-PREFIX]
 *
 * Each fixture is rendered from a genre pattern (trap, drill, boom bap, lo-fi,
 * house, afro, dembow, jersey club, shuffle) at a stated BPM and key. The
 * stated values follow producer labelling conventions — trap and drill are
 * labelled at the hi-hat-driven 130–160 rate even though their snare lands
 * once per bar — and are held by this script only: estimateTempo/estimateKey
 * receive PCM, sample rate and duration, exactly as in the app. Windows follow
 * planWindows (8 s intro skip, ≤150 s tempo, ≤90 s key).
 *
 * Scoring:
 *   tempo  exact      primary within ±1 BPM of the label
 *          octave     primary is the label ×2 or ×½ (±2%) — usable, not exact
 *          other      any other primary
 *          inconclusive
 *          and separately whether the label appears among primary+alternatives.
 *   key    exact / relative (relative major/minor) / other / inconclusive, and
 *          whether an inconclusive result keeps the label among alternatives.
 * Negative controls (noise, a sine, a held chord without rhythm, a 4 s clip,
 * drums with no pitched content for key) must stay inconclusive.
 *
 * These are controlled engineering fixtures, not real productions; they are
 * harder than benchmark-tempo.mjs (syncopated kicks, half-time snares,
 * 16th/triplet hat rolls, swing, sliding 808s, sparse intros, detuning) but
 * remain evidence about the algorithm, not about accuracy on real beats.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
/** Run as a script (not imported by tests/analysis-producer-detection.test.mjs). */
const isMain = process.argv[1] != null && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
const options = {}
for (let i = 2; isMain && i < process.argv.length; i += 2) {
  const name = process.argv[i]
  const value = process.argv[i + 1]
  if (!['--baseline-ref', '--report', '--only'].includes(name) || !value || options[name]) {
    throw new Error('Expected --baseline-ref REF, --report PATH and/or --only PREFIX')
  }
  options[name] = value
}

const RATE = 22050
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------------------------------------------------------------- voices -- */

function add(buffer, index, value) {
  if (index >= 0 && index < buffer.length) buffer[index] += value
}

function kick(buffer, time, gain) {
  const start = Math.round(time * RATE)
  let phase = 0
  for (let i = 0, n = Math.round(0.28 * RATE); i < n; i += 1) {
    const t = i / RATE
    const hz = 48 + 90 * Math.exp(-t / 0.03)
    phase += (2 * Math.PI * hz) / RATE
    add(buffer, start + i, Math.sin(phase) * gain * Math.exp(-t / 0.09) + (i < 40 ? gain * 0.4 * (1 - i / 40) : 0))
  }
}

function snare(buffer, time, gain, random, clap = false) {
  const start = Math.round(time * RATE)
  const bursts = clap ? [0, 0.011, 0.022] : [0]
  for (const burst of bursts) {
    let previous = 0
    const offset = start + Math.round(burst * RATE)
    for (let i = 0, n = Math.round((clap ? 0.12 : 0.16) * RATE); i < n; i += 1) {
      const t = i / RATE
      const white = random() * 2 - 1
      const bright = white - previous * 0.6
      previous = white
      add(buffer, offset + i, bright * gain * 0.6 * Math.exp(-t / (clap ? 0.025 : 0.045)) / bursts.length ** 0.5)
    }
  }
  if (!clap) {
    for (let i = 0, n = Math.round(0.09 * RATE); i < n; i += 1) {
      const t = i / RATE
      add(buffer, start + i, Math.sin(2 * Math.PI * 190 * t) * gain * 0.5 * Math.exp(-t / 0.03))
    }
  }
}

function hat(buffer, time, gain, random, open = false) {
  const start = Math.round(time * RATE)
  let previous = 0
  for (let i = 0, n = Math.round((open ? 0.18 : 0.03) * RATE); i < n; i += 1) {
    const white = random() * 2 - 1
    add(buffer, start + i, (white - previous) * gain * 0.5 * Math.exp(-(i / RATE) / (open ? 0.06 : 0.008)))
    previous = white
  }
}

const midiHz = (midi, cents) => 440 * 2 ** ((midi - 69 + cents / 100) / 12)

/** Sustained 808: sine with soft saturation, optional glide into the next note. */
function bass808(buffer, time, duration, midi, cents, gain, glideTo = null) {
  const start = Math.round(time * RATE)
  let phase = 0
  const n = Math.round(duration * RATE)
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE
    const target = glideTo == null ? midi : midi + (glideTo - midi) * Math.min(1, Math.max(0, (t - duration * 0.6) / (duration * 0.3)))
    phase += (2 * Math.PI * midiHz(target, cents)) / RATE
    const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.9) * Math.min(1, (duration - t) / 0.02)
    add(buffer, start + i, Math.tanh(1.6 * Math.sin(phase)) * gain * env)
  }
}

/** Pad/keys chord: few-partial tones, soft attack, per-voice phase offsets. */
function chord(buffer, time, duration, midis, cents, gain, partials = [1, 0.45, 0.25, 0.12]) {
  const start = Math.round(time * RATE)
  const n = Math.round(duration * RATE)
  for (const [voice, midi] of midis.entries()) {
    const hz = midiHz(midi, cents)
    for (let h = 1; h <= partials.length; h += 1) {
      if (hz * h > RATE * 0.45) break
      const step = (2 * Math.PI * hz * h) / RATE
      const amplitude = gain * partials[h - 1]
      for (let i = 0; i < n; i += 1) {
        const t = i / RATE
        const env = Math.min(1, t / 0.06, (duration - t) / 0.08)
        add(buffer, start + i, amplitude * Math.sin(step * i + voice * 1.7 + h) * env)
      }
    }
  }
}

/** Plucked melody note. */
function pluck(buffer, time, duration, midi, cents, gain) {
  const start = Math.round(time * RATE)
  const hz = midiHz(midi, cents)
  for (let h = 1; h <= 5; h += 1) {
    if (hz * h > RATE * 0.45) break
    const step = (2 * Math.PI * hz * h) / RATE
    for (let i = 0, n = Math.round(duration * RATE); i < n; i += 1) {
      const t = i / RATE
      add(buffer, start + i, gain * (0.6 / h) * Math.sin(step * i) * Math.min(1, t / 0.003) * Math.exp(-t / (0.35 / h)))
    }
  }
}

function finalise(buffer) {
  let max = 0
  for (let i = 0; i < buffer.length; i += 1) max = Math.max(max, Math.abs(buffer[i]))
  if (max > 1e-9) for (let i = 0; i < buffer.length; i += 1) buffer[i] = Math.tanh((buffer[i] / max) * 1.2) * 0.8
  return buffer
}

/* ------------------------------------------------------------- harmony -- */

// Scale degrees in semitones above the tonic. Minor progressions use the
// natural-minor (flat-seventh) chords producers loop.
const PROGRESSIONS = {
  'i-VII-VI-VII': { mode: 'minor', chords: [[0, 3, 7], [-2, 2, 5], [-4, 0, 3], [-2, 2, 5]], roots: [0, -2, -4, -2] },
  'i-iv-VII-III': { mode: 'minor', chords: [[0, 3, 7], [5, 8, 12], [-2, 2, 5], [3, 7, 10]], roots: [0, 5, -2, 3] },
  'i-VI-III-VII': { mode: 'minor', chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], roots: [0, -4, 3, -2] },
  'i-v-VI-iv': { mode: 'minor', chords: [[0, 3, 7], [7, 10, 14], [-4, 0, 3], [5, 8, 12]], roots: [0, 7, -4, 5] },
  'i-i-VI-v': { mode: 'minor', chords: [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-5, -2, 2]], roots: [0, 0, -4, -5] },
  'I-V-vi-IV': { mode: 'major', chords: [[0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0]], roots: [0, 7, -3, 5] },
  'I-vi-IV-V': { mode: 'major', chords: [[0, 4, 7], [-3, 0, 4], [-7, -3, 0], [-5, -1, 2]], roots: [0, -3, 5, 7] },
  'ii-V-I-I': { mode: 'major', chords: [[2, 5, 9], [-5, -1, 2, 5], [0, 4, 7, 11], [0, 4, 7, 11]], roots: [2, 7, 0, 0] }
}
const MINOR_PENTATONIC = [0, 3, 5, 7, 10]
const MAJOR_PENTATONIC = [0, 2, 4, 7, 9]

/* -------------------------------------------------------------- grooves -- */

/**
 * Drum grooves on a 16th grid per 4/4 bar, `beat` = one quarter note at the
 * label BPM. Each returns nothing; it writes into `buffer`.
 */
const GROOVES = {
  // Half-time trap: snare on beat 3, syncopated kick, 8th hats with 16th and
  // 16th-triplet rolls at the end of every second bar.
  trap(buffer, bar, t0, beat, random) {
    const s = beat / 4
    for (const step of bar % 2 ? [0, 7, 10] : [0, 3, 11, 14]) kick(buffer, t0 + step * s, 0.9)
    snare(buffer, t0 + 8 * s, 0.75, random, true)
    for (let step = 0; step < 16; step += 2) hat(buffer, t0 + step * s, step % 4 ? 0.22 : 0.3, random)
    if (bar % 2) {
      for (let k = 0; k < 6; k += 1) hat(buffer, t0 + 12 * s + (k * 4 * s) / 6, 0.18, random)
    } else {
      hat(buffer, t0 + 13 * s, 0.18, random)
      hat(buffer, t0 + 15 * s, 0.18, random)
    }
  },
  // UK/NY drill: snare on beat 3 and the last 16th-triplet before beat 1 of
  // alternate bars, triplet-skipping hats.
  drill(buffer, bar, t0, beat, random) {
    const s = beat / 4
    for (const step of bar % 2 ? [0, 6, 11] : [0, 10]) kick(buffer, t0 + step * s, 0.85)
    snare(buffer, t0 + 8 * s, 0.75, random)
    if (bar % 2) snare(buffer, t0 + 15 * s, 0.5, random)
    const triplet = beat / 3
    for (let k = 0; k < 12; k += 1) if (k % 3 !== 1 || k > 8) hat(buffer, t0 + k * triplet, k % 3 === 0 ? 0.28 : 0.18, random)
  },
  // Boom bap with swung 16th hats.
  boombap(buffer, bar, t0, beat, random) {
    const s = beat / 4
    const swing = (step) => (step % 2 ? s * 0.22 : 0)
    for (const step of [0, 6, 10]) kick(buffer, t0 + step * s + swing(step), 0.95)
    for (const step of [4, 12]) snare(buffer, t0 + step * s, 0.8, random)
    for (let step = 0; step < 16; step += 1) hat(buffer, t0 + step * s + swing(step), step % 2 ? 0.12 : 0.24, random)
  },
  // Lo-fi with a triplet (shuffle) 8th-note swing.
  lofi(buffer, bar, t0, beat, random) {
    for (const [b, frac] of [[0, 0], [1, 2 / 3], [2, 1 / 3]]) kick(buffer, t0 + (b + frac) * beat, 0.8)
    for (const b of [1, 3]) snare(buffer, t0 + b * beat, 0.6, random)
    for (let b = 0; b < 4; b += 1) {
      hat(buffer, t0 + b * beat, 0.22, random)
      hat(buffer, t0 + (b + 2 / 3) * beat, 0.14, random)
    }
  },
  // R&B half-time at a stated slow tempo: snare on 2 and 4, 16th hats.
  rnb(buffer, bar, t0, beat, random) {
    const s = beat / 4
    for (const step of [0, 7, 10]) kick(buffer, t0 + step * s, 0.85)
    for (const step of [4, 12]) snare(buffer, t0 + step * s, 0.7, random, true)
    for (let step = 0; step < 16; step += 1) hat(buffer, t0 + step * s, step % 4 === 0 ? 0.22 : 0.13, random)
  },
  house(buffer, bar, t0, beat, random) {
    for (let b = 0; b < 4; b += 1) {
      kick(buffer, t0 + b * beat, 0.95)
      hat(buffer, t0 + (b + 0.5) * beat, 0.25, random, true)
    }
    for (const b of [1, 3]) snare(buffer, t0 + b * beat, 0.6, random, true)
  },
  // Afrobeats: 3+3+2 kick/rim figure and shaker 16ths.
  afro(buffer, bar, t0, beat, random) {
    const s = beat / 4
    for (const step of [0, 3, 6, 8, 11, 14]) kick(buffer, t0 + step * s, step % 8 ? 0.6 : 0.9)
    for (const step of [3, 6, 11, 14]) snare(buffer, t0 + step * s, 0.35, random)
    for (let step = 0; step < 16; step += 1) hat(buffer, t0 + step * s, step % 2 ? 0.1 : 0.18, random)
  },
  // Dembow: kick on every beat, snare on 3e and 4&.
  dembow(buffer, bar, t0, beat, random) {
    const s = beat / 4
    for (let b = 0; b < 4; b += 1) kick(buffer, t0 + b * beat, 0.9)
    for (const step of [3, 6, 11, 14]) snare(buffer, t0 + step * s, 0.6, random)
    for (let step = 0; step < 16; step += 2) hat(buffer, t0 + step * s, 0.15, random)
  },
  // Jersey club: kicks on 1, 2, 3, 3a(-ish), 4& in quintuplet-like bounce.
  jersey(buffer, bar, t0, beat, random) {
    const s = beat / 4
    for (const step of [0, 4, 8, 11, 14]) kick(buffer, t0 + step * s, 0.9)
    for (const step of [4, 12]) snare(buffer, t0 + step * s, 0.55, random, true)
    for (let step = 0; step < 16; step += 2) hat(buffer, t0 + step * s, 0.14, random)
  },
  // Shuffle: 12/8 feel at the quarter-note label, triplet hats, backbeat.
  shuffle(buffer, bar, t0, beat, random) {
    for (const b of [0, 2]) kick(buffer, t0 + b * beat, 0.9)
    kick(buffer, t0 + (2 + 2 / 3) * beat, 0.6)
    for (const b of [1, 3]) snare(buffer, t0 + b * beat, 0.7, random)
    for (let k = 0; k < 12; k += 1) hat(buffer, t0 + (k * beat) / 3, k % 3 === 0 ? 0.24 : k % 3 === 2 ? 0.16 : 0.07, random)
  }
}

/**
 * Renders one beat. `introBars` bars of harmony-only (no drums, no 808) open
 * the track, like a producer tag/pad intro; `outroBars` of pad close it.
 */
function renderBeat(spec, seed) {
  const random = makeRandom(seed)
  const seconds = spec.seconds
  const buffer = new Float32Array(Math.round(seconds * RATE))
  const beat = 60 / spec.bpm
  const barSec = beat * 4
  const progression = PROGRESSIONS[spec.progression]
  const tonicMidi = 48 + spec.tonic // C3 + tonic
  const cents = spec.cents ?? 0
  const bars = Math.ceil(seconds / barSec)
  const scale = progression.mode === 'minor' ? MINOR_PENTATONIC : MAJOR_PENTATONIC
  const melodyRandom = makeRandom(seed + 7)
  for (let bar = 0; bar < bars; bar += 1) {
    const t0 = bar * barSec
    const chordIndex = Math.floor(bar / (spec.barsPerChord ?? 1)) % progression.chords.length
    const tones = progression.chords[chordIndex]
    const root = progression.roots[chordIndex]
    const inIntro = bar < (spec.introBars ?? 0)
    const inOutro = bar >= bars - (spec.outroBars ?? 0)
    const drums = !inIntro && !inOutro && !spec.noDrums
    if (!spec.noHarmony) {
      if (spec.harmony !== 'melody-only') chord(buffer, t0, barSec, tones.map((tone) => tonicMidi + 12 + tone), cents, spec.padGain ?? 0.05)
      if (spec.harmony !== 'pad-only') {
        // A pentatonic pluck melody: eighth notes, deterministic.
        for (let k = 0; k < 8; k += 1) {
          if (melodyRandom() < 0.35) continue
          const degree = scale[Math.floor(melodyRandom() * scale.length)]
          pluck(buffer, t0 + k * beat / 2, beat / 2, tonicMidi + 24 + degree, cents, spec.melodyGain ?? 0.06)
        }
      }
    }
    if (drums) {
      GROOVES[spec.groove](buffer, bar, t0, beat, random)
      if (!spec.noHarmony && !spec.no808) {
        const midi = tonicMidi - 12 + ((root % 12) + 12) % 12 - (root > 5 ? 12 : 0)
        const glide = spec.slide808 && bar % 2 ? midi + 12 : null
        bass808(buffer, t0, barSec * 0.95, midi, cents, spec.bassGain ?? 0.35, glide)
      }
    }
  }
  if (spec.noise) {
    const noise = makeRandom(seed + 31)
    for (let i = 0; i < buffer.length; i += 1) buffer[i] += (noise() * 2 - 1) * spec.noise
  }
  return finalise(buffer)
}

/* --------------------------------------------------------------- cases -- */

const CASES = []
let counter = 0
const push = (spec) => CASES.push({ id: `p${String(++counter).padStart(3, '0')}`, seconds: 75, ...spec })
const keyName = (tonic, mode) => `${NAMES[((tonic % 12) + 12) % 12]} ${mode}`

// Tempo-led cases: label is the producer convention for the genre.
const GENRE_TEMPOS = [
  ['trap', [130, 140, 150, 160]],
  ['drill', [140, 142, 144]],
  ['boombap', [85, 90, 95]],
  ['lofi', [72, 80, 88]],
  ['rnb', [64, 70]],
  ['house', [122, 124, 128]],
  ['afro', [100, 105, 110]],
  ['dembow', [92, 96]],
  ['jersey', [140, 145]],
  ['shuffle', [96, 112]]
]
const KEY_ROTATION = [9, 2, 7, 0, 5, 10, 3, 8, 1, 6, 11, 4]
const MINOR_LOOPS = ['i-VII-VI-VII', 'i-iv-VII-III', 'i-v-VI-iv', 'i-i-VI-v']
let rotation = 0
for (const [groove, tempos] of GENRE_TEMPOS) {
  for (const bpm of tempos) {
    const tonic = KEY_ROTATION[rotation % 12]
    const progression = groove === 'house' && bpm === 124 ? 'I-V-vi-IV' : groove === 'afro' && bpm === 105 ? 'I-vi-IV-V' : MINOR_LOOPS[rotation % MINOR_LOOPS.length]
    rotation += 1
    push({ group: groove, groove, bpm, tonic, progression, slide808: groove === 'drill', key: keyName(tonic, PROGRESSIONS[progression].mode) })
  }
}
// Harder conditions.
push({ group: 'sparse-intro', groove: 'trap', bpm: 140, tonic: 4, progression: 'i-VII-VI-VII', introBars: 12, key: 'E minor' })
push({ group: 'sparse-intro', groove: 'boombap', bpm: 90, tonic: 2, progression: 'i-iv-VII-III', introBars: 8, key: 'D minor' })
push({ group: 'sparse-intro', groove: 'drill', bpm: 144, tonic: 6, progression: 'i-v-VI-iv', introBars: 16, slide808: true, key: 'F# minor' })
push({ group: 'detuned-432', groove: 'trap', bpm: 145, tonic: 9, progression: 'i-VII-VI-VII', cents: -31.77, key: 'A minor' })
push({ group: 'detuned-432', groove: 'lofi', bpm: 82, tonic: 0, progression: 'ii-V-I-I', cents: -31.77, key: 'C major' })
push({ group: 'detuned-432', groove: 'drill', bpm: 141, tonic: 11, progression: 'i-iv-VII-III', cents: -31.77, slide808: true, key: 'B minor' })
push({ group: 'noisy-mix', groove: 'trap', bpm: 136, tonic: 1, progression: 'i-VII-VI-VII', noise: 0.05, key: 'C# minor' })
push({ group: 'noisy-mix', groove: 'boombap', bpm: 93, tonic: 5, progression: 'i-iv-VII-III', noise: 0.05, key: 'F minor' })
push({ group: 'drum-heavy', groove: 'trap', bpm: 150, tonic: 7, progression: 'i-VII-VI-VII', padGain: 0.025, melodyGain: 0.03, key: 'G minor' })
push({ group: 'drum-heavy', groove: 'drill', bpm: 143, tonic: 3, progression: 'i-i-VI-v', padGain: 0.025, melodyGain: 0.03, slide808: true, key: 'D# minor' })
push({ group: 'melody-808', groove: 'trap', bpm: 138, tonic: 10, progression: 'i-VII-VI-VII', harmony: 'melody-only', key: 'A# minor' })
push({ group: 'melody-808', groove: 'drill', bpm: 142, tonic: 8, progression: 'i-iv-VII-III', harmony: 'melody-only', slide808: true, key: 'G# minor' })
// Relative-ambiguous loops: either inconclusive with both, or the minor label.
for (const tonic of [9, 4, 2]) {
  push({ group: 'relative-loop', groove: 'trap', bpm: 140, tonic, progression: 'i-VI-III-VII', key: keyName(tonic, 'minor'), relativeOk: true })
}
// Negative controls.
push({ group: 'negative', kind: 'drums-only', groove: 'trap', bpm: 140, tonic: 0, progression: 'i-VII-VI-VII', noHarmony: true, key: null })
push({ group: 'negative', kind: 'pad-no-rhythm', groove: 'trap', bpm: 100, tonic: 9, progression: 'i-VII-VI-VII', noDrums: true, harmony: 'pad-only', key: 'A minor', bpmNegative: true })
push({ group: 'negative', kind: 'noise', synthetic: 'noise', bpm: null, key: null })
push({ group: 'negative', kind: 'sine', synthetic: 'sine', bpm: null, key: null })
push({ group: 'negative', kind: 'short-4s', groove: 'trap', bpm: 140, tonic: 9, progression: 'i-VII-VI-VII', seconds: 4, key: null, bpmNegative: true, shortClip: true })

function renderCase(spec, seed) {
  if (spec.synthetic === 'noise') {
    const random = makeRandom(seed)
    const out = new Float32Array(spec.seconds * RATE)
    for (let i = 0; i < out.length; i += 1) out[i] = (random() * 2 - 1) * 0.3
    return out
  }
  if (spec.synthetic === 'sine') {
    const out = new Float32Array(spec.seconds * RATE)
    for (let i = 0; i < out.length; i += 1) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE)
    return out
  }
  return renderBeat(spec, seed)
}

/** The app's planWindows geometry, reproduced for a known duration. */
function windows(total) {
  const introSkip = Math.min(8, total * 0.2)
  return {
    tempo: [introSkip, Math.max(6, Math.min(150, total - introSkip))],
    key: [introSkip, Math.max(6, Math.min(90, total - introSkip))]
  }
}

function slice(pcm, [offset, duration]) {
  const from = Math.min(pcm.length, Math.round(offset * RATE))
  return pcm.subarray(from, Math.min(pcm.length, from + Math.round(duration * RATE)))
}

/* ------------------------------------------------------------- scoring -- */

function classifyTempo(analysis, spec) {
  const expected = spec.bpm
  const negative = spec.bpm == null || spec.bpmNegative
  if (analysis.status !== 'estimated' || analysis.bpm == null) return negative ? 'pass-inconclusive' : 'inconclusive'
  if (negative) return 'false-positive'
  const bpm = analysis.bpmExact ?? analysis.bpm
  if (Math.abs(bpm - expected) <= 1) return 'exact'
  if ([0.5, 2].some((r) => Math.abs(bpm / (expected * r) - 1) <= 0.02)) return 'octave'
  return 'other'
}

function tempoInCandidates(analysis, expected) {
  if (expected == null || analysis.status !== 'estimated') return false
  return [analysis.bpmExact ?? analysis.bpm, ...analysis.alternatives.map((a) => a.bpm)].some((v) => v != null && Math.abs(v - expected) <= 1.5)
}

function relativeOf(key) {
  const [name, mode] = key.split(' ')
  const pc = NAMES.indexOf(name)
  return mode === 'major' ? `${NAMES[(pc + 9) % 12]} minor` : `${NAMES[(pc + 3) % 12]} major`
}

function classifyKey(analysis, spec) {
  if (spec.key == null) return analysis.status === 'estimated' ? 'false-positive' : 'pass-inconclusive'
  if (analysis.status !== 'estimated' || analysis.key == null) {
    const kept = analysis.alternatives.some((a) => a.key === spec.key)
    return spec.relativeOk && kept ? 'pass-ambiguous' : kept ? 'inconclusive-kept' : 'inconclusive'
  }
  if (analysis.key === spec.key) return 'exact'
  if (analysis.key === relativeOf(spec.key)) return 'relative'
  return 'other'
}

/* ---------------------------------------------------------------- main -- */

async function bundle(source, filename, directory) {
  const output = path.join(directory, filename)
  await build({ stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'src/main/analysis') }, outfile: output, bundle: true, format: 'esm', platform: 'neutral', target: 'node22', logLevel: 'silent' })
  return import(pathToFileURL(output).href)
}

function tally(rows, field) {
  const tempo = {}
  const key = {}
  let tempoCandidates = 0
  let tempoPositives = 0
  let tempoMs = 0
  let keyMs = 0
  for (const row of rows) {
    const result = row[field]
    if (!result) continue
    tempo[result.tempo] = (tempo[result.tempo] ?? 0) + 1
    key[result.key] = (key[result.key] ?? 0) + 1
    if (row.bpm != null && !row.bpmNegative) {
      tempoPositives += 1
      if (result.tempoInCandidates) tempoCandidates += 1
    }
    tempoMs += result.tempoMs
    keyMs += result.keyMs
  }
  return { tempo, key, tempoCandidates, tempoPositives, tempoMs: Number(tempoMs.toFixed(1)), keyMs: Number(keyMs.toFixed(1)) }
}

export { CASES, RATE, renderCase, windows, slice, classifyTempo, classifyKey, tempoInCandidates }

const hash = (source) => createHash('sha256').update(source).digest('hex')
if (isMain) await main()

async function main() {
const temporary = await mkdtemp(path.join(tmpdir(), 'sonic-producer-beats-'))
try {
  const source = await readFile(path.join(root, 'src/main/analysis/dsp.ts'), 'utf8')
  const current = await bundle(source, 'current.mjs', temporary)
  const baselineSource = options['--baseline-ref']
    ? execFileSync('git', ['show', `${options['--baseline-ref']}:src/main/analysis/dsp.ts`], { cwd: root, encoding: 'utf8', maxBuffer: 8e6, windowsHide: true })
    : null
  const baseline = baselineSource ? await bundle(baselineSource, 'baseline.mjs', temporary) : null
  const report = {
    schema: 'sonic-producer-beats/1',
    source: { currentSha256: hash(source), baselineSha256: baselineSource ? hash(baselineSource) : null, baselineRef: options['--baseline-ref'] ?? null },
    rules: { exactToleranceBpm: 1, octaveTolerance: '±2% of ×½ or ×2', labelsReachDsp: false, fixtureType: 'synthetic producer-style', sampleRate: RATE },
    rows: []
  }
  const selected = options['--only'] ? CASES.filter((c) => c.id.startsWith(options['--only']) || c.group === options['--only']) : CASES
  let seed = 5000
  for (const spec of selected) {
    seed += 1
    const pcm = renderCase(spec, seed)
    const plan = windows(spec.seconds)
    const tempoInput = { pcm: slice(pcm, plan.tempo), sampleRate: RATE, sourceDurationSec: spec.seconds }
    const keyInput = { pcm: slice(pcm, plan.key), sampleRate: RATE, sourceDurationSec: spec.seconds }
    const row = { id: spec.id, group: spec.group, kind: spec.kind ?? spec.groove ?? null, bpm: spec.bpm, bpmNegative: Boolean(spec.bpmNegative), key: spec.key }
    for (const [field, implementation] of [['current', current], ['baseline', baseline]]) {
      if (!implementation) continue
      let started = performance.now()
      const tempo = implementation.estimateTempo(tempoInput)
      const tempoMs = performance.now() - started
      started = performance.now()
      const key = implementation.estimateKey(keyInput)
      const keyMs = performance.now() - started
      row[field] = {
        tempo: classifyTempo(tempo, spec),
        tempoInCandidates: tempoInCandidates(tempo, spec.bpm),
        bpm: tempo.bpmExact ?? tempo.bpm,
        tempoAlternatives: tempo.alternatives.map((a) => `${a.bpm}${a.relation[0]}`),
        tempoConfidence: tempo.confidence,
        key: classifyKey(key, spec),
        estimatedKey: key.key,
        keyAlternatives: key.alternatives.map((a) => a.key),
        keyConfidence: key.confidence,
        tuningCents: key.tuningCents,
        tempoMs,
        keyMs
      }
    }
    report.rows.push(row)
    const show = (r) => r ? `${String(r.bpm == null ? '—' : r.bpm.toFixed(1)).padStart(6)} ${r.tempo.padEnd(17)} ${String(r.estimatedKey ?? '—').padEnd(9)} ${r.key.padEnd(17)}` : ''
    console.log(`${row.id} ${row.group.padEnd(13)} ${String(row.kind).padEnd(13)} ${String(row.bpm ?? '—').padStart(4)} ${String(row.key ?? '—').padEnd(9)} | now ${show(row.current)}${baseline ? `| before ${show(row.baseline)}` : ''}`)
  }
  report.summary = { current: tally(report.rows, 'current'), baseline: baseline ? tally(report.rows, 'baseline') : null }
  const groups = {}
  for (const row of report.rows) (groups[row.group] ??= []).push(row)
  report.groups = Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, { current: tally(rows, 'current'), baseline: baseline ? tally(rows, 'baseline') : null }]))
  console.log(JSON.stringify(report.summary, null, 2))
  if (options['--report']) {
    const output = path.resolve(options['--report'])
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
}
