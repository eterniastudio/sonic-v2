/**
 * Sonic V2 — self-contained audio-analysis DSP.
 *
 * Estimates tempo (from the signal only) and musical key (Krumhansl–Schmuckler
 * over a harmonic-summation chroma).
 *
 * Design constraints this file is written against:
 *  - Zero npm dependencies. The FFT below is our own radix-2 iterative
 *    Cooley–Tukey with precomputed twiddle factors.
 *  - No Node and no DOM imports. This module is pure computation, so it can be
 *    imported from a worker thread, from the main process, and from a plain
 *    Node script. The only imports are `shared/` siblings, which are themselves
 *    pure.
 *  - Deterministic: no randomness, no clock reads, no iteration over Maps keyed
 *    by non-deterministic values. The same `AnalysisInput` always yields
 *    byte-identical output.
 *  - Never throws, and never returns NaN/Infinity. Every public entry point
 *    funnels through a `try`/`catch` and every numeric field is guarded by
 *    `finiteOr`/`clamp01`.
 *
 * The relative import `../../shared/analysis` (rather than the `@shared/*`
 * alias) is deliberate: it is what makes the file loadable by a bare Node
 * script with no bundler alias configuration, while still resolving correctly
 * through the project's tsconfig `paths`.
 */

import {
  emptyKeyAnalysis,
  emptyTempoAnalysis,
  type FieldAnalysisStatus,
  type KeyAlternative,
  type KeyAnalysis,
  type TempoAlternative,
  type TempoAnalysis,
  type TempoRelation
} from '../../shared/analysis'
import { camelotFor } from '../../shared/music'

/* ------------------------------------------------------------------------- */
/* Public API                                                                 */
/* ------------------------------------------------------------------------- */

export interface AnalysisInput {
  /** Mono PCM, nominally -1..1, at `sampleRate`. */
  pcm: Float32Array
  sampleRate: number
  /** Duration of the full source file in seconds (may exceed pcm length if windowed). */
  sourceDurationSec: number
}

/* ------------------------------------------------------------------------- */
/* Tunable analysis constants                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Tempo front-end: FFT 1024 / hop 512 at 22050 Hz.
 *
 * Rationale for the frame geometry is expressed in *seconds* rather than bins
 * so that the same musical resolution survives a change of sample rate:
 *
 *   frame ≈ 46.4 ms, hop ≈ 23.2 ms → ≈ 43.07 frames/s at 22050 Hz
 *
 * 23.2 ms of time resolution is exactly what 300 BPM needs (one beat at 300 BPM
 * is 200 ms), and 46.4 ms frames still resolve a kick drum's attack without
 * smearing it into the next sixteenth note. The FFT size is rounded *up* to a
 * power of two and clipped to [256, 4096] so a 44.1/48 kHz source keeps the
 * same time resolution instead of silently halving it.
 */
const TEMPO_FRAME_SEC = 1024 / 22050
const TEMPO_HOP_SEC = 512 / 22050
const TEMPO_MIN_FFT = 256
const TEMPO_MAX_FFT = 4096

/**
 * Onset envelope de-trending window. ~2.3 s of moving mean at the nominal frame
 * rate: long enough that a whole bar of a loud chorus cannot raise the local
 * floor much, short enough to track a real dynamic change. This is what stops a
 * loud section from dominating the autocorrelation.
 */
const ONSET_TREND_SEC = 2.3

/**
 * Perceptual tempo *model* range, i.e. the range the returned numbers may live
 * in (and the range over which half/double alternatives are surfaced).
 */
const TEMPO_MODEL_MIN_BPM = 40
const TEMPO_MODEL_MAX_BPM = 300

/**
 * Internal search band for the PRIMARY decision: 60–200 BPM.
 *
 * Deliberately narrower than the model range. A 40–300 search invites the
 * classic failure where a 102 BPM track is reported as 204, because the
 * autocorrelation peak at 204 BPM (the eighth-note or hi-hat pulse) is often
 * *taller* than the beat-rate peak. Restricting the primary decision to 60–200
 * removes most of that failure mode before the prior even acts; readings outside
 * the band are still reachable — as the `half`/`double` alternatives of an
 * in-band primary, which is where they belong musically.
 */
const TEMPO_SEARCH_MIN_BPM = 60
const TEMPO_SEARCH_MAX_BPM = 200

/**
 * Tempo prior: Gaussian in LOG2-tempo space, centre 120 BPM, σ = 0.8 octaves.
 * Evaluated on the BPM ratio, so it is a log-normal prior on tempo.
 *
 * Source for the shape/width: the tempo-prior term from D. P. W. Ellis, "Beat
 * Tracking by Dynamic Programming", Journal of New Music Research 36(1), 2007,
 * which models log-tempo as Gaussian around a preferred tempo; the preferred
 * tempo itself (~120 BPM) comes from the tapping literature it rests on
 * (Fraisse 1982; Parncutt 1994). σ = 0.8 octaves is deliberately wide: this is
 * a tie-breaker between octave-related peaks, not a constraint, and it is
 * applied by *multiplication* so it can never invent a peak the signal lacks.
 */
const TEMPO_PRIOR_CENTRE_BPM = 120
const TEMPO_PRIOR_SIGMA_OCTAVES = 0.8

/**
 * Octave suppression: once a peak is picked, peaks within ±5 % of *that* BPM
 * are suppressed as the same reading and peaks at 0.5× / 2.0× are treated as
 * the `half` / `double` alternatives rather than as independent tempi.
 */
const TEMPO_SUPPRESS_RATIO = 0.05
/** Relative window searched for a competing half/double reading. */
const TEMPO_OCTAVE_WINDOW_RATIO = 0.06
/** A peak must reach this normalised periodicity to be a candidate at all. */
const TEMPO_MIN_PEAK = 0.1

/** Minimum local prominence, unless raw periodic correlation is strong (0.4).
 * Applied after stationary-signal and absolute-correlation evidence gates. */
const TEMPO_MIN_CONFIDENCE = 0.45

/**
 * Comb-filter periodicity (Scheirer, "Tempo and beat analysis of acoustic
 * musical signals", JASA 104(1), 1998): a bank of resonators, one per candidate
 * period, each summing the onset envelope over a comb of that period. It is
 * cheap (~nFrames × nPeriods adds) and phase-insensitive, which is exactly why
 * it is a useful *independent* view of the same evidence.
 *
 * Cross-check policy: when the comb bank and the autocorrelation agree on the
 * primary tempo to within this fraction, the reading is corroborated and
 * confidence is left alone. When they disagree, the peak is real but ambiguous:
 * confidence is scaled down (see `TEMPO_DISAGREE_CONFIDENCE_SCALE`) and the
 * disagreement is stated in `warning`. Neither method silently overrides the
 * other.
 */
const TEMPO_COMB_MIN_HARMONICS = 1
const TEMPO_COMB_MAX_HARMONICS = 8
const TEMPO_AGREEMENT_TOLERANCE = 0.03
const TEMPO_DISAGREE_CONFIDENCE_SCALE = 0.6

/**
 * Evidence thresholds for `status: 'inconclusive'`.
 *
 *  - 6 s of audio: below this there are not enough beats to distinguish a
 *    tempo from a coincidence. (Also ≈ 4 bars at 120 BPM.)
 *  - 4 s of *envelope* and 8 lag-window cycles: the autocorrelation of a short
 *    envelope is dominated by its own length.
 *  - 0.1 linear correlation at the winning peak: essentially no periodicity.
 */
const TEMPO_MIN_AUDIO_SEC = 6
const TEMPO_MIN_ENVELOPE_SEC = 4
const TEMPO_MIN_CYCLES = 8

/**
 * Key front-end: window length is fixed in *seconds* and the FFT size is the
 * next power of two, clipped to [4096, 32768].
 *
 *   KEY_WINDOW_SEC ≈ 0.3715 s → 8192 samples at 22050 Hz → 2.69 Hz/bin
 *
 * Why: pitch content needs fine low-frequency resolution (a semitone at C3 is
 * ~7.8 Hz), while the analysis wants a steady number of frames per second at
 * any sample rate. Scaling the window by *time* keeps the bin width
 * proportional to `sampleRate`, which is exactly the documented behaviour:
 *
 *   22050 Hz (the expected rate — ffmpeg decodes to 22050 Hz mono) → 8192 pt → 2.69 Hz/bin
 *   44100 Hz                                                      → 16384 pt → 2.69 Hz/bin
 *   48000 Hz                                                      → 16384 pt → 2.93 Hz/bin
 *   96000 Hz                                                      → 32768 pt → 2.93 Hz/bin
 *
 * i.e. bin width stays at or below ~3 Hz — comfortably inside the "≤ 4 Hz" goal
 * — at the cost of a slightly coarser time resolution than the tempo front-end,
 * which is the right trade for chroma. Note that doubling to 16384 at 22050 Hz
 * would give 1.35 Hz/bin: better in principle, but it halves the number of
 * frames for a fixed window length and costs 2× the FFT work for a resolution
 * the harmonic summation below does not actually need, because partials are
 * resolved by peak-picking rather than by bin index.
 */
const KEY_WINDOW_SEC = 8192 / 22050
const KEY_MIN_FFT = 4096
const KEY_MAX_FFT = 32768

/** Fraction of a window advanced per key frame (~0.186 s). */
const KEY_HOP_RATIO = 0.5

