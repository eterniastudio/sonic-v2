#!/usr/bin/env node
/**
 * Sonic V2 — DSP self-test harness.
 *
 *   node scripts/dsp-selftest.mjs
 *
 * Loads `src/main/analysis/dsp.ts` by compiling it (plus its `shared/` imports)
 * to a temporary `.mjs` with the project's local esbuild, generating synthetic
 * audio fixtures in memory, and checking the estimates against known truth.
 *
 * Everything here is synthetic. A pass on this suite is evidence that the DSP
 * implements the intended algorithms correctly on clean, controlled material —
 * it is NOT evidence about accuracy on real recordings, which have real
 * tuning drift, real reverb, real percussion and real arrangement changes.
 *
 * Exit code: 0 when every REQUIRED case passes, 1 otherwise.
 */

import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* ========================================================================= */
/* Tolerances and thresholds — declared up front, echoed in the output         */
/* ========================================================================= */

/** Exact-match tolerance for tempo: |detected − expected| ≤ this. */
const TEMPO_EXACT_TOLERANCE_BPM = 2
/** A reading counts as half/double-equivalent when it is within ±2 BPM of the
 *  expected tempo, of half of it, or of double it. */
const TEMPO_OCTAVE_TOLERANCE_BPM = 2

const SAMPLE_RATE = 22050

/* ========================================================================= */
/* DSP loading — esbuild bundle                                              */
/* ========================================================================= */

const REQUIRED_EXPORTS = ['estimateTempo', 'estimateKey']

async function loadDsp() {
  const projectRoot = process.cwd()
  const require = createRequire(path.join(projectRoot, 'package.json'))

  let esbuild
  try {
    esbuild = require('esbuild')
  } catch (error) {
    throw new Error(
      `Could not load the project's local esbuild (expected at node_modules/esbuild).\n${error.message}`
    )
  }

  const entry = path.join(projectRoot, 'src', 'main', 'analysis', 'dsp.ts')
  const dir = await mkdtemp(path.join(tmpdir(), 'sonic-dsp-selftest-'))
  const outFile = path.join(dir, 'dsp.mjs')

  try {
    // Bundle dsp.ts *and* its relative ../../shared/* imports into one ESM file
    // so the harness needs no tsconfig path aliases at runtime.
    await esbuild.build({
      entryPoints: [entry],
      outfile: outFile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'node22',
      logLevel: 'silent'
    })
  } catch (error) {
    throw new Error(`esbuild failed to compile dsp.ts:\n${error.message}`)
  }

  const module = await import(pathToFileURL(outFile).href)
  for (const name of REQUIRED_EXPORTS) {
    if (typeof module[name] !== 'function') {
      throw new Error(`Compiled dsp.ts did not export a function named "${name}".`)
    }
  }
  const workerPath = path.join(dir, 'worker.cjs')
  const mergePath = path.join(dir, 'merge.mjs')
  await esbuild.build({ entryPoints: ['src/main/analysis/worker.ts'], outfile: workerPath, bundle: true, format: 'cjs', platform: 'node', target: 'node22', logLevel: 'silent' })
  await esbuild.build({ entryPoints: ['src/main/analysis/merge.ts'], outfile: mergePath, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' })
  const merge = await import(pathToFileURL(mergePath).href)

  return {
    dsp: module,
    merge,
    workerPath,
    fixtureDirectory: dir,
    strategy: 'esbuild bundle (node_modules/esbuild) → temporary .mjs → dynamic import()',
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

async function runWorker(workerPath, workerData) {
  const worker = new Worker(workerPath, { workerData })
  return new Promise((resolve, reject) => {
    let reply = null
    const timer = setTimeout(async () => {
      await worker.terminate()
      reject(new Error('Test-owned analysis worker did not exit within 10 seconds'))
    }, 10000)
    worker.on('message', (message) => { reply = message })
    worker.once('error', (error) => { clearTimeout(timer); reject(error) })
    worker.once('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !reply) reject(new Error(`Analysis worker exited ${code} without a successful reply/teardown`))
      else resolve(reply)
    })
  })
}

/* ========================================================================= */
/* Deterministic synthetic audio                                             */
/* ========================================================================= */

/** mulberry32 — small, fast, fully deterministic. No Math.random anywhere. */
function makeRandom(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Note name → frequency in Hz, A4 = 440, equal temperament. */
const SEMITONE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }

function noteToHz(note, octave, cents = 0) {
  const semitones = SEMITONE[note] + (octave - 4) * 12 - 9
  return 440 * Math.pow(2, (semitones * 100 + cents) / 1200)
}

function midiToHz(midi, cents = 0) {
  return 440 * Math.pow(2, ((midi - 69) * 100 + cents) / 1200)
}

function addAt(buffer, index, value) {
  if (index >= 0 && index < buffer.length) buffer[index] += value
}

/** Adds one note with a harmonic series and a percussive-ish envelope. */
function addNote(buffer, sampleRate, startSec, durationSec, frequency, gain, options = {}) {
  const partials = options.partials ?? [1, 0.5, 0.28, 0.16, 0.09]
  const decay = options.decay ?? 2.6
  const attackSec = options.attackSec ?? 0.012
  const random = options.random ?? makeRandom(1234)
  const detuneCents = options.detuneCents ?? 0
  // Fixed per-partial phases keep the fixture byte-identical run to run.
  const phases = options.phases ?? partials.map((_, index) => (index * Math.PI) / 3)

  const start = Math.round(startSec * sampleRate)
  const length = Math.round(durationSec * sampleRate)

  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate
    let attack = 1
    if (attackSec > 0 && t < attackSec) attack = t / attackSec
    const envelope = attack * Math.exp((-decay * t) / Math.max(0.05, durationSec))
    let sample = 0
    for (let p = 0; p < partials.length; p += 1) {
      const partialGain = partials[p]
      if (!(partialGain > 0)) continue
      const frequencyHz = frequency * (p + 1) * Math.pow(2, detuneCents / 1200)
      if (frequencyHz >= sampleRate / 2) break
      sample += partialGain * Math.sin(2 * Math.PI * frequencyHz * t + phases[p % phases.length] + random() * 0)
    }
    addAt(buffer, start + i, sample * gain * envelope)
  }
}

/** Adds one percussive hit: a short filtered noise burst plus a low thump. */
function addHit(buffer, sampleRate, startSec, options = {}) {
  const { gain = 0.8, bodyHz = 90, burstSec = 0.05, thumpSec = 0.12, random = makeRandom(7) } = options
  const start = Math.round(startSec * sampleRate)

  // Noise burst, low-passed by a one-pole filter so it is a broadband "click"
  // rather than hiss.
  const burstLength = Math.round(burstSec * sampleRate)
  let previous = 0
  for (let i = 0; i < burstLength; i += 1) {
    const t = i / sampleRate
    const envelope = Math.exp(-t / (burstSec / 3))
    const white = random() * 2 - 1
    previous = previous * 0.45 + white * 0.55
    addAt(buffer, start + i, previous * gain * 0.55 * envelope)
  }

  // Low thump.
  const thumpLength = Math.round(thumpSec * sampleRate)
  for (let i = 0; i < thumpLength; i += 1) {
    const t = i / sampleRate
    const envelope = Math.exp(-t / (thumpSec / 4))
    addAt(buffer, start + i, Math.sin(2 * Math.PI * bodyHz * t) * gain * 0.7 * envelope)
  }
}

/** Adds a short pitched "hat" — a high noise tick. */
function addHat(buffer, sampleRate, startSec, gain, random) {
  const start = Math.round(startSec * sampleRate)
  const length = Math.round(0.02 * sampleRate)
  let previous = 0
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate
    const envelope = Math.exp(-t / 0.005)
    const white = random() * 2 - 1
    // Crude high-pass: differentiate the low-passed noise.
    const filtered = white - previous
    previous = white
    addAt(buffer, start + i, filtered * gain * envelope)
  }
}

/** Adds a sustained chord (block chord) with a soft attack and release. */
function addChord(buffer, sampleRate, startSec, durationSec, midiNotes, gain, random) {
  const start = Math.round(startSec * sampleRate)
  const length = Math.round(durationSec * sampleRate)
  const attackSec = 0.04
  const releaseSec = 0.18
  const partials = [1, 0.42, 0.22, 0.11, 0.05]

  for (let voice = 0; voice < midiNotes.length; voice += 1) {
    const frequency = midiToHz(midiNotes[voice])
    // Small, fixed per-voice phase offsets avoid a perfectly correlated stack.
    const phase0 = voice * 1.7
    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate
      const remaining = durationSec - t
      let envelope = 1
      if (t < attackSec) envelope = t / attackSec
      if (remaining < releaseSec) envelope = Math.min(envelope, Math.max(0, remaining / releaseSec))
      let sample = 0
      for (let p = 0; p < partials.length; p += 1) {
        const frequencyHz = frequency * (p + 1)
        if (frequencyHz >= sampleRate / 2) break
        sample += partials[p] * Math.sin(2 * Math.PI * frequencyHz * t + phase0 * (p + 1))
      }
      addAt(buffer, start + i, sample * gain * envelope)
    }
  }
  void random
}

