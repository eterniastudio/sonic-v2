#!/usr/bin/env node
/**
 * Synthetic tempo matrix with an optional same-process baseline comparison.
 *
 *   node scripts/benchmark-tempo.mjs [--baseline-ref REF] [--report PATH] [--strict]
 *
 * Patterns (each rendered at 70–174 BPM, in 14 s and 150 s windows):
 *   click      equal hits on every beat
 *   kick-hat   kick on every beat, quieter hat on every off-beat
 *   kit        kick on 1 and 3, snare on 2 and 4, closed hats on every eighth
 * Variants: clean, and (for kick-hat / kit) swung hats + ±3 ms timing jitter +
 * velocity variation + a broadband noise bed; clicks get the noise bed and
 * jitter only.
 *
 * The generating BPM is the quarter-note rate by construction. It is held by
 * this script only; estimateTempo receives PCM, sample rate and duration. The
 * signals are controlled engineering fixtures: a pass here is evidence about
 * period measurement and octave choice on clean material, not about accuracy on
 * real productions. With --strict the run exits 1 unless every case is exact
 * within ±0.5 BPM (used to keep a regression gate, not as a claim).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const options = { '--strict': false }
for (let i = 2; i < process.argv.length; i += 1) {
  const name = process.argv[i]
  if (name === '--strict') { options[name] = true; continue }
  const value = process.argv[i + 1]
  if (!['--baseline-ref', '--report'].includes(name) || !value || options[name]) {
    throw new Error('Expected --baseline-ref REF, --report PATH and/or --strict')
  }
  options[name] = value
  i += 1
}

const RATE = 22050
const TEMPOS = [70, 85, 90, 100, 120, 128, 140, 150, 160, 170, 174]
const WINDOWS = [14, 150]
const EXACT_BPM = 0.5
const METRICAL_RATIOS = [
  { ratio: 0.5, label: 'half' }, { ratio: 2, label: 'double' },
  { ratio: 1 / 3, label: 'third' }, { ratio: 3, label: 'triple' },
  { ratio: 2 / 3, label: '2/3' }, { ratio: 1.5, label: '3/2' }
]

/** mulberry32: deterministic, no Math.random. */
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

function addAt(buffer, index, value) {
  if (index >= 0 && index < buffer.length) buffer[index] += value
}

/** Noise burst plus a decaying low sine: kick (low body) or snare (higher body, longer burst). */
function addDrum(buffer, time, { gain, bodyHz, burstSec, bodySec, random }) {
  const start = Math.round(time * RATE)
  let previous = 0
  for (let i = 0, n = Math.round(burstSec * RATE); i < n; i += 1) {
    const envelope = Math.exp(-(i / RATE) / (burstSec / 3))
    previous = previous * 0.45 + (random() * 2 - 1) * 0.55
    addAt(buffer, start + i, previous * gain * 0.55 * envelope)
  }
  for (let i = 0, n = Math.round(bodySec * RATE); i < n; i += 1) {
    const t = i / RATE
    addAt(buffer, start + i, Math.sin(2 * Math.PI * bodyHz * t) * gain * 0.7 * Math.exp(-t / (bodySec / 4)))
  }
}

function addHat(buffer, time, gain, random) {
  const start = Math.round(time * RATE)
  let previous = 0
  for (let i = 0, n = Math.round(0.02 * RATE); i < n; i += 1) {
    const white = random() * 2 - 1
    addAt(buffer, start + i, (white - previous) * gain * Math.exp(-(i / RATE) / 0.005))
    previous = white
  }
}

function finalise(buffer) {
  let max = 0
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = Math.tanh(buffer[i] * 1.1)
    max = Math.max(max, Math.abs(buffer[i]))
  }
  if (max > 1e-9) for (let i = 0; i < buffer.length; i += 1) buffer[i] *= 0.85 / max
  return buffer
}