/**
 * Fine pitch histogram resolution for tuning estimation: 100 bins per semitone
 * = 10 cents per bin. Fine enough that a 1-cent tuning shift moves the peak
 * histogram mass measurably, coarse enough that the whole fold is cheap.
 */
const TUNING_BINS_PER_SEMITONE = 100
const TUNING_FINE_BINS = 12 * TUNING_BINS_PER_SEMITONE
const TUNING_SEARCH_CENTS = 50
const TUNING_STEP_CENTS = 1

/**
 * Register used for chroma accumulation.
 *
 * The lower bound keeps DC and rumble out. The upper bound matters: above
 * roughly 3 kHz a mix is dense with high harmonics that carry little tonal
 * information, and including them dilutes the profile toward uniform. Combined
 * with the 1/f weighting in `accumulateChroma`, this keeps the profile
 * dominated by fundamentals and the first few strong partials.
 */
const CHROMA_MIN_HZ = 55
const CHROMA_MAX_HZ = 3000

/** Key analysis only ever looks at the first 90 s (mtime/clock independent). */
const KEY_MAX_SECONDS = 90

/**
 * `inconclusive` thresholds for key.
 *
 *  - 8 s of audio and ≥ 8 usable frames: fewer frames than that and the chroma
 *    is really a single chord, not a key.
 *  - Chroma total energy ≤ 1e-6, or chroma variance ≤ 1e-9: the chroma is
 *    numerically dead. This is checked *before* any correlation is trusted,
 *    because Pearson correlation on a zero-variance vector returns 0 by
 *    construction — which would otherwise look identical to a legitimate
 *    "no correlation" result.
 *  - Chroma entropy > 0.93 (Shannon entropy over the 12 L1-normalised bins,
 *    divided by ln 12). A clean tonal piece usually sits around 0.80–0.90;
 *    white noise sits at ~0.999 and a flat/percussive chroma near 1.0. 0.93 is
 *    the point where the profile has essentially no shape left for K–S to
 *    correlate against.
 *  - Best Pearson correlation < 0.35 absolute. Krumhansl–Kessler correlations
 *    for real tonal music are typically 0.6–0.9; 0.35 keeps a clearly tonal but
 *    noisy mix while rejecting a flat histogram.
 *
 * These are deliberately conservative: each one is a case where reporting a key
 * would be a fabrication rather than an estimate, and the brief for this module
 * is that a confident wrong answer is worse than an honest "no".
 */
const KEY_MIN_AUDIO_SEC = 8
const KEY_MIN_FRAMES = 8
const KEY_MIN_CHROMA_ENERGY = 1e-6
const KEY_MIN_CHROMA_VARIANCE = 1e-9
const KEY_MAX_ENTROPY = 0.93

/**
 * Lower bound on chroma entropy.
 *
 * `KEY_MAX_ENTROPY` catches material that is too flat, but the opposite failure
 * is just as real and was not caught at all: a single sustained pitch (a test
 * tone, a drone, a sub-bass note on its own) produces a maximally *peaked* chroma
 * with near-zero entropy, which then correlates well with whichever profile
 * rotation happens to align. That is exactly the "loudest frequency mistaken for
 * the key" error. A real key needs several distinct pitch classes present; a
 * three-note triad alone already sits near 0.44, so this floor rejects only
 * genuinely single-pitch material.
 */
const KEY_MIN_ENTROPY = 0.3
const KEY_MIN_CORRELATION = 0.35

/**
 * A relative major/minor is pushed into `alternatives` when it is within this
 * margin of the winner's correlation. It is nearly always in contention anyway;
 * the margin only decides whether it displaces a weaker candidate that the raw
 * ranking preferred.
 */
const KEY_RELATIVE_SURFACE_MARGIN = 0.15

/** How many alternatives each field reports at most. */
const TEMPO_MAX_ALTERNATIVES = 4
const KEY_MAX_ALTERNATIVES = 3

/**
 * Krumhansl–Kessler key profiles (index 0 = tonic).
 * Source: C. L. Krumhansl, *Cognitive Foundations of Musical Pitch* (Oxford
 * University Press, 1990), Appendix; the values are the canonical probe-tone
 * rating profiles reproduced in Krumhansl & Kessler (1982), "Tracing the dynamic
 * changes in perceived tonal organization in a spatial representation of
 * musical keys", Psychological Review 89(4).
 *
 * Documented tradeoff: these profile values are verified against the published
 * source and are what the brief specifies, but plain K–S with KK profiles is
 * known to be outperformed on MIREX-style key-detection benchmarks by learned
 * or reweighted profile sets — in particular Temperley's revised profiles
 * (Temperley 2001; used by his Melisma/`melisma_key` implementation) and the
 * Shaath et al. (2017) profiles, which raise the weight of the mediant and
 * submediant and suppress the leading tone. Those variants trade a little
 * interpretability and provenance for a few points of accuracy on Western
 * popular music. KK is used here as specified; swapping `KK_MAJOR`/`KK_MINOR`
 * for Temperley's or Shaath's tables is the single highest-leverage change if
 * benchmark accuracy later proves insufficient, and would require no other
 * algorithmic change.
 */
const KK_MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88
] as const
const KK_MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17
] as const

/** Sharp spellings only — `shared/music` normalises the same way. */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/* ------------------------------------------------------------------------- */
/* Numeric guards                                                             */
/* ------------------------------------------------------------------------- */

/** Coerces any non-finite number to `fallback`. Every returned number passes. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, lo: number, hi: number): number {
  const v = finiteOr(value, lo)
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/** Display rounding to a step, with -0 normalised away. */
function roundToStep(value: number, step: number): number {
  const rounded = Math.round(value / step) * step
  return Object.is(rounded, -0) ? 0 : Number(finiteOr(rounded, 0).toFixed(6))
}

/* ------------------------------------------------------------------------- */
/* FFT — radix-2 iterative Cooley–Tukey, precomputed twiddles                  */
/* ------------------------------------------------------------------------- */

/**
 * In-place forward FFT on interleaved-format-free split arrays.
 *
 * Layout mirrors a classic "two real arrays" FFT: callers pass `re` and `im`
 * separately, and `im` may be null for a real-only transform, in which case it
 * is treated as all zeros.
 *
 * Twiddle factors are precomputed once per size and cached on the instance, so
 * repeatedly transforming frames of the same length costs no extra setup.
 */