/** Soft-clips and peak-normalises to a target level. Deterministic. */
function finalise(buffer, peak = 0.85) {
  let max = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const value = Math.tanh(buffer[i] * 1.1)
    buffer[i] = value
    const absolute = Math.abs(value)
    if (absolute > max) max = absolute
  }
  if (max > 1e-9) {
    const scale = peak / max
    for (let i = 0; i < buffer.length; i += 1) buffer[i] *= scale
  }
  return buffer
}

function makeBuffer(sampleRate, seconds) {
  return new Float32Array(Math.round(sampleRate * seconds))
}

function addNoiseBed(buffer, amplitude, seed) {
  const random = makeRandom(seed)
  for (let i = 0; i < buffer.length; i += 1) buffer[i] += (random() * 2 - 1) * amplitude
  return buffer
}

/* ========================================================================= */
/* Fixture builders                                                          */
/* ========================================================================= */

/** Metronomic click train, optionally over a noise/tonal bed. */
function clickTrain(bpm, seconds, options = {}) {
  const { sampleRate = SAMPLE_RATE, seed = 11, noise = 0, bedHz = 0, bedGain = 0, variants = false } = options
  const buffer = makeBuffer(sampleRate, seconds)
  const random = makeRandom(seed)
  const period = 60 / bpm
  const hits = Math.floor(seconds / period)

  for (let hit = 0; hit < hits; hit += 1) {
    const time = hit * period
    // A little velocity variation so the envelope is not a pure delta train.
    const gain = variants ? 0.7 + 0.3 * ((hit * 37) % 7) / 7 : 0.8
    addHit(buffer, sampleRate, time, { gain, bodyHz: 70, random })
  }
  if (bedHz > 0) {
    for (let hit = 0; hit < hits; hit += 1) {
      addNote(buffer, sampleRate, hit * period, period * 0.9, bedHz, bedGain, {
        partials: [1, 0.5, 0.25],
        decay: 3,
        random
      })
    }
  }
  if (noise > 0) addNoiseBed(buffer, noise, seed + 1)
  return { pcm: finalise(buffer), sampleRate }
}

/** Kick + snare/hat pattern at a target tempo, for half/double checks. */
function drumPattern(bpm, seconds, options = {}) {
  const { sampleRate = SAMPLE_RATE, seed = 23, subdivision = 4 } = options
  const buffer = makeBuffer(sampleRate, seconds)
  const random = makeRandom(seed)
  const step = 60 / bpm / (subdivision / 4)
  const steps = Math.floor(seconds / step)

  for (let index = 0; index < steps; index += 1) {
    const position = index % subdivision
    const time = index * step
    if (position === 0) addHit(buffer, sampleRate, time, { gain: 0.95, bodyHz: 62, random })
    if (subdivision >= 4 && position === 2) addHit(buffer, sampleRate, time, { gain: 0.7, bodyHz: 180, random })
    addHat(buffer, sampleRate, time, 0.22, random)
  }
  return { pcm: finalise(buffer), sampleRate }
}

/**
 * Double-time feel: a slow kick pattern with a fast hat layer on top, so the
 * signal genuinely contains two competing pulse rates.
 */