function render(pattern, bpm, seconds, variant, seed) {
  const buffer = new Float32Array(Math.round(RATE * seconds))
  const random = makeRandom(seed)
  const timing = makeRandom(seed + 17)
  const rough = variant === 'swing+noise' || variant === 'noise'
  const swing = variant === 'swing+noise' ? 0.08 : 0 // off-beat moved from 0.50 to 0.58 of a beat
  const jitter = () => (rough ? (timing() * 2 - 1) * 0.003 : 0)
  const velocity = () => (rough ? 0.85 + 0.15 * timing() : 1)
  const beat = 60 / bpm
  const kick = (time, g = 0.95) => addDrum(buffer, time + jitter(), { gain: g * velocity(), bodyHz: 58, burstSec: 0.04, bodySec: 0.14, random })
  const snare = (time) => addDrum(buffer, time + jitter(), { gain: 0.7 * velocity(), bodyHz: 185, burstSec: 0.09, bodySec: 0.06, random })
  const hat = (time, gain) => addHat(buffer, time + jitter(), gain * velocity(), random)
  for (let index = 0; index * beat < seconds; index += 1) {
    const time = index * beat
    if (pattern === 'click') {
      addDrum(buffer, time + jitter(), { gain: 0.8 * velocity(), bodyHz: 70, burstSec: 0.05, bodySec: 0.12, random })
    } else if (pattern === 'kick-hat') {
      kick(time)
      hat(time + beat * (0.5 + swing), 0.3)
    } else if (pattern === 'waltz') {
      // 3/4: kick on 1, hats on 2 and 3; the beat is the quarter note.
      if (index % 3 === 0) kick(time)
      else hat(time, 0.3)
    } else if (pattern === 'six-eight') {
      // 6/8 at a dotted-quarter `bpm`: kick on eighth 1, snare on eighth 4,
      // hats on every eighth. Rendered on the eighth grid below.
      break
    } else {
      if (index % 2 === 0) kick(time)
      else snare(time)
      hat(time, 0.22)
      hat(time + beat * (0.5 + swing), 0.18)
    }
  }
  if (pattern === 'six-eight') {
    const eighth = beat / 3
    for (let index = 0; index * eighth < seconds; index += 1) {
      const time = index * eighth
      if (index % 6 === 0) kick(time)
      if (index % 6 === 3) snare(time)
      hat(time, 0.2)
    }
  }
  if (rough) {
    const noise = makeRandom(seed + 29)
    for (let i = 0; i < buffer.length; i += 1) buffer[i] += (noise() * 2 - 1) * 0.04
  }
  return finalise(buffer)
}

function classify(analysis, expected) {
  if (analysis.status !== 'estimated' || analysis.bpm == null) return { outcome: 'inconclusive', relation: null }
  const bpm = analysis.bpmExact ?? analysis.bpm
  const error = bpm - expected
  if (Math.abs(error) <= EXACT_BPM) return { outcome: 'exact', relation: 'same', error }
  if (Math.abs(error) <= 2) return { outcome: 'near', relation: 'same', error }
  for (const { ratio, label } of METRICAL_RATIOS) {
    if (Math.abs(bpm / (expected * ratio) - 1) <= 0.02) return { outcome: 'metrical', relation: label, error }
  }
  return { outcome: 'other', relation: null, error }
}

function candidatesInclude(analysis, expected) {
  const values = [analysis.bpmExact ?? analysis.bpm, ...analysis.alternatives.map((a) => a.bpm)].filter((v) => v != null)
  return values.some((value) => Math.abs(value - expected) <= 2)
}

async function bundle(source, filename, directory) {
  const output = path.join(directory, filename)
  await build({ stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'src/main/analysis') }, outfile: output, bundle: true, format: 'esm', platform: 'neutral', target: 'node22', logLevel: 'silent' })
  return import(pathToFileURL(output).href)
}

function summarise(rows, field) {
  const counts = { total: rows.length, exact: 0, near: 0, metrical: 0, other: 0, inconclusive: 0, candidates: 0, warned: 0, methodsDisagree: 0 }
  for (const row of rows) {
    const result = row[field]
    if (!result) continue
    counts[result.outcome] += 1
    if (result.inCandidates) counts.candidates += 1
    if (result.warning) counts.warned += 1
    if (/disagree/.test(result.warning ?? '')) counts.methodsDisagree += 1
  }
  return counts
}

