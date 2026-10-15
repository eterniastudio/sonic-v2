#!/usr/bin/env node
/**
 * Deterministic key/tuning regressions and an optional same-process comparison.
 * Run: node scripts/benchmark-key-detection.mjs [--baseline-ref origin/main] [--report PATH]
 * The generated fixtures are controlled engineering cases, not real-music accuracy.
 * Expected names and cents never enter estimateKey: only PCM, rate and duration do.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1]
  if (!['--baseline-ref', '--report'].includes(name) || !value || options[name]) throw new Error('Expected --baseline-ref REF and/or --report PATH')
  options[name] = value
}

function fixture(tonic, mode, { rate = 22050, cents = 0, partials = [1, .42, .22, .11, .05], inverse = false, progression = null } = {}) {
  const chords = progression ?? (mode === 'major' ? [[0,4,7], [5,9,12], [7,11,14], [0,4,7]] : [[0,3,7], [8,12,15], [7,10,14], [0,3,7]])
  const seconds = 12, chordSeconds = seconds / chords.length, pcm = new Float32Array(seconds * rate)
  for (const [index, chord] of chords.entries()) {
    const notes = inverse ? [chord[1] - 12, chord[2], chord[0] + 12, chord[1]] : [chord[0], chord[1], chord[2], chord[0] + 12]
    for (const [voice, note] of notes.entries()) {
      const frequency = 440 * 2 ** (((48 + tonic + note - 69) * 100 + cents) / 1200)
      const start = Math.round(index * chordSeconds * rate), count = Math.round(chordSeconds * rate)
      for (let harmonic = 1; harmonic <= partials.length; harmonic++) {
        if (frequency * harmonic > rate * .45) break
        const step = 2 * Math.PI * frequency * harmonic / rate
        for (let i = 0; i < count; i++) {
          const t = i / rate
          const envelope = Math.min(1, t / .03, (chordSeconds - t) / .1) * Math.exp(-.45 * t)
          pcm[start + i] += .12 * partials[harmonic - 1] * Math.sin(step * i + voice * 1.3) * envelope
        }
      }
    }
  }
  return { pcm, sampleRate: rate, sourceDurationSec: seconds }
}

function singlePitch(rate, hz, partials = [1]) {
  const pcm = new Float32Array(rate * 10)
  for (let h = 0; h < partials.length; h++) {
    for (let i = 0; i < pcm.length; i++) pcm[i] += .15 * partials[h] * Math.sin(2 * Math.PI * hz * (h + 1) * i / rate)
  }
  return { pcm, sampleRate: rate, sourceDurationSec: 10 }
}

async function bundle(source, filename, directory) {
  const output = path.join(directory, filename)
  await build({ stdin: { contents: source, loader: 'ts', resolveDir: path.join(root, 'src/main/analysis') }, outfile: output, bundle: true, format: 'esm', platform: 'neutral', target: 'node22', logLevel: 'silent' })
  return import(pathToFileURL(output).href)
}

const median = (values) => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)]
const hash = (source) => createHash('sha256').update(source).digest('hex')
const temporary = await mkdtemp(path.join(tmpdir(), 'sonic-key-regressions-'))
try {
  const source = await readFile(path.join(root, 'src/main/analysis/dsp.ts'), 'utf8')
  const current = await bundle(source, 'current.mjs', temporary)
  const baselineSource = options['--baseline-ref'] ? execFileSync('git', ['show', `${options['--baseline-ref']}:src/main/analysis/dsp.ts`], { cwd: root, encoding: 'utf8', maxBuffer: 2e6, windowsHide: true }) : null
  const baseline = baselineSource ? await bundle(baselineSource, 'baseline.mjs', temporary) : null
  const report = { schema: 'sonic-key-regressions/1', source: { currentSha256: hash(source), baselineSha256: baselineSource ? hash(baselineSource) : null, baselineRef: options['--baseline-ref'] ?? null }, rules: { tuningToleranceCents: 5, labelsReachDsp: false, fixtureType: 'synthetic', realMusicReferenceSampleCount: 0 }, cases: [], negatives: [], ambiguities: [], performance: null }
  const cohorts = [
    { name: 'standard', options: {} },
    { name: 'flat-35-cents', options: { cents: -35 } },
    { name: 'sharp-35-cents', options: { cents: 35 } },
    { name: 'bright-harmonics', options: { partials: [.65, 1, .5, .32, .2, .12] } },
    { name: 'inversions-44100', options: { rate: 44100, inverse: true } },
    { name: 'detuned-48000', options: { rate: 48000, cents: 27 } }
  ]
  let sequence = 0
  for (const cohort of cohorts) {
    for (const mode of ['major', 'minor']) {
      for (let tonic = 0; tonic < 12; tonic++) {
        const input = fixture(tonic, mode, cohort.options)
        const expected = `${names[tonic]} ${mode}`
        const analysis = current.estimateKey(input)
        const before = baseline?.estimateKey(input) ?? null
        const tuningPass = analysis.tuningCents != null && Math.abs(analysis.tuningCents - (cohort.options.cents ?? 0)) <= report.rules.tuningToleranceCents
        report.cases.push({ id: `k${String(++sequence).padStart(3,'0')}`, cohort: cohort.name, expected, expectedCents: cohort.options.cents ?? 0, sampleRate: input.sampleRate, analysis, baseline: before, exact: analysis.key === expected, tuningPass, baselineExact: before ? before.key === expected : null, baselineTuningPass: before ? before.tuningCents != null && Math.abs(before.tuningCents - (cohort.options.cents ?? 0)) <= 5 : null })
      }
    }
    const subset = report.cases.filter((row) => row.cohort === cohort.name)
    console.log(`${cohort.name}: exact ${subset.filter((r) => r.exact).length}/${subset.length}; tuning ${subset.filter((r) => r.tuningPass).length}/${subset.length}${baseline ? `; baseline exact ${subset.filter((r) => r.baselineExact).length}/${subset.length}, tuning ${subset.filter((r) => r.baselineTuningPass).length}/${subset.length}` : ''}`)
  }
  for (const rate of [22050, 44100, 48000]) {
    for (const hz of [82.41, 220, 440]) {
      for (const partials of [[1], [1, .7, .4, .2, .12]]) {
        const input = singlePitch(rate, hz, partials)
        const analysis = current.estimateKey(input)
        const before = baseline?.estimateKey(input) ?? null
        report.negatives.push({ id: `n${String(report.negatives.length + 1).padStart(3,'0')}`, kind: partials.length === 1 ? 'sine' : 'harmonic-drone', rate, hz, analysis, baseline: before, pass: analysis.status === 'inconclusive' })
      }
    }
  }
  // Equal-duration i–VI–III–VII loops share relative-key evidence. The tonic
  // corroboration must not invent a mode merely from the first chord or label.
  for (let tonic = 0; tonic < 12; tonic++) {
    const input = fixture(tonic, 'minor', { progression: [[0,3,7], [8,12,15], [3,7,10], [10,14,17]] })
    const analysis = current.estimateKey(input)
    const expectedCandidates = [`${names[tonic]} minor`, `${names[(tonic + 3) % 12]} major`]
    report.ambiguities.push({ id: `a${String(tonic + 1).padStart(3,'0')}`, analysis, expectedCandidates, pass: analysis.status === 'inconclusive' && expectedCandidates.every((key) => analysis.alternatives.some((a) => a.key === key)) })
  }
  const input = fixture(3, 'minor', { cents: -35 })
  current.estimateKey(input)
  baseline?.estimateKey(input)
  const currentTimes = [], baselineTimes = []
  for (let repeat = 0; repeat < 9; repeat++) {
    for (const [implementation, times] of repeat % 2 ? [[baseline, baselineTimes], [current, currentTimes]] : [[current, currentTimes], [baseline, baselineTimes]]) {
      if (!implementation) continue
      const started = performance.now()
      implementation.estimateKey(input)
      times.push(performance.now() - started)
    }
  }
  report.performance = { scope: 'key DSP only; same 12-second 22,050 Hz mono fixture; one warmup then nine alternating timed runs per engine', nodeVersion: process.version, currentMs: currentTimes, baselineMs: baselineTimes, currentMedianMs: median(currentTimes), baselineMedianMs: baseline ? median(baselineTimes) : null }
  report.summary = { exact: report.cases.filter((r) => r.exact).length, total: report.cases.length, tuningPass: report.cases.filter((r) => r.tuningPass).length, baselineExact: baseline ? report.cases.filter((r) => r.baselineExact).length : null, baselineTuningPass: baseline ? report.cases.filter((r) => r.baselineTuningPass).length : null, negativePass: report.negatives.filter((r) => r.pass).length, negativeTotal: report.negatives.length, ambiguityPass: report.ambiguities.filter((r) => r.pass).length, ambiguityTotal: report.ambiguities.length }
  console.log(JSON.stringify({ summary: report.summary, performance: report.performance }, null, 2))
  if (options['--report']) {
    const output = path.resolve(options['--report'])
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  }
  assert.equal(report.summary.exact, report.summary.total, 'Some controlled key regressions failed; inspect the report')
  assert.equal(report.summary.tuningPass, report.summary.total, 'Some tuning estimates differ by more than 5 cents')
  assert.equal(report.summary.negativePass, report.summary.negativeTotal, 'A single pitched source was incorrectly assigned a key')
  assert.equal(report.summary.ambiguityPass, report.summary.ambiguityTotal, 'Balanced relative-key loops must retain both candidates without asserting a key')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