function doubleTimeFeel(lowBpm, seconds, options = {}) {
  const { sampleRate = SAMPLE_RATE, seed = 31 } = options
  const buffer = makeBuffer(sampleRate, seconds)
  const random = makeRandom(seed)
  const lowPeriod = 60 / lowBpm
  const highPeriod = 60 / (lowBpm * 2)

  for (let time = 0; time < seconds; time += lowPeriod) {
    addHit(buffer, sampleRate, time, { gain: 0.95, bodyHz: 58, random })
  }
  for (let time = 0; time < seconds; time += highPeriod) {
    addHat(buffer, sampleRate, time, 0.3, random)
  }
  return { pcm: finalise(buffer), sampleRate }
}

/**
 * Tresillo-family syncopation: hits grouped 3 + 3 + 2 sixteenths, which is the
 * classic "underlying tempo you cannot read off the inter-onset interval" case.
 */
function syncopatedTresillo(bpm, seconds, options = {}) {
  const { sampleRate = SAMPLE_RATE, seed = 41 } = options
  const buffer = makeBuffer(sampleRate, seconds)
  const random = makeRandom(seed)
  const sixteenth = 60 / bpm / 4
  const cycle = sixteenth * 8 // 3 + 3 + 2
  const offsets = [0, 3 * sixteenth, 6 * sixteenth]
  const cycles = Math.floor(seconds / cycle)

  for (let c = 0; c < cycles; c += 1) {
    for (const offset of offsets) {
      addHit(buffer, sampleRate, c * cycle + offset, { gain: 0.85, bodyHz: 74, random })
    }
  }
  // Bass on the downbeat keeps the underlying pulse present in the material.
  for (let c = 0; c < cycles; c += 1) {
    addNote(buffer, sampleRate, c * cycle, cycle * 0.85, noteToHz('A', 1), 0.35, {
      partials: [1, 0.5, 0.2],
      decay: 2.4,
      random
    })
  }
  return { pcm: finalise(buffer), sampleRate }
}

/** Chord progression over a soft kick pulse. Chords are the point; the pulse is texture. */
function chordProgression(chords, seconds, options = {}) {
  const { sampleRate = SAMPLE_RATE, seed = 53, bpm = 100, gain = 0.4, pulse = true } = options
  const buffer = makeBuffer(sampleRate, seconds)
  const random = makeRandom(seed)
  const barSec = (60 / bpm) * 4
  const bars = Math.ceil(seconds / barSec)

  for (let bar = 0; bar < bars; bar += 1) {
    const start = bar * barSec
    if (start >= seconds) break
    const duration = Math.min(barSec, seconds - start)
    const chord = chords[bar % chords.length]
    addChord(buffer, sampleRate, start, duration, chord, gain, random)
    if (pulse) addHit(buffer, sampleRate, start, { gain: 0.4, bodyHz: 55, random })
  }
  return { pcm: finalise(buffer), sampleRate }
}

function silence(seconds, sampleRate = SAMPLE_RATE) {
  return { pcm: makeBuffer(sampleRate, seconds), sampleRate }
}

function whiteNoise(seconds, sampleRate = SAMPLE_RATE, seed = 97, amplitude = 0.5) {
  const pcm = makeBuffer(sampleRate, seconds)
  const random = makeRandom(seed)
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = (random() * 2 - 1) * amplitude
  return { pcm, sampleRate }
}

function pureSine(seconds, sampleRate = SAMPLE_RATE, hz = 440) {
  const pcm = makeBuffer(sampleRate, seconds)
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = 0.6 * Math.sin((2 * Math.PI * hz * i) / sampleRate)
  return { pcm, sampleRate }
}

function percussionOnly(seconds, sampleRate = SAMPLE_RATE) {
  // Periodic broadband hits with a short 300 Hz thump. This is unpitched
  // percussion for KEY evaluation, but it has an unambiguous 240/min onset
  // train. The historical assertion that tempo must be absent was incorrect.
  const pcm = makeBuffer(sampleRate, seconds)
  const random = makeRandom(71)
  for (let time = 0; time < seconds; time += 0.25) {
    addHit(pcm, sampleRate, time, { gain: 0.9, bodyHz: 300, burstSec: 0.08, thumpSec: 0.04, random })
  }
  return { pcm: finalise(pcm), sampleRate }
}

/* ========================================================================= */
/* Case definitions                                                          */
/* ========================================================================= */

const MIDI = { C3: 48, D3: 50, E3: 52, F3: 53, G3: 55, A3: 57, B3: 59, C4: 60, D4: 62, E4: 64, F4: 65, G4: 67, A4: 69, B4: 71, C5: 72 }

const TRIADS = {
  C: [MIDI.C3, MIDI.E3, MIDI.G3, MIDI.C4],
  F: [MIDI.F3, MIDI.A3, MIDI.C4, MIDI.F4],
  G: [MIDI.G3, MIDI.B3, MIDI.D4, MIDI.G4],
  Am: [MIDI.A3, MIDI.C4, MIDI.E4, MIDI.A4],
  // Inversions / open voicings.
  C_over_E: [MIDI.E3, MIDI.G3, MIDI.C4, MIDI.E4],
  G_over_B: [MIDI.B3, MIDI.D4, MIDI.G4, MIDI.B4],
  F_inv: [MIDI.C4, MIDI.F4, MIDI.A4, MIDI.C5],
  'F#m': [54, 57, 61, 66],
  D: [50, 54, 57, 62],
  'C#m': [49, 52, 56, 61],
  Dm: [50, 53, 57, 62],
  'Eb': [51, 55, 58, 63],
  'Bb': [58, 62, 65, 70],
  'Ab': [56, 60, 63, 68],
  'Cm': [48, 51, 55, 60],
  'Gm': [55, 58, 62, 67]
}