class Fft {
  readonly size: number
  private readonly levels: number
  private readonly cosTable: Float64Array
  private readonly sinTable: Float64Array
  private readonly reverse: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 2, got ${size}`)
    }
    this.size = size
    this.levels = Math.round(Math.log2(size))

    // cos/sin(-2*pi*k/n) for k in [0, n/2)
    this.cosTable = new Float64Array(size / 2)
    this.sinTable = new Float64Array(size / 2)
    for (let k = 0; k < size / 2; k += 1) {
      const angle = (-2 * Math.PI * k) / size
      this.cosTable[k] = Math.cos(angle)
      this.sinTable[k] = Math.sin(angle)
    }

    // Bit-reversal permutation, precomputed.
    this.reverse = new Uint32Array(size)
    for (let i = 0; i < size; i += 1) {
      let x = i
      let r = 0
      for (let b = 0; b < this.levels; b += 1) {
        r = (r << 1) | (x & 1)
        x >>>= 1
      }
      this.reverse[i] = r
    }
  }

  /**
   * Forward transform. `re` holds the real input and is overwritten with the
   * real output; `im` (optional) holds the imaginary input and is overwritten
   * with the imaginary output. When `im` is null only the real output is kept.
   */
  forward(re: Float64Array, im: Float64Array | null): void {
    const n = this.size
    const rev = this.reverse

    for (let i = 0; i < n; i += 1) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        if (im) {
          const ti = im[i]
          im[i] = im[j]
          im[j] = ti
        }
      }
    }

    // Butterfly stages double the span each pass: 2, 4, 8, … n. That is
    // log2(n) stages. The body below relies on `span` being a power of two —
    // `half = span >> 1` and `step = n / span` are only the correct twiddle
    // stride for power-of-two spans, and `start += span` only lands on valid
    // sub-transform boundaries then. Incrementing by 1 instead would run n-1
    // stages, read past the end of the arrays (typed-array reads yield
    // `undefined` → NaN) and turn a 10-stage transform into a 1023-stage one.
    for (let span = 2; span <= n; span *= 2) {
      const half = span >> 1
      const step = n / span
      for (let start = 0; start < n; start += span) {
        for (let k = 0; k < half; k += 1) {
          const tw = k * step
          const wr = this.cosTable[tw]
          const wi = this.sinTable[tw]
          const a = start + k
          const b = a + half
          const br = re[b]
          const bi = im ? im[b] : 0
          const tr = br * wr - bi * wi
          const ti = br * wi + bi * wr
          re[b] = re[a] - tr
          if (im) im[b] = im[a] - ti
          re[a] += tr
          if (im) im[a] += ti
        }
      }
    }
  }
}

/** Periodic Hann window (denominator N, not N-1) — the correct choice for STFT. */
function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i += 1) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  }
  return w
}

/** Next power of two ≥ n, clipped into [lo, hi]. */
function fftSizeFor(n: number, lo: number, hi: number): number {
  let size = lo
  while (size < n && size < hi) size *= 2
  return clamp(size, lo, hi)
}

/** Root-mean-square of a span. */
function rms(pcm: Float32Array, from: number, to: number): number {
  const n = to - from
  if (n <= 0) return 0
  let sum = 0
  for (let i = from; i < to; i += 1) {
    const s = pcm[i]
    sum += s * s
  }
  const value = Math.sqrt(sum / n)
  return Number.isFinite(value) ? value : 0
}

/* ------------------------------------------------------------------------- */
/* estimateTempo                                                              */
/* ------------------------------------------------------------------------- */

/** A candidate peak in the (prior-weighted) periodicity curve. */
interface TempoPeak {
  bpm: number
  /** Prior-weighted periodicity value at the peak. */
  strength: number
  /** Raw (un-weighted, un-prior-ed) periodicity at the peak. */
  raw: number
  /** Comb-filter response at the peak's period, for the agreement cross-check. */
  comb: number
}

/** Normalises a curve to its own maximum, in place-safe fashion (returns a copy). */
function normaliseToMax(curve: Float64Array): Float64Array {
  let max = 0
  for (let i = 0; i < curve.length; i += 1) {
    const v = curve[i]
    if (v > max) max = v
  }
  const out = new Float64Array(curve.length)
  if (max > 1e-12) {
    for (let i = 0; i < curve.length; i += 1) out[i] = curve[i] / max
  }
  return out
}

/**
 * Estimates tempo from the audio signal alone.
 *
 * Pipeline: Hann-windowed STFT → half-wave-rectified log-magnitude spectral
 * flux (onset strength) → moving-mean de-trending → two independent periodicity
 * views of the same envelope (Pearson autocorrelation and a Scheirer comb-filter
 * bank) → combined curve × log-normal tempo prior → peak picking inside the
 * 60–200 BPM decision band → half/double reporting with octave suppression.
 *
 * Never throws; returns `status: 'inconclusive'` with a `warning` whenever the
 * signal does not carry enough rhythmic evidence.
 */
export function estimateTempo(input: AnalysisInput): TempoAnalysis {
  try {
    return estimateTempoInner(input)
  } catch {
    const failed = emptyTempoAnalysis()
    return { ...failed, status: 'failed', warning: 'Tempo analysis failed unexpectedly.' }
  }
}

function estimateTempoInner(input: AnalysisInput): TempoAnalysis {
  const pcm = input.pcm
  const sampleRate = Math.floor(finiteOr(input.sampleRate, 0))
  const samples = pcm && typeof pcm.length === 'number' ? pcm.length : 0

  if (samples === 0) {
    return inconclusiveTempo('No audio samples were available to analyse.')
  }
  if (sampleRate <= 0) {
    return inconclusiveTempo('The sample rate was invalid, so tempo could not be estimated.')
  }

  const seconds = samples / sampleRate

  // ---- silence / no-signal guard ----------------------------------------
  // A cheap time-domain RMS check up front: an all-zero or near-zero buffer is
  // silence by definition, and we should not let numerical dust in the FFT
  // produce a confident-looking tempo.
  const level = rms(pcm, 0, samples)
  if (!(level > 1e-6)) {
    return inconclusiveTempo('The audio is silent, so no tempo could be estimated.')
  }

  // ---- frame geometry ----------------------------------------------------
  const fftSize = fftSizeFor(
    Math.max(2, Math.round(TEMPO_FRAME_SEC * sampleRate)),
    TEMPO_MIN_FFT,
    TEMPO_MAX_FFT
  )
  const hop = Math.max(1, Math.round(TEMPO_HOP_SEC * sampleRate))
  const bins = fftSize >> 1
  const frames = samples >= fftSize ? 1 + Math.floor((samples - fftSize) / hop) : 0
  const framesPerSecond = sampleRate / hop

  if (frames < 2) {
    return inconclusiveTempo(
      `Only ${seconds.toFixed(1)} s of audio was available; at least ${TEMPO_MIN_AUDIO_SEC} s is needed to measure a tempo.`
    )
  }

  // ---- onset strength envelope (spectral flux) ---------------------------
  const fullEnvelope = spectralFluxEnvelope(pcm, fftSize, hop, frames, bins, level)
  if (fullEnvelope.reduce((sum, value) => sum + value, 0) / frames < 0.02) {
    return inconclusiveTempo('The spectrum was stationary; changes were too small to establish rhythmic onsets.')
  }
  const envelopeSeconds = frames / framesPerSecond

  if (envelopeSeconds < TEMPO_MIN_ENVELOPE_SEC || seconds < TEMPO_MIN_AUDIO_SEC) {
    return inconclusiveTempo(
      `Only ${seconds.toFixed(1)} s of audio was available; at least ${TEMPO_MIN_AUDIO_SEC} s is needed to measure a tempo.`
    )
  }

  // ---- leading-silence trim ----------------------------------------------
  // A silent intro would otherwise contribute a long run of zero onset strength,
  // which biases the moving mean at the start and inflates short-lag
  // correlations that merely match "silence to silence". Only a *substantial*
  // leading run is trimmed, and never enough to drop below the minimum
  // evidence length, so a quiet-but-real opening is left alone.
  const envelope = trimLeadingSilence(
    fullEnvelope,
    framesPerSecond,
    TEMPO_MIN_ENVELOPE_SEC
  )

  // De-trend: subtract a moving mean so a loud section cannot dominate, then
  // scale by the mean absolute deviation so the result is level-independent.
  const detrended = detrendEnvelope(envelope, framesPerSecond)
  const frameCount = detrended.length

  let energy = 0
  for (let i = 0; i < frameCount; i += 1) energy += detrended[i]
  if (!(energy > 1e-9)) {
    return inconclusiveTempo('The onset envelope was flat, so no rhythmic periodicity was found.')
  }

  // ---- lag range ---------------------------------------------------------
  // The curve is built over the full 40–300 model range so that out-of-band
  // readings remain available as evidence; the *decision* is confined to
  // 60–200 below.
  const minBpm = TEMPO_MODEL_MIN_BPM
  const maxBpm = Math.min(TEMPO_MODEL_MAX_BPM, framesPerSecond * 60)
  if (!(maxBpm > minBpm)) {
    return inconclusiveTempo('The audio was too short to search the 40–300 BPM range.')
  }

  const lagMin = Math.max(2, Math.floor((framesPerSecond * 60) / maxBpm))
  let lagMax = Math.ceil((framesPerSecond * 60) / minBpm)
  if (lagMax > frameCount - 4) lagMax = frameCount - 4
  if (lagMax - lagMin < 4) {
    return inconclusiveTempo('The audio was too short for a reliable autocorrelation of the beat.')
  }

  // Require enough repetitions of the *slowest* searched period to actually
  // observe a pulse: with fewer than TEMPO_MIN_CYCLES cycles of the longest
  // lag present in the envelope, the correlation is measuring the envelope's
  // own length rather than any periodicity in the audio.
  const cycles = (frameCount - lagMax) / lagMax
  if (frameCount - lagMax < TEMPO_MIN_CYCLES || cycles < 1) {
    return inconclusiveTempo(
      `Only ${seconds.toFixed(1)} s of audio was available; at least ${TEMPO_MIN_AUDIO_SEC} s is needed to measure a tempo.`
    )
  }

  // ---- periodicity views -------------------------------------------------
  const acSize = lagMax + 1
  const autocorrelation = new Float64Array(acSize)
  const comb = new Float64Array(acSize)

  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    autocorrelation[lag] = normalisedAutocorrelation(detrended, frameCount, lag)
  }
  if (Math.max(...autocorrelation) < 0.25) {
    return inconclusiveTempo('No repeating onset pattern had sufficient correlation to establish a tempo.')
  }
  const combLagMin = TEMPO_COMB_MIN_HARMONICS
  const combLagMax = Math.min(lagMax, Math.floor(frameCount / TEMPO_COMB_MAX_HARMONICS))
  for (let lag = Math.max(2, combLagMin); lag <= combLagMax; lag += 1) {
    comb[lag] = combFilterResponse(detrended, frameCount, lag)
  }

  // Each method is peak-picked independently first, because the agreement
  // cross-check must compare like with like: each view's own best tempo.
  const acBpm = bestBpmInBand(autocorrelation, lagMin, lagMax, framesPerSecond, 0, 0)
  const combBpm = combBpmInBand(comb, lagMin, combLagMax, framesPerSecond)

  // Combining the two normalised views keeps the agreement
  // information in the curve itself: a period both methods like is reinforced,
  // a period only one method likes still survives on its own merit.
  const acNorm = normaliseToMax(autocorrelation)
  const combNorm = normaliseToMax(comb)
  const combined = new Float64Array(acSize)
  const weighted = new Float64Array(acSize)
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    // Phase folding is sensitive to accumulated integer-period error; use it
    // as corroboration, not an equal vote capable of moving the pulse rate.
    const value = acNorm[lag] + 0.25 * combNorm[lag]
    combined[lag] = value
    const bpm = (framesPerSecond * 60) / lag
    weighted[lag] = value * tempoPrior(bpm)
  }

  // ---- peak picking (decision band) --------------------------------------
  const decisionMin = TEMPO_SEARCH_MIN_BPM
  const decisionMax = TEMPO_SEARCH_MAX_BPM

  const peaks: TempoPeak[] = []
  for (let lag = lagMin + 1; lag < lagMax; lag += 1) {
    const value = weighted[lag]
    if (value < TEMPO_MIN_PEAK) continue
    if (value < weighted[lag - 1] || value < weighted[lag + 1]) continue
    const bpm = (framesPerSecond * 60) / lag
    if (!(bpm >= minBpm && bpm <= maxBpm)) continue
    const refined = parabolicLag(weighted, lag, lagMin, lagMax)
    const refinedBpm = (framesPerSecond * 60) / refined
    if (!(refinedBpm >= minBpm && refinedBpm <= maxBpm)) continue
    const strength = Math.max(0, interpolateAt(weighted, refined))
    const raw = Math.max(0, interpolateAt(combined, refined))
    if (raw < TEMPO_MIN_PEAK) continue
    peaks.push({
      bpm: refineTempoPeriod(refinedBpm, autocorrelation, framesPerSecond, lagMin, lagMax),
      strength,
      raw,
      comb: Math.max(0, combNorm[lag])
    })
  }

  peaks.sort((a, b) => b.strength - a.strength || a.bpm - b.bpm)

  // The primary decision is restricted to the 60–200 BPM band (see
  // TEMPO_SEARCH_MIN_BPM for why). If no peak exists there, fall back to the
  // strongest peak in the full model range rather than declaring failure: the
  // material may genuinely be a 55 BPM ballad or a 210 BPM drum loop.
  const inBand = peaks.filter((peak) => peak.bpm >= decisionMin && peak.bpm <= decisionMax)
  let best = inBand.length > 0 ? inBand[0] : peaks[0]
  // Agreement on a repeating phrase can defeat a prior-favoured syncopation.
  // Retain ordinary duple/triple metrical choices; neither view establishes
  // the intended beat level merely by finding the same longer phrase.
  if (acBpm > 0 && Math.abs(acBpm / combBpm - 1) < TEMPO_AGREEMENT_TOLERANCE &&
      best && ![0.5, 1, 1.5, 2, 3, 4].some((ratio) => Math.abs(best.bpm / acBpm / ratio - 1) < 0.05)) {
    const corroborated = peaks.find((peak) => Math.abs(peak.bpm / acBpm - 1) < TEMPO_AGREEMENT_TOLERANCE)
    if (corroborated && best && interpolateAt(autocorrelation, framesPerSecond * 60 / corroborated.bpm) >
      interpolateAt(autocorrelation, framesPerSecond * 60 / best.bpm) * 1.4) best = corroborated
  }

  if (!best) {
    return inconclusiveTempo('No periodic onset pattern stood out above the background.')
  }
  if (!(best.raw > TEMPO_MIN_PEAK)) {
    return inconclusiveTempo('The onset envelope had no clear periodic peak.')
  }

  // The comb's integer teeth and tempo prior must not shift the measured
  // period. Refine against the autocorrelation, using a longer octave period
  // when it provides stronger evidence and better temporal resolution.
  const bpmExact = clamp(best.bpm, minBpm, maxBpm)

  // ---- cross-check agreement ---------------------------------------------
  // Both periodicity methods should name the same pulse. They disagree when the
  // signal supports two readings that the two methods weight differently —
  // exactly the situation where confidence should not be high.
  const agreement = tempoAgreement(bpmExact, acBpm, combBpm)

  // ---- half / double reporting -------------------------------------------
  const alternatives: TempoAlternative[] = []
  const used: number[] = [bpmExact]

  const octaveTargets: { target: number; relation: TempoRelation }[] = [
    { target: bpmExact / 2, relation: 'half' },
    { target: bpmExact * 2, relation: 'double' }
  ]
  const octavePeaks: { peak: TempoPeak; relation: TempoRelation }[] = []
  let missingOctave = 0
  for (const { target, relation } of octaveTargets) {
    if (!(target >= minBpm && target <= maxBpm)) {
      missingOctave += 1
      continue
    }
    const tolerance = Math.max(1, target * TEMPO_OCTAVE_WINDOW_RATIO)
    const found = strongestPeakNear(peaks, target, tolerance, used)
    if (found) octavePeaks.push({ peak: found, relation })
    else missingOctave += 1
  }

  // Strongest octave reading first, as alternatives are ranked by strength.
  octavePeaks.sort((a, b) => b.peak.strength - a.peak.strength)
  for (const { peak, relation } of octavePeaks) {
    used.push(peak.bpm)
    alternatives.push({
      bpm: roundToStep(peak.bpm, 0.1),
      relation,
      strength: finiteOr(peak.strength, 0)
    })
  }

  // Any other well-separated strong reading is reported as `other`. Octave
  // suppression (±TEMPO_SUPPRESS_RATIO) plus the half/double relation test is
  // what stops a single reading from being reported two or three times.
  for (const peak of [...peaks].sort((a, b) => b.raw - a.raw)) {
    if (alternatives.length >= TEMPO_MAX_ALTERNATIVES) break
    if (isSuppressed(peak.bpm, used)) continue
    used.push(peak.bpm)
    alternatives.push({
      bpm: roundToStep(peak.bpm, 0.1),
      relation: 'other',
      strength: finiteOr(peak.strength, 0)
    })
  }

  // ---- confidence ---------------------------------------------------------
  const prominence = peakProminence(combined, lagMin, lagMax, framesPerSecond * 60, best)
  const confidence = agreement.corroborated
    ? prominence
    : clamp01(prominence * TEMPO_DISAGREE_CONFIDENCE_SCALE)

  // Evidence and metrical agreement are separate. A repeating syncopation can
  // support a pulse even if the methods choose different metrical levels.
  const rhythmicSupport = interpolateAt(autocorrelation, framesPerSecond * 60 / bpmExact)
  if (!(prominence >= TEMPO_MIN_CONFIDENCE || rhythmicSupport >= 0.4)) {
    return inconclusiveTempo(
      'No clear rhythmic pulse stood out above the background, so no tempo was reported.'
    )
  }

  const warnings: string[] = []
  if (!agreement.corroborated) warnings.push(agreement.note)
  if (missingOctave === 2) {
    warnings.push('No supported half- or double-time alternative was found within 40–300 BPM.')
  }

  return {
    status: 'estimated',
    bpm: roundToStep(bpmExact, 0.1),
    bpmExact,
    alternatives,
    confidence,
    warning: warnings.length > 0 ? warnings.join(' ') : null
  }
}

/**
 * Drops a substantial leading run of near-zero onset strength.
 *
 * "Substantial" means at least 2 s of continuous near-silence at the head of the
 * envelope; the trim then keeps at least `keepSeconds` of envelope so the
 * autocorrelation still has evidence to work with. Returns the original array
 * when there is nothing worth trimming, so the common path allocates nothing.
 */
function trimLeadingSilence(
  envelope: Float64Array,
  framesPerSecond: number,
  keepSeconds: number
): Float64Array {
  const frames = envelope.length
  if (frames < 4) return envelope

  // Reference level: the median of the non-zero envelope values, so a track that
  // is simply quiet throughout is not mistaken for a track with a silent intro.
  const nonZero: number[] = []
  for (let i = 0; i < frames; i += 1) {
    if (envelope[i] > 0) nonZero.push(envelope[i])
  }
  if (nonZero.length < frames * 0.2) return envelope
  nonZero.sort((a, b) => a - b)
  const median = nonZero[nonZero.length >> 1]
  if (!(median > 1e-9)) return envelope

  const floor = median * 0.02
  const minSilentFrames = Math.round(2 * framesPerSecond)
  const keepFrames = Math.round(keepSeconds * framesPerSecond)

  let firstActive = 0
  while (firstActive < frames && envelope[firstActive] <= floor) firstActive += 1

  if (firstActive < minSilentFrames) return envelope
  if (frames - firstActive < keepFrames) {
    firstActive = Math.max(0, frames - keepFrames)
  }
  if (firstActive <= 0) return envelope
  return envelope.subarray(firstActive)
}

/**
 * Phase-folded periodic energy for one integer period. Coherent energy is
 * the squared phase sums divided by the number of complete cycles; dividing
 * by input energy gives a 0..1 concentration. This is a corroborating view of
 * the same onset evidence, not a statistically independent measurement.
 */
function combFilterResponse(envelope: Float64Array, frames: number, period: number): number {
  // Fold every phase over the complete excerpt. The old implementation
  // sampled only the first eight teeth anchored at sample zero, so an intro
  // offset or a syncopation could change the chosen tempo without changing
  // the pulse. Normalize by the energy of the same observations.
  const cycles = Math.floor(frames / period)
  if (cycles < TEMPO_COMB_MIN_HARMONICS) return 0
  let coherent = 0
  let energy = 0
  for (let phase = 0; phase < period; phase += 1) {
    let total = 0
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const value = envelope[cycle * period + phase]
      total += value
      energy += value * value
    }
    coherent += total * total / cycles
  }
  return energy > 1e-12 ? coherent / energy : 0
}

/** Best tempo (as BPM) of a discrete curve inside [lo, hi], 0 when none. */
function bestBpmInBand(
  curve: Float64Array,
  lo: number,
  hi: number,
  framesPerSecond: number,
  bandLo: number,
  bandHi: number
): number {
  let bestIndex = -1
  let bestValue = 0
  for (let lag = Math.max(2, lo); lag <= hi; lag += 1) {
    const bpm = (framesPerSecond * 60) / lag
    if (bandLo > 0 && (bpm < bandLo || bpm > bandHi)) continue
    if (curve[lag] > bestValue) {
      bestValue = curve[lag]
      bestIndex = lag
    }
  }
  if (bestIndex < 0 || !(bestValue > 0)) return 0
  const refined = parabolicLag(curve, bestIndex, Math.max(2, lo), hi)
  return (framesPerSecond * 60) / refined
}

/** Best tempo of the comb curve, restricted to lags with enough teeth. */
function combBpmInBand(
  comb: Float64Array,
  lo: number,
  hi: number,
  framesPerSecond: number
): number {
  let bestIndex = -1
  let bestValue = 0
  for (let lag = Math.max(2, lo); lag <= hi; lag += 1) {
    if (comb[lag] > bestValue) {
      bestValue = comb[lag]
      bestIndex = lag
    }
  }
  if (bestIndex < 0 || !(bestValue > 0)) return 0
  const refined = parabolicLag(comb, bestIndex, Math.max(2, lo), hi)
  return (framesPerSecond * 60) / refined
}

/**
 * Do the two periodicity methods name the same pulse?
 *
 * "Same" means within TEMPO_AGREEMENT_TOLERANCE (3 %) of the chosen tempo, and
 * — importantly — an exact octave between them counts as *disagreement about
 * which metrical level*, not agreement, because that is precisely the ambiguity
 * worth warning about.
 */
function tempoAgreement(
  chosen: number,
  autocorrelationBpm: number,
  combBpm: number
): { corroborated: boolean; note: string } {
  const terms: string[] = []
  let agreed = 0
  let considered = 0

  const check = (method: string, value: number): void => {
    if (!(value > 0)) return
    considered += 1
    const ratio = value / chosen
    if (Math.abs(ratio - 1) <= TEMPO_AGREEMENT_TOLERANCE) {
      agreed += 1
    } else if (Math.abs(ratio - 2) <= TEMPO_AGREEMENT_TOLERANCE || Math.abs(ratio - 0.5) <= TEMPO_AGREEMENT_TOLERANCE) {
      terms.push(`${method} read ${value.toFixed(1)} BPM, an octave away`)
    } else {
      terms.push(`${method} read ${value.toFixed(1)} BPM`)
    }
  }

  check('autocorrelation', autocorrelationBpm)
  check('comb filter', combBpm)

  if (considered === 0) {
    return { corroborated: false, note: 'Only one periodicity method produced a peak; the reading is uncorroborated.' }
  }
  if (agreed === considered) return { corroborated: true, note: '' }

  const detail = terms.length > 0 ? ` (${terms.join('; ')})` : ''
  return {
    corroborated: false,
    note: `Autocorrelation and comb-filter periodicity disagree on the beat${detail}.`
  }
}

/** Octave suppression: is `bpm` the same reading as anything already picked? */
function isSuppressed(bpm: number, used: number[]): boolean {
  for (const other of used) {
    const ratio = bpm / other
    if (Math.abs(ratio - 1) <= TEMPO_SUPPRESS_RATIO) return true
    if (Math.abs(ratio - 2) <= TEMPO_SUPPRESS_RATIO) return true
    if (Math.abs(ratio - 0.5) <= TEMPO_SUPPRESS_RATIO) return true
  }
  return false
}

/** Builds the de-trended, level-normalised onset envelope. */
function spectralFluxEnvelope(
  pcm: Float32Array,
  fftSize: number,
  hop: number,
  frames: number,
  bins: number,
  level: number
): Float64Array {
  const fft = new Fft(fftSize)
  const window = hannWindow(fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  const current = new Float64Array(bins)
  const previous = new Float64Array(bins)
  const envelope = new Float64Array(frames)

  // Log compression compresses the dynamic range of the flux, so a loud kick
  // does not drown out quiet hi-hat motion.
  // Relative to signal level: log(magnitude + 1e-6) previously amplified
  // stationary-tone FFT leakage into a strong artificial onset envelope.
  const LOG_FLOOR = Math.max(1e-9, level * fftSize * 0.01)

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * hop
    for (let i = 0; i < fftSize; i += 1) {
      re[i] = pcm[offset + i] * window[i]
      im[i] = 0
    }
    fft.forward(re, im)

    let flux = 0
    for (let bin = 0; bin < bins; bin += 1) {
      const magnitude = Math.hypot(re[bin], im[bin])
      const logMagnitude = Math.log1p(magnitude / LOG_FLOOR)
      current[bin] = logMagnitude
      if (frame > 0) {
        const diff = logMagnitude - previous[bin]
        // Half-wave rectification: only rising energy is an onset.
        if (diff > 0) flux += diff
      }
    }
    envelope[frame] = flux
    previous.set(current)
  }

  // First frame has no predecessor; mirror the second so it neither adds a
  // spurious onset nor biases the moving mean.
  if (frames > 1) envelope[0] = envelope[1]

  return envelope
}

/**
 * Subtracts a centred moving mean of width `ONSET_TREND_SEC` and divides by the
 * mean absolute deviation, giving a scale-free, mean-zero onset envelope.
 */
function detrendEnvelope(envelope: Float64Array, framesPerSecond: number): Float64Array {
  const frames = envelope.length
  const out = new Float64Array(frames)
  const half = Math.max(1, Math.round((ONSET_TREND_SEC * framesPerSecond) / 2))

  // Prefix sums make the moving mean O(1) per frame and reproducible exactly.
  const prefix = new Float64Array(frames + 1)
  for (let i = 0; i < frames; i += 1) prefix[i + 1] = prefix[i] + envelope[i]

  for (let i = 0; i < frames; i += 1) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(frames, i + half + 1)
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo)
    const centred = envelope[i] - mean
    out[i] = centred > 0 ? centred : 0
  }

  let sum = 0
  for (let i = 0; i < frames; i += 1) sum += out[i]
  const scale = sum / frames
  if (scale > 1e-9) {
    for (let i = 0; i < frames; i += 1) out[i] /= scale
  }
  return out
}

/**
 * Pearson correlation between the envelope and itself at `lag`, computed over
 * the overlapping window only. Correlating each window against its own mean is
 * what makes a sparse click envelope behave: the long run of zeros between hits
 * contributes nothing rather than dragging the coefficient down.
 */
function normalisedAutocorrelation(x: Float64Array, n: number, lag: number): number {
  const count = n - lag
  if (count < 4) return 0

  let sumA = 0
  let sumB = 0
  for (let i = 0; i < count; i += 1) {
    sumA += x[i]
    sumB += x[i + lag]
  }
  const meanA = sumA / count
  const meanB = sumB / count

  let covariance = 0
  let varianceA = 0
  let varianceB = 0
  for (let i = 0; i < count; i += 1) {
    const a = x[i] - meanA
    const b = x[i + lag] - meanB
    covariance += a * b
    varianceA += a * a
    varianceB += b * b
  }

  const denominator = Math.sqrt(varianceA * varianceB)
  if (!(denominator > 1e-12)) return 0
  const value = covariance / denominator
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0
}

/**
 * Gaussian prior on log-tempo (see `TEMPO_PRIOR_SIGMA_OCTAVES` for the source).
 * Multiplicative, so a tempo the signal does not support can never be created.
 */
function tempoPrior(bpm: number): number {
  if (!(bpm > 0)) return 0
  const octaves = Math.log2(bpm / TEMPO_PRIOR_CENTRE_BPM)
  const z = octaves / TEMPO_PRIOR_SIGMA_OCTAVES
  const value = Math.exp(-0.5 * z * z)
  return Number.isFinite(value) ? value : 0
}

/**
 * Parabolic interpolation of a discrete peak, carried out in log-lag space.
 * Tempo is proportional to 1/lag, so log-lag is the natural axis: a parabola
 * there is very close to a parabola in log-BPM, and the returned lag is the
 * sub-sample location of the true maximum.
 */
function parabolicLag(curve: Float64Array, index: number, lo: number, hi: number): number {
  if (index <= lo || index >= hi) return index
  const left = curve[index - 1]
  const centre = curve[index]
  const right = curve[index + 1]
  const denominator = left - 2 * centre + right
  if (!(Math.abs(denominator) > 1e-12)) return index
  const delta = clamp((0.5 * (left - right)) / denominator, -0.5, 0.5)
  const refined = index + delta
  if (!Number.isFinite(refined) || refined <= 0) return index
  return refined
}

/** Refine every reported metrical level, including alternatives, from the
 * strongest nearby autocorrelation period. Longer periods reduce frame-grid
 * quantization without imposing a new metrical interpretation. */
function refineTempoPeriod(bpm: number, curve: Float64Array, fps: number, lo: number, hi: number): number {
  let measured = bpm
  let strongest = 0
  for (const multiple of [1, 2, 4]) {
    const centre = Math.round(fps * 60 / bpm * multiple)
    for (let lag = centre - 1; lag <= centre + 1; lag += 1) {
      if (lag <= lo || lag >= hi) continue
      if (curve[lag] < curve[lag - 1] || curve[lag] < curve[lag + 1] || curve[lag] <= strongest) continue
      const candidate = fps * 60 * multiple / parabolicLag(curve, lag, lo, hi)
      if (Math.abs(candidate / bpm - 1) > 0.05) continue
      strongest = curve[lag]
      measured = candidate
    }
  }
  return measured
}

/** Linear interpolation of a curve at a fractional index. */
function interpolateAt(curve: Float64Array, position: number): number {
  const lo = Math.floor(position)
  const hi = Math.min(curve.length - 1, lo + 1)
  if (lo < 0) return curve[0]
  const t = position - lo
  return curve[lo] * (1 - t) + curve[hi] * t
}

/** Strongest peak within ±`tolerance` BPM of `target`, skipping seen readings. */
function strongestPeakNear(
  peaks: TempoPeak[],
  target: number,
  tolerance: number,
  exclude: number[]
): TempoPeak | null {
  let best: TempoPeak | null = null
  for (const peak of peaks) {
    if (Math.abs(peak.bpm - target) > tolerance) continue
    // Octave candidates are intentionally being requested here. Suppressing
    // half/double relationships would reject every legitimate alternative.
    if (exclude.some((bpm) => Math.abs(peak.bpm / bpm - 1) <= TEMPO_SUPPRESS_RATIO)) continue
    if (!best || peak.strength > best.strength) best = peak
  }
  return best
}

/**
 * Confidence formula — a *normalised prominence*, NOT a probability:
 *
 *             peak      − background
 *   conf  =  ────────────────────────      clamped to 0..1
 *             peak      + background
 *
 * where `peak` is the prior-weighted combined periodicity at the winning peak
 * and `background` is the median of the un-prior-ed combined curve inside a
 * ±20 % band around the peak's lag (i.e. the local noise floor the peak has to
 * stand above, which is a fairer comparison than the curve's global mean because
 * periodicity magnitude drifts with lag). For a perfect impulse train the
 * background is ~0 and confidence approaches 1; for a flat, aperiodic envelope
 * peak ≈ background and confidence approaches 0.
 *
 * `background` is floored at a small positive value so the ratio stays finite.
 * The caller additionally scales this down when the autocorrelation and comb
 * filter disagree about the beat (see `TEMPO_DISAGREE_CONFIDENCE_SCALE`), so the
 * final reported confidence also encodes method agreement.
 */
function peakProminence(
  combined: Float64Array,
  lagMin: number,
  lagMax: number,
  framesPerBpm: number,
  peak: TempoPeak
): number {
  const lag = framesPerBpm / Math.max(1e-6, peak.bpm)
  const half = Math.max(2, Math.round(lag * 0.2))

  const lo = Math.max(lagMin, Math.round(lag) - half)
  const hi = Math.min(lagMax, Math.round(lag) + half)
  const window: number[] = []
  for (let i = lo; i <= hi; i += 1) {
    // Skip the peak's own neighbourhood so it is not its own background.
    if (Math.abs(i - lag) < 2) continue
    window.push(combined[i])
  }
  if (window.length === 0) return clamp01(peak.strength)
  window.sort((a, b) => a - b)
  const background = Math.max(1e-6, window[window.length >> 1])

  const value = peak.strength
  if (!(value > 0)) return 0
  return clamp01((value - background) / (value + background))
}

/** Builds an inconclusive tempo result with a human-readable reason. */
function inconclusiveTempo(warning: string): TempoAnalysis {
  const base = emptyTempoAnalysis()
  const status: FieldAnalysisStatus = 'inconclusive'
  return {
    ...base,
    status,
    bpm: null,
    bpmExact: null,
    alternatives: [],
    confidence: null,
    warning
  }
}

/* ------------------------------------------------------------------------- */
/* estimateKey                                                                */
/* ------------------------------------------------------------------------- */

/** One candidate key and its Krumhansl–Schmuckler correlation. */
interface KeyCandidate {
  key: string
  camelot: string | null
  correlation: number
  pitchClass: number
  mode: 'major' | 'minor'
}

/**
 * Estimates musical key from the audio signal.
 *
 * Pipeline: Hann-windowed STFT (long window, fine low-frequency resolution) →
 * spectral peak picking with local whitening → harmonic summation into a fine
 * 10-cent pitch histogram → global tuning offset from histogram alignment →
 * fold to a 12-bin chroma → median/mean blend across frames →
 * Krumhansl–Schmuckler Pearson correlation against all 24 major/minor
 * rotations.
 */
export function estimateKey(input: AnalysisInput): KeyAnalysis {
  try {
    return estimateKeyInner(input)
  } catch {
    const failed = emptyKeyAnalysis()
    return { ...failed, status: 'failed', warning: 'Key analysis failed unexpectedly.' }
  }
}

function estimateKeyInner(input: AnalysisInput): KeyAnalysis {
  const pcm = input.pcm
  const sampleRate = Math.floor(finiteOr(input.sampleRate, 0))
  const samples = pcm && typeof pcm.length === 'number' ? pcm.length : 0

  if (samples === 0) {
    return inconclusiveKey('No audio samples were available to analyse.')
  }
  if (sampleRate <= 0) {
    return inconclusiveKey('The sample rate was invalid, so the key could not be estimated.')
  }

  const seconds = samples / sampleRate
  const level = rms(pcm, 0, samples)
  if (!(level > 1e-6)) {
    return inconclusiveKey('The audio is silent, so no key could be estimated.')
  }

  const fftSize = fftSizeFor(
    Math.max(2, Math.round(KEY_WINDOW_SEC * sampleRate)),
    KEY_MIN_FFT,
    KEY_MAX_FFT
  )
  const hop = Math.max(1, Math.round(fftSize * KEY_HOP_RATIO))
  const bins = fftSize >> 1
  const availableFrames = samples >= fftSize ? 1 + Math.floor((samples - fftSize) / hop) : 0
  const maxFrames = Math.floor((KEY_MAX_SECONDS * sampleRate) / hop)
  const frames = Math.min(availableFrames, maxFrames)

  if (seconds < KEY_MIN_AUDIO_SEC || frames < KEY_MIN_FRAMES) {
    return inconclusiveKey(
      `Only ${seconds.toFixed(1)} s of audio was available; at least ${KEY_MIN_AUDIO_SEC} s is needed to establish a key.`
    )
  }

  const binHz = sampleRate / fftSize

  // ---- fine pitch histogram ----------------------------------------------
  const fine = new Float64Array(TUNING_FINE_BINS)
  const frameFine = new Float64Array(TUNING_FINE_BINS)
  const fft = new Fft(fftSize)
  const window = hannWindow(fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  const magnitudes = new Float64Array(bins)

  // Chroma runs over the register where fundamentals and the first strong
  // partials live. Above ~3 kHz the spectrum is dense with high harmonics that
  // carry little tonal information and would dilute the profile.
  const minPeakBin = Math.max(1, Math.ceil(CHROMA_MIN_HZ / binHz))
  const maxPeakBin = Math.min(bins - 2, Math.floor(CHROMA_MAX_HZ / binHz))

  let accumulated = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * hop
    const frameLevel = rms(pcm, offset, offset + fftSize)
    // Near-silent frames contribute only numerical dust; skipping them keeps
    // the chroma from turning into an average of the noise floor.
    if (!(frameLevel > level * 0.15)) continue

    for (let i = 0; i < fftSize; i += 1) {
      re[i] = pcm[offset + i] * window[i]
      im[i] = 0
    }
    fft.forward(re, im)
    for (let bin = 0; bin < bins; bin += 1) {
      magnitudes[bin] = Math.hypot(re[bin], im[bin])
    }

    frameFine.fill(0)
    accumulateChroma(magnitudes, binHz, minPeakBin, maxPeakBin, frameFine)
    let frameTotal = 0
    for (const value of frameFine) frameTotal += value
    if (!(frameTotal > 1e-9)) continue
    // Give each usable observation equal mass. Summing raw spectral energy
    // allowed lower-register / louder chords to dominate the entire excerpt.
    for (let bin = 0; bin < fine.length; bin += 1) fine[bin] += frameFine[bin] / frameTotal
    accumulated += 1
  }

  let fineTotal = 0
  for (let i = 0; i < TUNING_FINE_BINS; i += 1) fineTotal += fine[i]

  if (accumulated < KEY_MIN_FRAMES || !(fineTotal > 1e-9)) {
    return inconclusiveKey('Too little pitched material was present to establish a key.')
  }

  // ---- global tuning ------------------------------------------------------
  const tuningCents = estimateTuningCents(fine)

  // ---- chroma -------------------------------------------------------------
  const chroma = foldToChroma(fine, tuningCents)

  // ---- chroma energy / variance guard ------------------------------------
  // A Pearson correlation against an all-zero (or numerically dead) chroma is 0
  // *by construction*, which is indistinguishable from "no key found" if the
  // correlation alone is trusted. So the chroma is validated as a distribution
  // before any correlation is believed: it must carry real total energy and a
  // real spread across pitch classes. Frames are gated and the histogram is
  // accumulated from real spectral peaks, so reaching here with a dead chroma
  // means the material genuinely had no pitched content (all-percussion, DC
  // offset, pure noise beneath the gate).
  let chromaEnergy = 0
  for (let i = 0; i < 12; i += 1) chromaEnergy += chroma[i]
  const chromaVariance = chromaVarianceOf(chroma)
  if (!(chromaEnergy > KEY_MIN_CHROMA_ENERGY) || !(chromaVariance > KEY_MIN_CHROMA_VARIANCE)) {
    return {
      ...inconclusiveKey(
        `The chroma profile carried no usable pitch content (energy ${chromaEnergy.toFixed(3)}, variance ${chromaVariance.toExponential(1)}).`
      ),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }

  // ---- Krumhansl–Schmuckler ----------------------------------------------
  const candidates = correlateKeyProfiles(chroma)
  const winner = candidates[0]

  const entropy = chromaEntropy(chroma)
  const absolute = Math.abs(winner.correlation)
  if (absolute < KEY_MIN_CORRELATION) {
    return {
      ...inconclusiveKey(
        `The chroma profile was too weakly tonal (best correlation ${absolute.toFixed(2)}); the material may be percussive or unpitched.`
      ),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }
  if (entropy > KEY_MAX_ENTROPY) {
    return {
      ...inconclusiveKey(
        `The chroma profile was nearly flat (entropy ${entropy.toFixed(2)}); no single tonal centre dominated.`
      ),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }
  if (entropy < KEY_MIN_ENTROPY) {
    return {
      ...inconclusiveKey(
        `The audio was dominated by a single pitch (entropy ${entropy.toFixed(2)}), which is not enough to establish a key.`
      ),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }

  // ---- alternatives -------------------------------------------------------
  // Relative major/minor is the dominant real-world confusion: the two scales
  // share 7 of 12 pitch classes, so the runner-up for a tonal excerpt is
  // usually its relative key. It is surfaced explicitly and guaranteed a slot
  // rather than being left to chance in the ranking, because it is the single
  // most useful thing to show next to the winner.
  const alternatives = selectKeyAlternatives(candidates, winner)
  const relative = candidates.find((candidate) => candidate.key === relativeKeyOf(winner.key))
  if (relative && winner.correlation - relative.correlation < 0.12) {
    // A histogram cannot distinguish relative modes reliably when their
    // evidence is this close. Preserve the ranked evidence for review, rather
    // than converting a small scoring margin into a definitive major key.
    return {
      ...inconclusiveKey(`Relative-key ambiguity: ${winner.key} and ${relative.key} have similar acoustic support.`),
      alternatives: [winner, ...alternatives].slice(0, KEY_MAX_ALTERNATIVES).map(({ key, camelot, correlation }) => ({ key, camelot, correlation })),
      tuningCents: roundToStep(tuningCents, 0.1)
    }
  }

  return {
    status: 'estimated',
    key: winner.key,
    camelot: winner.camelot,
    correlation: winner.correlation,
    alternatives,
    confidence: keyConfidence(candidates),
    tuningCents: roundToStep(tuningCents, 0.1),
    warning: null
  }
}

/**
 * Chooses the reported alternatives: the best few rotations by correlation, with
 * the relative major/minor of the winner guaranteed a place when it is close
 * enough to be a plausible reading.
 *
 * Ranking is by correlation (best-first) and the winner is never duplicated.
 */
function selectKeyAlternatives(candidates: KeyCandidate[], winner: KeyCandidate): KeyAlternative[] {
  const relativeKeyName = relativeKeyOf(winner.key)
  const isRelative = (candidate: KeyCandidate): boolean => candidate.key === relativeKeyName

  const ranked = candidates.filter((candidate) => candidate.key !== winner.key)
  const selected = ranked.slice(0, KEY_MAX_ALTERNATIVES)

  // Guarantee the relative key a slot when it is within
  // KEY_RELATIVE_SURFACE_MARGIN of the top correlation — i.e. genuinely
  // competitive, not merely present.
  const relative = ranked.find(isRelative)
  if (
    relative &&
    !selected.some(isRelative) &&
    Math.abs(relative.correlation) >= Math.abs(winner.correlation) - KEY_RELATIVE_SURFACE_MARGIN
  ) {
    selected.pop()
    selected.push(relative)
  }

  // Re-sort so the array is always strongest-first, whatever path built it.
  selected.sort((a, b) => b.correlation - a.correlation || a.pitchClass - b.pitchClass)

  return selected.map((candidate) => ({
    key: candidate.key,
    camelot: candidate.camelot,
    correlation: finiteOr(candidate.correlation, 0)
  }))
}

/** `C major` → `A minor` and vice versa; null when the string is not canonical. */
function relativeKeyOf(key: string): string | null {
  const match = /^([A-G]#?) (major|minor)$/.exec(key)
  if (!match) return null
  const index = SHARP_NAMES.indexOf(match[1] as (typeof SHARP_NAMES)[number])
  if (index < 0) return null
  return match[2] === 'major'
    ? `${SHARP_NAMES[(index + 9) % 12]} minor`
    : `${SHARP_NAMES[(index + 3) % 12]} major`
}

/** Population variance of the 12 chroma bins. */
function chromaVarianceOf(chroma: Float64Array): number {
  let mean = 0
  for (let i = 0; i < 12; i += 1) mean += chroma[i]
  mean /= 12
  let variance = 0
  for (let i = 0; i < 12; i += 1) {
    const d = chroma[i] - mean
    variance += d * d
  }
  variance /= 12
  return Number.isFinite(variance) ? variance : 0
}

/**
 * Splits one frame's spectrum into partials and adds each partial, plus its
 * implied harmonic series, to the fine pitch histogram.
 *
 * Approach (harmonic summation, not naive bin → nearest note): every spectral
 * peak is assumed to be the h-th harmonic of *some* fundamental. It therefore
 * contributes
 *
 *     magnitude / h          (the harmonic-rolloff weight)
 *
 * to the pitch class of `frequency / h`. The peak also contributes a smaller
 * share to its own pitch class, which keeps a strong fundamental honest when
 * its harmonic series is ambiguous. This is what makes a violin's or a piano's
 * upper partials reinforce the right note instead of voting for the wrong one:
 * a 3rd harmonic of C votes for C (as f/3), not for G.
 *
 * Local whitening (`magnitude / local mean`) keeps a loud low note from
 * out-voting the rest of the chord.
 *
 * Documented tradeoff: the literature standard for this step is a
 * non-negative least-squares fit of the spectrum to a harmonic dictionary
 * (Mauch & Dixon, "pYIN"/"Approximate note transcription", and their 2010
 * ISMIR chroma work), which resolves overlapping partials more accurately than
 * greedy harmonic summation. Plain harmonic summation is used here because it
 * is deterministic, allocation-light, and an order of magnitude cheaper; NNLS
 * would be the upgrade path if polyphonic chroma accuracy proves to be the
 * limiting factor on real material.
 */
/**
 * Accumulates a pitch-class histogram from the magnitude spectrum.
 *
 * Each spectral bin votes for the pitch class of its **own** frequency
 * (a Fujishima-style pitch-class profile). This works because the harmonic
 * series of a note reinforces musically related pitch classes: the first five
 * harmonics of a major triad's root land on the root, the fifth and the third.
 *
 * Two details matter more than they look:
 *
 * 1. **Weight by 1/f.** The FFT is linear in frequency, so a semitone near
 *    2 kHz spans roughly twenty times as many bins as one near 100 Hz. Without
 *    the 1/f factor the dense high-frequency region dominates the histogram
 *    purely because it has more bins, and the chord tones disappear into it.
 *
 * 2. **Do not vote for every sub-harmonic.** An earlier version added each peak
 *    at `f/h` for h = 1…8. That makes every partial vote for a whole series of
 *    unrelated pitch classes, which flattens the histogram into near-uniform
 *    noise — destroying key detection and making the tuning objective
 *    meaningless. Reinforcing multiples is safe; dividing is not.
 */
function accumulateChroma(
  magnitudes: Float64Array,
  binHz: number,
  minPeakBin: number,
  maxPeakBin: number,
  fine: Float64Array
): void {
  if (maxPeakBin <= minPeakBin) return

  for (let bin = minPeakBin; bin <= maxPeakBin; bin += 1) {
    const magnitude = magnitudes[bin]
    if (!(magnitude > 0)) continue

    const frequency = bin * binHz
    if (frequency < CHROMA_MIN_HZ || frequency > CHROMA_MAX_HZ) continue

    // Power per unit frequency: concentrates the histogram on fundamentals and
    // the first few strong partials rather than the dense upper spectrum.
    const weight = (magnitude * magnitude) / frequency
    addToFineHistogram(fine, frequency, weight)
  }
}

/**
 * Adds `weight` at the pitch of `frequency` into the fine histogram.
 *
 * `frequency` is mapped to the fractional semitone relative to A440 and then
 * modulo 12, i.e. a pitch class in semitones with 100 bins per semitone
 * (10 cents). Linear interpolation between the two neighbouring bins keeps a
 * 1-cent tuning shift visible in the histogram, which is what makes the tuning
 * estimate below possible at all.
 */
function addToFineHistogram(fine: Float64Array, frequency: number, weight: number): void {
  if (!(frequency > 0) || !(weight > 0)) return
  const semitonesFromA = 12 * Math.log2(frequency / 440)
  if (!Number.isFinite(semitonesFromA)) return

  // Rotate so that index 0 is **C**, not A.
  //
  // `log2(f/440)` makes A the reference, but `SHARP_NAMES` and the
  // Krumhansl–Kessler profiles are both C-referenced. Leaving the histogram
  // A-referenced shifts every pitch class by three semitones, which does not
  // look like a bug from the outside — it returns confident, plausible-looking
  // keys that are simply wrong (C major came back as D# major, F# minor as A
  // minor, Eb major as F# major). C is nine semitones above A.
  const semitonesFromC = semitonesFromA + 9
  const pitchClass = ((semitonesFromC % 12) + 12) % 12
  const position = pitchClass * TUNING_BINS_PER_SEMITONE

  const lo = Math.floor(position)
  const t = position - lo
  const a = ((lo % TUNING_FINE_BINS) + TUNING_FINE_BINS) % TUNING_FINE_BINS
  const b = (a + 1) % TUNING_FINE_BINS
  fine[a] += weight * (1 - t)
  fine[b] += weight * t
}

/**
 * Estimates the global tuning offset by maximising chroma peak alignment.
 *
 * For every candidate offset in ±`TUNING_SEARCH_CENTS` we rotate the fine
 * histogram and fold it into 12 semitone bins, then measure how concentrated
 * the result is with the sum of squared bin shares. A correctly tuned histogram
 * stacks all its mass on the semitone grid and scores high; a histogram detuned
 * by δ cents splits its mass between adjacent bins and scores low. The best
 * offset is refined by a parabolic fit over the three neighbouring candidates.
 *
 * This is an analysis-only correction: it aligns bins before the final chroma.
 */
function estimateTuningCents(fine: Float64Array): number {
  let bestCents = 0
  let bestScore = -Infinity
  const scores: number[] = []
  const offsets: number[] = []

  for (
    let cents = -TUNING_SEARCH_CENTS;
    cents <= TUNING_SEARCH_CENTS;
    cents += TUNING_STEP_CENTS
  ) {
    const score = foldedConcentration(fine, cents)
    scores.push(score)
    offsets.push(cents)
    if (score > bestScore) {
      bestScore = score
      bestCents = cents
    }
  }

  const index = offsets.indexOf(bestCents)

  // A genuine tuning offset produces an **interior** peak in the concentration
  // curve. If the maximum sits on the edge of the search range, the objective is
  // monotonic rather than peaked, which means it has not actually located a
  // tuning — it has simply run out of range. Reporting that boundary value would
  // rotate the chroma by up to half a semitone and smear every pitch class, so
  // "no reliable offset" returns 0 (no correction).
  if (index <= 0 || index >= scores.length - 1) return 0

  // The peak must also stand clear of the curve's own middle, or it is noise.
  const sorted = [...scores].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (!(bestScore > median * 1.001)) return 0

  if (index > 0 && index < scores.length - 1) {
    const left = scores[index - 1]
    const centre = scores[index]
    const right = scores[index + 1]
    const denominator = left - 2 * centre + right
    if (Math.abs(denominator) > 1e-12) {
      const delta = clamp((0.5 * (left - right)) / denominator, -0.5, 0.5)
      bestCents += delta * TUNING_STEP_CENTS
    }
  }

  return clamp(finiteOr(bestCents, 0), -TUNING_SEARCH_CENTS, TUNING_SEARCH_CENTS)
}

/**
 * Folds the fine pitch-class histogram into 12 chroma bins, rotated by
 * `shiftBins` fine bins (used for the tuning correction).
 *
 * The fine histogram has `TUNING_BINS_PER_SEMITONE` (100) bins per semitone, so
 * the pitch class of fine bin `i` is
 * `floor(i / TUNING_BINS_PER_SEMITONE) mod 12`.
 *
 * Deriving it as `i mod 12` instead — which is easy to write by mistake, because
 * both numbers are 12-ish — cycles through all twelve pitch classes *within a
 * single semitone*. That scrambles the distribution into something nearly
 * uniform: key detection collapses to a flat chroma, and the tuning objective
 * (peak concentration) becomes meaningless, so the search wanders to the edge of
 * its range. Both callers therefore share this one implementation, so the two
 * folds cannot drift apart.
 */
function foldFineToChroma(fine: Float64Array, shiftBins: number, out: Float64Array): void {
  const total = TUNING_FINE_BINS
  const semitoneShift = shiftBins / TUNING_BINS_PER_SEMITONE

  for (let i = 0; i < total; i += 1) {
    const value = fine[i]
    if (!(value > 0)) continue

    // Position in semitones, rotated by the tuning shift, wrapped to one octave.
    let semitone = (i - semitoneShift) / TUNING_BINS_PER_SEMITONE
    semitone = ((semitone % 12) + 12) % 12

    const lo = Math.floor(semitone)
    const t = semitone - lo
    const a = lo % 12
    const b = (a + 1) % 12

    out[a] += value * (1 - t)
    out[b] += value * t
  }
}

/** Sum of squared bin shares after folding the histogram at `cents`. */
function foldedConcentration(fine: Float64Array, cents: number): number {
  const folded = new Float64Array(12)
  foldFineToChroma(fine, (cents * TUNING_BINS_PER_SEMITONE) / 100, folded)

  let sum = 0
  let sumSquares = 0
  for (let i = 0; i < 12; i += 1) {
    sum += folded[i]
    sumSquares += folded[i] * folded[i]
  }
  if (!(sum > 0)) return 0
  return sumSquares / (sum * sum)
}

/** Folds the tuned fine histogram into a 12-bin, L1-normalised chroma. */
function foldToChroma(fine: Float64Array, tuningCents: number): Float64Array {
  const chroma = new Float64Array(12)
  foldFineToChroma(fine, (tuningCents * TUNING_BINS_PER_SEMITONE) / 100, chroma)

  let sum = 0
  for (let i = 0; i < 12; i += 1) sum += chroma[i]
  if (sum > 0) {
    for (let i = 0; i < 12; i += 1) chroma[i] /= sum
  }
  return chroma
}

/**
 * Normalised Shannon entropy of the chroma, in 0..1 (divided by ln 12).
 * ~1 means perfectly flat (no tonal centre); a clean triad lands well below.
 */
function chromaEntropy(chroma: Float64Array): number {
  let entropy = 0
  for (let i = 0; i < 12; i += 1) {
    const p = chroma[i]
    if (p > 1e-12) entropy -= p * Math.log(p)
  }
  const normalised = entropy / Math.log(12)
  return clamp01(finiteOr(normalised, 1))
}

/**
 * Pearson-correlates the chroma against all 24 rotations of the
 * Krumhansl–Kessler major and minor profiles and returns them best-first.
 */
function correlateKeyProfiles(chroma: Float64Array): KeyCandidate[] {
  const candidates: KeyCandidate[] = []
  const profiles: { mode: 'major' | 'minor'; profile: readonly number[] }[] = [
    { mode: 'major', profile: KK_MAJOR },
    { mode: 'minor', profile: KK_MINOR }
  ]

  for (const { mode, profile } of profiles) {
    // A profile vector and the chroma both hold 12 equal-length vectors; the
    // profile statistics are rotation-invariant, so they are computed once.
    let profileMean = 0
    for (let i = 0; i < 12; i += 1) profileMean += profile[i]
    profileMean /= 12
    let profileVariance = 0
    for (let i = 0; i < 12; i += 1) {
      const d = profile[i] - profileMean
      profileVariance += d * d
    }
    const profileStd = Math.sqrt(profileVariance)

    let chromaMean = 0
    for (let i = 0; i < 12; i += 1) chromaMean += chroma[i]
    chromaMean /= 12
    let chromaVariance = 0
    for (let i = 0; i < 12; i += 1) {
      const d = chroma[i] - chromaMean
      chromaVariance += d * d
    }
    const chromaStd = Math.sqrt(chromaVariance)

    for (let tonic = 0; tonic < 12; tonic += 1) {
      let correlation = 0
      if (profileStd > 1e-12 && chromaStd > 1e-12) {
        let covariance = 0
        for (let i = 0; i < 12; i += 1) {
          covariance += (chroma[(i + tonic) % 12] - chromaMean) * (profile[i] - profileMean)
        }
        correlation = covariance / (chromaStd * profileStd)
      }
      const key = `${SHARP_NAMES[tonic]} ${mode}`
      candidates.push({
        key,
        camelot: camelotFor(SHARP_NAMES[tonic], mode),
        correlation: clamp(finiteOr(correlation, 0), -1, 1),
        pitchClass: tonic,
        mode
      })
    }
  }

  // Deterministic tie-break: correlation first, then the fixed SHARP_NAMES
  // order, then major before minor.
  candidates.sort(
    (a, b) =>
      b.correlation - a.correlation ||
      a.pitchClass - b.pitchClass ||
      (a.mode === b.mode ? 0 : a.mode === 'major' ? -1 : 1)
  )
  return candidates
}

/**
 * Confidence formula — the geometric mean of two normalised terms, NOT a
 * probability:
 *
 *   margin     = clamp01((best − runnerUp) / 0.25)
 *   absolute   = clamp01(|best| / 0.9)
 *   confidence = sqrt(margin × absolute)          clamped to 0..1
 *
 * `margin` says the winner beat the field; `absolute` says the winner is a
 * genuinely good fit rather than the least-bad of 24 bad fits. Requiring both
 * (geometric mean) is what stops an ambiguous piece from scoring high just
 * because one rotation happened to win by a hair, and stops a strong-but-flat
 * result from scoring high on margin alone. The divisors 0.25 and 0.9 are the
 * scale of a clearly-decided and a clearly-tonal result respectively.
 *
 * Relative-major/minor confusion is the dominant real-world error mode, and it
 * shows up here naturally: when a piece is genuinely ambiguous between a key
 * and its relative, the two correlations are close, `margin` collapses, and
 * confidence falls with it — which is the correct outcome. The relative key is
 * also forced into `alternatives` (see `selectKeyAlternatives`) so the ambiguity
 * is visible to the user rather than hidden behind one number.
 */
function keyConfidence(candidates: KeyCandidate[]): number {
  if (candidates.length < 2) return 0
  const best = Math.abs(candidates[0].correlation)
  const runnerUp = Math.abs(candidates[1].correlation)
  const margin = clamp01((best - runnerUp) / 0.25)
  const absolute = clamp01(best / 0.9)
  return clamp01(Math.sqrt(margin * absolute))
}

/** Builds an inconclusive key result with a human-readable reason. */
function inconclusiveKey(warning: string): KeyAnalysis {
  const base = emptyKeyAnalysis()
  const status: FieldAnalysisStatus = 'inconclusive'
  return {
    ...base,
    status,
    key: null,
    camelot: null,
    alternatives: [],
    confidence: null,
    tuningCents: null,
    warning
  }
}
