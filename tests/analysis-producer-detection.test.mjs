/**
 * Producer-style detection regressions for sonic-dsp/5 (October 24, 2026).
 *
 * A fixed subset of scripts/benchmark-producer-beats.mjs: generated drums, 808
 * and harmony at a stated BPM and key, analysed through the app's window plan.
 * Labels stay in this file; the DSP receives PCM, sample rate and duration only.
 * These are synthetic engineering gates, not a real-music accuracy claim.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { CASES, RATE, renderCase, windows, slice, classifyTempo, classifyKey } from '../scripts/benchmark-producer-beats.mjs'

const root = path.resolve('test-results/analysis-producer-detection')
await mkdir(root, { recursive: true })
const output = path.join(root, 'dsp.mjs')
await build({ entryPoints: [path.resolve('src/main/analysis/dsp.ts')], outfile: output, bundle: true, format: 'esm', platform: 'neutral', logLevel: 'error' })
const { estimateTempo, estimateKey } = await import(pathToFileURL(output).href)

/** Seeds match the benchmark: 5000 + 1-based case position. */
function analyse(id) {
  const index = CASES.findIndex((spec) => spec.id === id)
  assert.ok(index >= 0, `unknown fixture ${id}`)
  const spec = CASES[index]
  const pcm = renderCase(spec, 5001 + index)
  const plan = windows(spec.seconds)
  const tempo = estimateTempo({ pcm: slice(pcm, plan.tempo), sampleRate: RATE, sourceDurationSec: spec.seconds })
  const key = estimateKey({ pcm: slice(pcm, plan.key), sampleRate: RATE, sourceDurationSec: spec.seconds })
  return { spec, tempo, key, tempoClass: classifyTempo(tempo, spec), keyClass: classifyKey(key, spec) }
}

test('trap and drill read at the producer-labelled 140 level, not 70', () => {
  for (const id of ['p002', 'p005']) {
    const { spec, tempo, tempoClass } = analyse(id)
    assert.equal(tempoClass, 'exact', `${id} ${spec.group} ${spec.bpm}: got ${tempo.bpm}`)
    assert.ok(tempo.alternatives.some((alternative) => alternative.relation === 'half'), `${id} keeps the half-time reading`)
  }
})

test('four-on-the-floor and 3+3+2 grooves are not read as 3:2 or 4:3 cross-rhythms', () => {
  for (const id of ['p016', 'p019', 'p022']) {
    const { spec, tempo, tempoClass } = analyse(id)
    assert.equal(tempoClass, 'exact', `${id} ${spec.group} ${spec.bpm}: got ${tempo.bpm}`)
  }
})

test('slow grooves without a double-time pulse are not folded up', () => {
  for (const id of ['p008', 'p011']) {
    const { spec, tempo, tempoClass } = analyse(id)
    assert.equal(tempoClass, 'exact', `${id} ${spec.group} ${spec.bpm}: got ${tempo.bpm}`)
  }
})

test('a flat-seventh minor loop is not reported as the key a fifth away', () => {
  const { key, keyClass } = analyse('p001')
  assert.notEqual(key.key, 'G major')
  assert.ok(['exact', 'inconclusive-kept'].includes(keyClass), `A minor loop: ${keyClass} ${key.key}`)
  assert.ok(key.key === 'A minor' || key.alternatives.some((alternative) => alternative.key === 'A minor'))
})

test('balanced relative-key loops stay inconclusive with both readings', () => {
  const { key, keyClass } = analyse('p040')
  assert.equal(keyClass, 'pass-ambiguous')
  assert.ok(key.alternatives.some((alternative) => alternative.key === 'C major'))
})

test('drums without harmony have a tempo but no key', () => {
  const { tempo, key } = analyse('p043')
  assert.equal(tempo.status, 'estimated')
  assert.equal(key.status, 'inconclusive')
  assert.equal(key.key, null)
})

test('noise, a single tone, an unrhythmic pad and a 4 s clip stay inconclusive', () => {
  for (const id of ['p044', 'p045', 'p046', 'p047']) {
    const { spec, tempo, key, tempoClass, keyClass } = analyse(id)
    assert.equal(tempoClass, 'pass-inconclusive', `${id} ${spec.kind} tempo: ${tempo.bpm}`)
    if (spec.key == null) assert.equal(keyClass, 'pass-inconclusive', `${id} ${spec.kind} key: ${key.key}`)
  }
})

test('producer fixtures analyse deterministically', () => {
  const first = analyse('p005')
  const second = analyse('p005')
  assert.deepEqual(second.tempo, first.tempo)
  assert.deepEqual(second.key, first.key)
})