/** Every tempo case: expected BPM plus how strict the check is. */
const TEMPO_CASES = [
  { name: 'clicks 60 BPM + noise bed', expected: 60, ...clickTrain(60, 20, { noise: 0.015 }), requireExact: true },
  { name: 'clicks 90 BPM + bass bed', expected: 90, ...clickTrain(90, 16, { bedHz: noteToHz('A', 1), bedGain: 0.25, noise: 0.01 }), requireExact: true },
  { name: 'clicks 120 BPM + noise', expected: 120, ...clickTrain(120, 16, { noise: 0.02 }), requireExact: true },
  { name: 'clicks 128 BPM + noise bed', expected: 128, ...clickTrain(128, 16, { noise: 0.015, seed: 13 }), requireExact: true },
  { name: 'clicks 140 BPM + tonal bed', expected: 140, ...clickTrain(140, 14, { bedHz: noteToHz('E', 2), bedGain: 0.22, noise: 0.01 }), requireExact: true },
  { name: 'clicks 174 BPM (dnb)', expected: 174, ...clickTrain(174, 12, { noise: 0.012, seed: 17 }), requireExact: true },
  { name: 'clicks 87.5 BPM (fractional)', expected: 87.5, ...clickTrain(87.5, 16, { noise: 0.012, seed: 19 }), requireExact: true },
  { name: 'tresillo syncopation @96 (3+3+2)', expected: 96, ...syncopatedTresillo(96, 20), requireExact: false },
  { name: 'double-time feel, low=88', expected: 88, ...doubleTimeFeel(88, 16), requireExact: false },
  { name: 'kick/snare/hat 124 BPM', expected: 124, ...drumPattern(124, 16), requireExact: true }
]

const KEY_CASES = [
  {
    name: 'C major — C F G C',
    expected: 'C major',
    ...chordProgression([TRIADS.C, TRIADS.F, TRIADS.G, TRIADS.C], 20, { bpm: 100, seed: 101 })
  },
  {
    name: 'A minor — Am F C G',
    expected: 'A minor',
    ...chordProgression([TRIADS.Am, TRIADS.F, TRIADS.C, TRIADS.G], 20, { bpm: 96, seed: 103 })
  },
  {
    name: 'F# minor — F#m D C#m F#m',
    expected: 'F# minor',
    ...chordProgression([TRIADS['F#m'], TRIADS.D, TRIADS['C#m'], TRIADS['F#m']], 18, { bpm: 104, seed: 107 })
  },
  {
    name: 'Eb major — Eb Bb Ab Eb',
    expected: 'D# major',
    ...chordProgression([TRIADS['Eb'], TRIADS['Bb'], TRIADS['Ab'], TRIADS['Eb']], 20, { bpm: 92, seed: 109 })
  },
  {
    name: 'C major w/ inversions — C/E G/B F C',
    expected: 'C major',
    ...chordProgression([TRIADS.C_over_E, TRIADS.G_over_B, TRIADS.F_inv, TRIADS.C], 18, { bpm: 108, seed: 113 })
  },
  {
    name: 'G minor — Gm Eb Bb F',
    expected: 'G minor',
    ...chordProgression([TRIADS['Gm'], TRIADS['Eb'], TRIADS['Bb'], TRIADS.F], 20, { bpm: 100, seed: 127 })
  }
]

/** Negative evidence is field-specific: rhythmic percussion is a key negative. */
const NEGATIVE_CASES = [
  { name: 'pure silence (10 s)', kind: 'silence', ...silence(10) },
  { name: 'white noise (12 s)', kind: 'noise', ...whiteNoise(12) },
  { name: 'pure sine 440 Hz (12 s)', kind: 'sine', ...pureSine(12) },
  { name: '1-second clip (clicks)', kind: 'short', ...clickTrain(120, 1, { seed: 29 }) },
  { name: 'percussion only (12 s)', kind: 'percussion', expectedTempo: 240, ...percussionOnly(12) },
  { name: 'empty Float32Array', kind: 'empty', pcm: new Float32Array(0), sampleRate: SAMPLE_RATE }
]

/* ========================================================================= */
/* Assertions                                                                */
/* ========================================================================= */