const hash = (source) => createHash('sha256').update(source).digest('hex')
const temporary = await mkdtemp(path.join(tmpdir(), 'sonic-tempo-matrix-'))
try {
  const source = await readFile(path.join(root, 'src/main/analysis/dsp.ts'), 'utf8')
  const current = await bundle(source, 'current.mjs', temporary)
  const baselineSource = options['--baseline-ref']
    ? execFileSync('git', ['show', `${options['--baseline-ref']}:src/main/analysis/dsp.ts`], { cwd: root, encoding: 'utf8', maxBuffer: 4e6, windowsHide: true })
    : null
  const baseline = baselineSource ? await bundle(baselineSource, 'baseline.mjs', temporary) : null
  const report = {
    schema: 'sonic-tempo-matrix/1',
    source: { currentSha256: hash(source), baselineSha256: baselineSource ? hash(baselineSource) : null, baselineRef: options['--baseline-ref'] ?? null },
    rules: { exactToleranceBpm: EXACT_BPM, metricalTolerance: '±2% of a 1/3, 1/2, 2/3, 3/2, 2 or 3 multiple', labelsReachDsp: false, fixtureType: 'synthetic', sampleRate: RATE },
    rows: []
  }
  const cases = []
  for (const pattern of ['click', 'kick-hat', 'kit']) {
    for (const variant of pattern === 'click' ? ['clean', 'noise'] : ['clean', 'swing+noise']) {
      for (const seconds of WINDOWS) {
        for (const bpm of TEMPOS) cases.push({ pattern, variant, seconds, bpm })
      }
    }
  }
  // Triple-meter controls: they guard the duple preference between 3:2-related
  // readings against converting a genuinely triple grouping. Reported apart
  // from the duple matrix.
  for (const pattern of ['waltz', 'six-eight']) {
    for (const seconds of WINDOWS) {
      for (const bpm of pattern === 'waltz' ? [90, 120, 150, 180] : [60, 70, 80, 90]) cases.push({ pattern, variant: 'clean', seconds, bpm, control: true })
    }
  }
  let sequence = 0
  for (const testCase of cases) {
    sequence += 1
    const pcm = render(testCase.pattern, testCase.bpm, testCase.seconds, testCase.variant, 1000 + sequence)
    const input = { pcm, sampleRate: RATE, sourceDurationSec: testCase.seconds }
    const row = { id: `t${String(sequence).padStart(3, '0')}`, ...testCase }
    for (const [field, implementation] of [['current', current], ['baseline', baseline]]) {
      if (!implementation) continue
      const started = performance.now()
      const analysis = implementation.estimateTempo(input)
      const elapsedMs = performance.now() - started
      row[field] = {
        ...classify(analysis, testCase.bpm),
        bpm: analysis.bpmExact ?? analysis.bpm,
        alternatives: analysis.alternatives.map((a) => `${a.bpm}${a.relation[0]}`),
        confidence: analysis.confidence,
        warning: analysis.warning,
        inCandidates: analysis.status === 'estimated' && candidatesInclude(analysis, testCase.bpm),
        elapsedMs
      }
    }
    report.rows.push(row)
    const show = (result) => result ? `${String(result.bpm == null ? '—' : result.bpm.toFixed(2)).padStart(7)} ${result.outcome.padEnd(12)}` : ''
    console.log(`${row.id} ${testCase.pattern.padEnd(8)} ${testCase.variant.padEnd(11)} ${String(testCase.seconds).padStart(3)}s ${String(testCase.bpm).padStart(3)} | now ${show(row.current)}${baseline ? `| before ${show(row.baseline)}` : ''}`)
  }
  const matrix = report.rows.filter((row) => !row.control)
  const controls = report.rows.filter((row) => row.control)
  report.summary = { current: summarise(matrix, 'current'), baseline: baseline ? summarise(matrix, 'baseline') : null }
  report.controls = { current: summarise(controls, 'current'), baseline: baseline ? summarise(controls, 'baseline') : null }
  const groups = {}
  for (const row of report.rows) {
    const key = `${row.pattern}/${row.variant}/${row.seconds}s`
    groups[key] ??= []
    groups[key].push(row)
  }
  report.groups = Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, { current: summarise(rows, 'current'), baseline: baseline ? summarise(rows, 'baseline') : null }]))
  console.log('')
  for (const [key, value] of Object.entries(report.groups)) {
    const fmt = (s) => s ? `exact ${s.exact}/${s.total}, near ${s.near}, metrical ${s.metrical}, other ${s.other}, inconclusive ${s.inconclusive}, methods disagree ${s.methodsDisagree}` : ''
    console.log(`${key.padEnd(28)} now: ${fmt(value.current)}${baseline ? `\n${''.padEnd(28)} before: ${fmt(value.baseline)}` : ''}`)
  }
  console.log(JSON.stringify({ matrix: report.summary, tripleMeterControls: report.controls }, null, 2))
  if (options['--report']) {
    const output = path.resolve(options['--report'])
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  }
  if (options['--strict'] && report.summary.current.exact !== report.summary.current.total) process.exitCode = 1
} finally {
  await rm(temporary, { recursive: true, force: true })
}