/** Walks an analysis object and asserts no NaN/Infinity escaped. */
function findNonFinite(value, trail = '') {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${trail || '<root>'} = ${value}`
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findNonFinite(value[i], `${trail}[${i}]`)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = findNonFinite(value[key], trail ? `${trail}.${key}` : key)
      if (found) return found
    }
  }
  return null
}

const CANONICAL_KEY = /^[A-G]#? (major|minor)$/

function checkTempoShape(tempo) {
  const problems = []
  const nonFinite = findNonFinite(tempo, 'tempo')
  if (nonFinite) problems.push(`non-finite value: ${nonFinite}`)
  if (typeof tempo.status !== 'string') problems.push('status missing')
  if (tempo.bpm !== null && typeof tempo.bpm !== 'number') problems.push('bpm not number|null')
  if (tempo.confidence !== null && (tempo.confidence < 0 || tempo.confidence > 1)) {
    problems.push(`confidence out of 0..1: ${tempo.confidence}`)
  }
  if (tempo.status !== 'estimated') {
    if (tempo.bpm !== null) problems.push('non-estimated result still reported a bpm')
    if (!tempo.warning) problems.push('inconclusive result had no warning')
  }
  if (!Array.isArray(tempo.alternatives)) problems.push('alternatives not an array')
  return problems
}

function checkKeyShape(key) {
  const problems = []
  const nonFinite = findNonFinite(key, 'key')
  if (nonFinite) problems.push(`non-finite value: ${nonFinite}`)
  if (key.status !== 'estimated') {
    if (key.key !== null) problems.push('non-estimated result still reported a key')
    if (key.camelot !== null) problems.push('non-estimated result still reported a camelot')
    if (!key.warning) problems.push('inconclusive result had no warning')
  } else {
    if (!CANONICAL_KEY.test(key.key ?? '')) problems.push(`key not canonical: ${JSON.stringify(key.key)}`)
    if (!/^(1[0-2]|[1-9])[AB]$/.test(key.camelot ?? '')) problems.push(`bad camelot: ${JSON.stringify(key.camelot)}`)
  }
  if (key.confidence !== null && (key.confidence < 0 || key.confidence > 1)) {
    problems.push(`confidence out of 0..1: ${key.confidence}`)
  }
  if (key.tuningCents !== null && Math.abs(key.tuningCents) > 50.0001) {
    problems.push(`tuningCents outside ±50: ${key.tuningCents}`)
  }
  if (!Array.isArray(key.alternatives)) problems.push('alternatives not an array')
  return problems
}

/** Classic relative-major/minor confusion, for the "noted separately" tally. */
function relativeOf(key) {
  const match = /^([A-G]#?) (major|minor)$/.exec(key ?? '')
  if (!match) return null
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const index = names.indexOf(match[1])
  if (index < 0) return null
  return match[2] === 'major' ? `${names[(index + 9) % 12]} minor` : `${names[(index + 3) % 12]} major`
}

function parallelOf(key) {
  const match = /^([A-G]#?) (major|minor)$/.exec(key ?? '')
  if (!match) return null
  return `${match[1]} ${match[2] === 'major' ? 'minor' : 'major'}`
}

function isHalfDouble(readBpm, expectedBpm) {
  const targets = [expectedBpm, expectedBpm / 2, expectedBpm * 2]
  return targets.some((target) => Math.abs(readBpm - target) <= TEMPO_OCTAVE_TOLERANCE_BPM)
}

/** Which octave relationship the reported reading had, for the table's Match column. */
function classifyTempoMatch(primary, alternatives, expected) {
  if (Math.abs(primary - expected) <= TEMPO_EXACT_TOLERANCE_BPM) return 'exact'
  for (const alternative of alternatives) {
    if (Math.abs(alternative.bpm - expected) <= TEMPO_EXACT_TOLERANCE_BPM) return 'alt-exact'
  }
  const equivalent = [primary, ...alternatives.map((a) => a.bpm)].some((value) => isHalfDouble(value, expected))
  return equivalent ? 'half/double' : 'miss'
}

/* ========================================================================= */
/* Runner                                                                    */
/* ========================================================================= */

function formatBpm(value) {
  return value === null ? '—' : value.toFixed(1)
}

function pad(value, width) {
  const text = String(value)
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padLeft(value, width) {
  const text = String(value)
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

async function main() {
  const { dsp, merge, workerPath, fixtureDirectory, strategy, cleanup } = await loadDsp()
  const report = { source: {}, tempo: [], key: [], negatives: [], regressions: [], summary: {} }
  for (const file of ['src/main/analysis/dsp.ts', 'src/main/analysis/worker.ts', 'src/main/analysis/merge.ts', 'scripts/dsp-selftest.mjs', 'src/shared/music.ts', 'src/shared/analysis.ts']) {
    report.source[file] = createHash('sha256').update(await readFile(file)).digest('hex')
  }

  console.log('Sonic V2 — DSP self-test')
  console.log('='.repeat(78))
  console.log(`Module loaded via: ${strategy}`)
  console.log(`Sample rate for fixtures: ${SAMPLE_RATE} Hz`)
  console.log('')
  console.log('Declared tolerances')
  console.log(`  TEMPO_EXACT_TOLERANCE_BPM  = ${TEMPO_EXACT_TOLERANCE_BPM}   (exact-match tolerance, ±BPM)`)
  console.log(`  TEMPO_OCTAVE_TOLERANCE_BPM = ${TEMPO_OCTAVE_TOLERANCE_BPM}   (±BPM of expected, half, or double)`)
  console.log('  Key match is exact string equality on the canonical "Note mode" form.')
  console.log('')

  /* ---------------- tempo ---------------- */
  const tempoRows = []
  let exactPass = 0
  let primaryExact = 0
  let alternateExact = 0
  let tempoCoverage = 0
  let octavePass = 0
  let tempoRequiredFails = 0
  const tempoRequiredTotal = TEMPO_CASES.length

  console.log('TEMPO')
  console.log(
    pad('case', 34) +
      padLeft('expected', 9) +
      padLeft('primary', 9) +
      padLeft('alt', 7) +
      padLeft('conf', 6) +
      pad('  match', 12) +
      'status'
  )
  console.log('-'.repeat(94))

  for (const testCase of TEMPO_CASES) {
    const analysis = dsp.estimateTempo({
      pcm: testCase.pcm,
      sampleRate: testCase.sampleRate,
      sourceDurationSec: testCase.pcm.length / testCase.sampleRate
    })

    const problems = checkTempoShape(analysis)
    const estimated = analysis.status === 'estimated' && analysis.bpm !== null
    let match = 'inconclusive'

    if (estimated) {
      tempoCoverage += 1
      match = classifyTempoMatch(analysis.bpm, analysis.alternatives, testCase.expected)
      if (match === 'exact') { exactPass += 1; primaryExact += 1 }
      else if (match === 'alt-exact') { exactPass += 1; alternateExact += 1 }
      else if (match === 'half/double') octavePass += 1
    }

    // A case is required to pass when it declares requireExact, or when it is
    // the deliberately ambiguous syncopated / double-time case (where a
    // correct exact or half/double reading both count).
    const satisfied = testCase.requireExact
      ? match === 'exact' || match === 'alt-exact'
      : match !== 'inconclusive' && match !== 'miss'

    if (!satisfied || problems.length > 0) tempoRequiredFails += 1

    const altList = analysis.alternatives
      .map((a) => `${a.bpm}(${a.relation[0]})`)
      .join(' ')
    const status = problems.length > 0 ? `SHAPE ${problems[0]}` : satisfied ? 'pass' : 'FAIL'
    report.tempo.push({ id: `t${String(report.tempo.length + 1).padStart(2, '0')}`, expected: testCase.expected, analysis, match, satisfied, problems })

    tempoRows.push({
      name: testCase.name,
      expected: testCase.expected,
      primary: analysis.bpm,
      alternatives: altList,
      match,
      status
    })

    console.log(
      pad(testCase.name, 34) +
        padLeft(testCase.expected.toFixed(2), 9) +
        padLeft(formatBpm(analysis.bpm), 9) +
        padLeft(analysis.alternatives.length, 7) +
        padLeft(analysis.confidence === null ? '—' : analysis.confidence.toFixed(2), 6) +
        pad('  ' + match, 12) +
        status
    )
    if (analysis.warning) console.log(`    warning: ${analysis.warning}`)
    if (altList) console.log(`    alternatives: ${altList}`)
    for (const problem of problems) console.log(`    SHAPE PROBLEM: ${problem}`)
  }

  console.log('')

  /* ---------------- key ---------------- */
  let keyExactPass = 0
  let keyInAlternatives = 0
  let keyRequiredFails = 0
  let keyCoverage = 0
  let ambiguousKeys = 0
  const keyRequiredTotal = KEY_CASES.length
  const relativeConfusions = []
  const parallelConfusions = []

  console.log('KEY')
  console.log(
    pad('case', 36) + pad('expected', 12) + pad('detected', 12) + padLeft('conf', 6) + '  ' + pad('tuning', 8) + 'result'
  )
  console.log('-'.repeat(94))

  for (const testCase of KEY_CASES) {
    const analysis = dsp.estimateKey({
      pcm: testCase.pcm,
      sampleRate: testCase.sampleRate,
      sourceDurationSec: testCase.pcm.length / testCase.sampleRate
    })

    const problems = checkKeyShape(analysis)
    const detected = analysis.key
    if (analysis.status === 'estimated') keyCoverage += 1
    if (analysis.status === 'inconclusive') ambiguousKeys += 1
    const exact = detected === testCase.expected
    const inAlternatives = analysis.alternatives.some((a) => a.key === testCase.expected)

    if (exact) keyExactPass += 1
    if (inAlternatives) keyInAlternatives += 1
    if (!exact && detected) {
      if (relativeOf(detected) === testCase.expected) relativeConfusions.push(`${testCase.name}: ${detected} (rel. of ${testCase.expected})`)
      else if (parallelOf(detected) === testCase.expected) parallelConfusions.push(`${testCase.name}: ${detected} (parallel of ${testCase.expected})`)
    }

    const satisfied = exact && problems.length === 0
    report.key.push({ id: `k${String(report.key.length + 1).padStart(2, '0')}`, expected: testCase.expected, analysis, exact, inAlternatives, satisfied, problems })
    if (!satisfied) keyRequiredFails += 1

    const altList = analysis.alternatives.map((a) => `${a.key} ${a.correlation.toFixed(2)}`).join(' | ')
    const status = problems.length > 0 ? `SHAPE ${problems[0]}` : exact ? 'pass' : inAlternatives ? 'FAIL (in alts)' : 'FAIL'

    console.log(
      pad(testCase.name, 36) +
        pad(testCase.expected, 12) +
        pad(detected ?? '—', 12) +
        padLeft(analysis.confidence === null ? '—' : analysis.confidence.toFixed(2), 6) +
        '  ' +
        pad(analysis.tuningCents === null ? '—' : `${analysis.tuningCents.toFixed(1)}c`, 8) +
        status
    )
    if (altList) console.log(`    alternatives: ${altList}`)
    if (analysis.warning) console.log(`    warning: ${analysis.warning}`)
    for (const problem of problems) console.log(`    SHAPE PROBLEM: ${problem}`)
  }

  console.log('')

  /* ---------------- negatives ---------------- */
  let negativeFails = 0
  let historicalNegativeFails = 0
  let tempoFalsePositives = 0
  let keyFalsePositives = 0

  console.log('NEGATIVE / DEGENERATE INPUT (percussion is key-negative, tempo-positive at 240/min or half-time)')
  console.log(pad('case', 30) + pad('tempo', 18) + pad('key', 18) + 'result')
  console.log('-'.repeat(94))

  for (const testCase of NEGATIVE_CASES) {
    const input = {
      pcm: testCase.pcm,
      sampleRate: testCase.sampleRate,
      sourceDurationSec: testCase.pcm.length / testCase.sampleRate
    }

    let tempo
    let key
    let threw = null
    try {
      tempo = dsp.estimateTempo(input)
      key = dsp.estimateKey(input)
    } catch (error) {
      threw = error
    }

    if (threw) {
      negativeFails += 1
      console.log(pad(testCase.name, 30) + pad('THREW', 18) + pad('THREW', 18) + `FAIL ${threw.message}`)
      continue
    }

    const tempoProblems = checkTempoShape(tempo)
    const keyProblems = checkKeyShape(key)
    const tempoAbsent = tempo.status === 'inconclusive' || tempo.status === 'failed' || tempo.status === 'skipped'
    const tempoOk = testCase.expectedTempo
      ? tempo.status === 'estimated' && classifyTempoMatch(tempo.bpm, tempo.alternatives, testCase.expectedTempo) !== 'miss'
      : tempoAbsent
    const keyOk = key.status === 'inconclusive' || key.status === 'failed' || key.status === 'skipped'
    const problems = [...tempoProblems, ...keyProblems]
    const pass = tempoOk && keyOk && problems.length === 0
    if (!tempoAbsent && !testCase.expectedTempo) tempoFalsePositives += 1
    if (!keyOk) keyFalsePositives += 1
    if (!tempoAbsent || !keyOk || problems.length) historicalNegativeFails += 1
    report.negatives.push({ id: `n${String(report.negatives.length + 1).padStart(2, '0')}`, expectedTempo: testCase.expectedTempo ?? null, tempo, key, pass, problems })
    if (!pass) negativeFails += 1

    console.log(
      pad(testCase.name, 30) +
        pad(`${tempo.status}${tempo.bpm === null ? '' : ' ' + tempo.bpm}`, 18) +
        pad(`${key.status}${key.key === null ? '' : ' ' + key.key}`, 18) +
        (pass ? 'pass' : 'FAIL')
    )
    for (const problem of problems) console.log(`    SHAPE PROBLEM: ${problem}`)
    if (tempo.warning) console.log(`    tempo warning: ${tempo.warning}`)
    if (key.warning) console.log(`    key warning: ${key.warning}`)
    if (testCase.expectedTempo) console.log(`    supported tempo candidates: ${[tempo.bpm, ...tempo.alternatives.map((a) => a.bpm)].join(', ')}`)
  }

  console.log('')

  /* Evidence regressions: changes to rejection rules must also retain pulses. */
  let regressionFails = 0
  let regressionTempoPositives = 0
  let regressionTempoEstimates = 0
  let regressionNegativeTempos = 0
  let regressionNegativeFalsePositives = 0
  const checkRegression = (id, fixture, field, accept, expectation) => {
    const input = { ...fixture, sourceDurationSec: fixture.pcm.length / fixture.sampleRate }
    const started = performance.now()
    const analysis = field === 'tempo' ? dsp.estimateTempo(input) : dsp.estimateKey(input)
    const elapsedMs = performance.now() - started
    const problems = field === 'tempo' ? checkTempoShape(analysis) : checkKeyShape(analysis)
    const pass = accept(analysis) && problems.length === 0
    if (!pass) regressionFails += 1
    report.regressions.push({ id, field, expectation, analysis, elapsedMs, pass, problems })
    console.log(`  ${id}: ${pass ? 'pass' : 'FAIL'} (${expectation}; ${analysis.status} ${analysis.bpm ?? analysis.key ?? ''})`)
    return analysis
  }
  console.log('EVIDENCE REGRESSIONS (opaque fixture IDs; expected labels never reach DSP)')
  let regressionId = 0
  const nextId = () => `r${String(++regressionId).padStart(2, '0')}`
  for (const rate of [22050, 44100, 48000]) {
    for (const hz of [110, 440, 1000]) {
      regressionNegativeTempos += 1
      const result = checkRegression(nextId(), pureSine(12, rate, hz), 'tempo', (a) => a.status === 'inconclusive', 'stationary signal: no tempo')
      if (result.status === 'estimated') regressionNegativeFalsePositives += 1
    }
    for (const seed of [137, 541, 991]) {
      regressionNegativeTempos += 1
      const result = checkRegression(nextId(), whiteNoise(12, rate, seed), 'tempo', (a) => a.status === 'inconclusive', 'aperiodic noise: no tempo')
      if (result.status === 'estimated') regressionNegativeFalsePositives += 1
    }
    for (const bpm of [90, 128, 174]) {
      const fixture = clickTrain(bpm, 16, { sampleRate: rate, seed: 733, noise: 0.012 })
      // An initial offset must not change the rate. It also catches the old
      // comb response being anchored to the beginning rather than all phases.
      const shifted = new Float32Array(fixture.pcm.length + Math.round(rate * 0.317))
      shifted.set(fixture.pcm, Math.round(rate * 0.317))
      regressionTempoPositives += 1
      const result = checkRegression(nextId(), { ...fixture, pcm: shifted }, 'tempo',
        (a) => a.status === 'estimated' && ['exact', 'alt-exact'].includes(classifyTempoMatch(a.bpm, a.alternatives, bpm)), `rhythmic pulse ${bpm} BPM +/-2`)
      if (result.status === 'estimated') regressionTempoEstimates += 1
    }
  }
  const names = Object.keys(SEMITONE)
  for (let transpose = 0; transpose < 12; transpose += 1) {
    const chords = [TRIADS.C, TRIADS.F, TRIADS.G, TRIADS.C].map((chord) => chord.map((note) => note + transpose))
    const expected = `${names[transpose]} major`
    checkRegression(nextId(), chordProgression(chords, 20, { seed: 337 }), 'key', (a) => a.key === expected, expected)
  }
  for (let transpose = 0; transpose < 12; transpose += 1) {
    const chords = [TRIADS['F#m'], TRIADS.D, TRIADS['C#m'], TRIADS['F#m']].map((chord) => chord.map((note) => note + transpose))
    const expected = `${names[(6 + transpose) % 12]} minor`
    checkRegression(nextId(), chordProgression(chords, 18, { seed: 341 }), 'key', (a) => a.key === expected, expected)
  }
  // Controlled API fault: the first branch throws while reading PCM. The
  // second branch receives the valid samples and must retain its own result.
  // This verifies branch-local catches; coordinator/worker IPC is service scope.
  const independentFixture = chordProgression([TRIADS.C, TRIADS.F, TRIADS.G, TRIADS.C], 20)
  let firstRead = true
  const faultInput = {
    get pcm() {
      if (firstRead) { firstRead = false; throw new Error('injected tempo-only input read failure') }
      return independentFixture.pcm
    },
    sampleRate: independentFixture.sampleRate,
    sourceDurationSec: 20
  }
  const failedTempo = dsp.estimateTempo(faultInput)
  const retainedKey = dsp.estimateKey(faultInput)
  const independentPass = failedTempo.status === 'failed' && retainedKey.key === 'C major'
  if (!independentPass) regressionFails += 1
  report.regressions.push({ id: nextId(), field: 'independence', injected: true, pass: independentPass, tempo: failedTempo, key: retainedKey })
  console.log(`  ${report.regressions.at(-1).id}: ${independentPass ? 'pass' : 'FAIL'} (injected branch-local failure; successful key retained)`)
  const pcmWindows = []
  for (const [index, fixture] of [TEMPO_CASES[2], KEY_CASES[0], KEY_CASES[1]].entries()) {
    const pcmPath = path.join(fixtureDirectory, `f${index}.pcm`)
    await writeFile(pcmPath, Buffer.from(fixture.pcm.buffer, fixture.pcm.byteOffset, fixture.pcm.byteLength))
    pcmWindows.push({ path: pcmPath, sampleRate: fixture.sampleRate, sourceDurationSec: fixture.pcm.length / fixture.sampleRate })
  }
  const absent = { ...pcmWindows[0], path: path.join(fixtureDirectory, 'missing.pcm') }
  const workerCases = [
    { job: { tempo: absent, key: [pcmWindows[1]] }, accepts: (r) => r.ok && r.tempo.status === 'failed' && r.key.key === 'C major', expectation: 'missing tempo PCM retains successful key' },
    { job: { tempo: pcmWindows[0], key: [absent] }, accepts: (r) => r.ok && r.tempo.status === 'estimated' && r.key.status === 'failed', expectation: 'missing key PCM retains successful tempo' },
    { job: { tempo: pcmWindows[0], key: [absent, pcmWindows[1]] }, accepts: (r) => r.ok && r.key.key === 'C major' && /failed/.test(r.key.warning), expectation: 'failed key window retains successful window and warning' },
    { job: { tempo: null, key: [absent, pcmWindows[2]] }, accepts: (r) => r.ok && r.key.status === 'inconclusive' && r.key.alternatives.some((a) => a.key === 'A minor') && r.key.alternatives.some((a) => a.key === 'C major') && /failed/.test(r.key.warning), expectation: 'failed window preserves relative-key ambiguity alternatives' }
  ]
  for (const test of workerCases) {
    const reply = await runWorker(workerPath, test.job)
    const pass = test.accepts(reply)
    if (!pass) regressionFails += 1
    const id = nextId()
    report.regressions.push({ id, field: 'worker', injected: true, expectation: test.expectation, reply, pass, exited: true })
    console.log(`  ${id}: ${pass ? 'pass' : 'FAIL'} (${test.expectation}; worker exited)`)
  }
  const mergeInput = KEY_CASES.filter((_, index) => [0, 2].includes(index)).map((fixture) => dsp.estimateKey({ pcm: fixture.pcm, sampleRate: fixture.sampleRate, sourceDurationSec: fixture.pcm.length / fixture.sampleRate }))
  const merged = merge.mergeKeyAnalyses(mergeInput)
  const mergePass = merged.status === 'inconclusive' && mergeInput.every((a) => merged.alternatives.some((b) => b.key === a.key && b.correlation === a.correlation))
  if (!mergePass) regressionFails += 1
  report.regressions.push({ id: nextId(), field: 'merge', expectation: 'section disagreement preserves both raw leading correlations', analysis: merged, pass: mergePass })
  console.log(`  ${report.regressions.at(-1).id}: ${mergePass ? 'pass' : 'FAIL'} (section disagreement retains both leading keys and their raw correlations)`)
  console.log('')

  /* ---------------- determinism ---------------- */
  const determinismTargets = [TEMPO_CASES[3], TEMPO_CASES[7], KEY_CASES[0], KEY_CASES[2]]
  let determinismFails = 0
  for (const testCase of determinismTargets) {
    const input = {
      pcm: testCase.pcm,
      sampleRate: testCase.sampleRate,
      sourceDurationSec: testCase.pcm.length / testCase.sampleRate
    }
    const a = JSON.stringify([dsp.estimateTempo(input), dsp.estimateKey(input)])
    const b = JSON.stringify([dsp.estimateTempo(input), dsp.estimateKey(input)])
    if (a !== b) determinismFails += 1
  }
  console.log(
    `DETERMINISM: ${determinismTargets.length - determinismFails}/${determinismTargets.length} repeat runs byte-identical`
  )
  console.log('')

  /* ---------------- summary ---------------- */
  const tempoTotal = tempoRequiredTotal
  const keyTotal = keyRequiredTotal
  const tempoAccuracy = (exactPass + octavePass) / tempoTotal
  const keyAccuracy = keyExactPass / keyTotal

  console.log('='.repeat(78))
  console.log('SUMMARY')
  console.log('-'.repeat(78))
  console.log(
    `  primary exact tempo            : ${primaryExact}/${tempoTotal} = ${(primaryExact / tempoTotal * 100).toFixed(1)}%`
  )
  console.log(`  alternate exact (primary misses): ${alternateExact}/${tempoTotal}`)
  console.log(`  exact among primary/alternates : ${exactPass}/${tempoTotal}`)
  console.log(
    `  half/double-equivalent accuracy : ${octavePass}/${tempoTotal} = ${(octavePass / tempoTotal * 100).toFixed(1)}%`
  )
  console.log(
    `  tempo (exact + half/double)     : ${exactPass + octavePass}/${tempoTotal} = ${(tempoAccuracy * 100).toFixed(1)}%`
  )
  console.log(`  key exact accuracy              : ${keyExactPass}/${keyTotal} = ${(keyAccuracy * 100).toFixed(1)}%`)
  console.log(`  key present in alternatives     : ${keyInAlternatives}/${keyTotal}`)
  console.log(`  positive tempo estimate coverage: ${tempoCoverage}/${tempoTotal}`)
  console.log(`  positive key estimate coverage  : ${keyCoverage}/${keyTotal}; inconclusive ${ambiguousKeys}`)
  console.log(`  relative-key confusions         : ${relativeConfusions.length}${relativeConfusions.length ? ' → ' + relativeConfusions.join('; ') : ''}`)
  console.log(`  parallel-key confusions         : ${parallelConfusions.length}${parallelConfusions.length ? ' → ' + parallelConfusions.join('; ') : ''}`)
  console.log(`  negative/degenerate failures    : ${negativeFails}/${NEGATIVE_CASES.length}`)
  console.log(`  true tempo-negative false positives: ${tempoFalsePositives}/${NEGATIVE_CASES.filter((c) => !c.expectedTempo).length}`)
  console.log(`  key-negative false positives    : ${keyFalsePositives}/${NEGATIVE_CASES.length}`)
  console.log(`  added evidence regressions      : ${report.regressions.length - regressionFails}/${report.regressions.length}`)
  console.log(`  added tempo coverage            : ${regressionTempoEstimates}/${regressionTempoPositives}`)
  console.log(`  added tempo false positives     : ${regressionNegativeFalsePositives}/${regressionNegativeTempos}`)
  console.log(`  determinism failures            : ${determinismFails}/${determinismTargets.length}`)
  console.log('')
  console.log(`  HISTORICAL UNCHANGED ANNOTATIONS: ${tempoTotal + keyTotal + NEGATIVE_CASES.length - tempoRequiredFails - keyRequiredFails - historicalNegativeFails}/22 passing (includes the invalid percussion/no-tempo requirement).`)
  console.log(
    `  REQUIRED CASES: ${tempoTotal + keyTotal + NEGATIVE_CASES.length - tempoRequiredFails - keyRequiredFails - negativeFails}/` +
      `${tempoTotal + keyTotal + NEGATIVE_CASES.length} passing`
  )
  console.log('')
  console.log('  NOTE: this suite is entirely synthetic. It shows the DSP implements the')
  console.log('  intended algorithms on clean, controlled material. It says nothing about')
  console.log('  accuracy on real music — real tracks have tuning drift, swing, reverb,')
  console.log('  tempo changes and dense percussion, all of which this suite omits.')

  await cleanup()

  const requiredFails = tempoRequiredFails + keyRequiredFails + negativeFails + determinismFails + regressionFails
  report.summary = { primaryExact, alternateExact, octavePass, tempoCoverage, keyExactPass, keyCoverage, ambiguousKeys, keyInAlternatives, tempoFalsePositives, keyFalsePositives, regressionFails, regressionTempoPositives, regressionTempoEstimates, regressionNegativeTempos, regressionNegativeFalsePositives, requiredFails, historicalPassing: tempoTotal + keyTotal + NEGATIVE_CASES.length - tempoRequiredFails - keyRequiredFails - historicalNegativeFails, correctedPassing: tempoTotal + keyTotal + NEGATIVE_CASES.length - tempoRequiredFails - keyRequiredFails - negativeFails, realMusicReferenceSampleCount: 0 }
  if (process.env.SONIC_DSP_REPORT) {
    const reportPath = path.resolve(process.env.SONIC_DSP_REPORT)
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, JSON.stringify(report, null, 2))
  }
  process.exit(requiredFails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('self-test harness crashed:')
  console.error(error)
  process.exit(1)
})
