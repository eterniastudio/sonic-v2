#!/usr/bin/env node
/**
 * Read-only real-recording benchmark. The manifest is deliberately external to
 * the analyzer: only decoded PCM, sample rate, and duration reach the DSP.
 *
 * Usage: node scripts/benchmark-real-audio.mjs --manifest PATH --report PATH
 * Optional: --ffmpeg PATH (defaults to ffmpeg on PATH)
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const sampleRate = 22050
const tempoToleranceBpm = 2
const noteClasses = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }

function usage() {
  return 'Usage: node scripts/benchmark-real-audio.mjs --manifest PATH --report PATH [--ffmpeg PATH]'
}

function options(argv) {
  const found = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    if (!['--manifest', '--report', '--ffmpeg'].includes(name) || !argv[i + 1] || found[name]) throw new Error(usage())
    found[name] = argv[i + 1]
  }
  if (!found['--manifest'] || !found['--report']) throw new Error(usage())
  return { manifest: path.resolve(found['--manifest']), report: path.resolve(found['--report']), ffmpeg: found['--ffmpeg'] ?? 'ffmpeg' }
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

function parseKey(value) {
  const match = /^([A-G](?:#|b)?)\s+(major|minor)$/.exec(value)
  if (!match || noteClasses[match[1]] === undefined) throw new Error(`Invalid reference key: ${value}`)
  return { pc: noteClasses[match[1]], mode: match[2] }
}

function sameKey(a, b) {
  if (!a || !b) return false
  const left = parseKey(a)
  const right = parseKey(b)
  return left.pc === right.pc && left.mode === right.mode
}

function relativeKey(a, b) {
  if (!a || !b) return false
  const left = parseKey(a)
  const right = parseKey(b)
  if (left.mode === right.mode) return false
  return left.mode === 'major'
    ? (left.pc + 9) % 12 === right.pc
    : (left.pc + 3) % 12 === right.pc
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== 'sonic-real-audio-benchmark/1' || !Array.isArray(manifest.samples)) throw new Error('Manifest must use sonic-real-audio-benchmark/1 and contain samples[].')
  const seen = new Set()
  for (const sample of manifest.samples) {
    if (!sample || !/^r[0-9]{3,}$/.test(sample.id) || seen.has(sample.id)) throw new Error('Sample IDs must be unique opaque IDs such as r001.')
    seen.add(sample.id)
    if (typeof sample.file !== 'string' || !sample.file || path.isAbsolute(sample.file) || sample.file.split(/[\\/]/).includes('..')) throw new Error(`${sample.id}: file must be a relative path inside the manifest directory.`)
    if (!/^[a-f0-9]{64}$/.test(sample.sha256 ?? '')) throw new Error(`${sample.id}: a SHA-256 audio identity is required.`)
    if (typeof sample.sourceUrl !== 'string' || !/^https:\/\//.test(sample.sourceUrl)) throw new Error(`${sample.id}: sourceUrl is required.`)
    if (typeof sample.license !== 'string' || !sample.license) throw new Error(`${sample.id}: the per-recording license is required.`)
    if (typeof sample.annotationSource !== 'string' || !/^https:\/\//.test(sample.annotationSource)) throw new Error(`${sample.id}: independent annotationSource is required.`)
    if (!sample.reference || !['positive', 'negative', 'unscored'].includes(sample.reference.tempo?.kind) || !['positive', 'negative', 'unscored'].includes(sample.reference.key?.kind)) throw new Error(`${sample.id}: each field must declare positive, negative, or unscored reference status.`)
    if (sample.reference.tempo.kind === 'positive' && !(sample.reference.tempo.bpm > 0 && sample.reference.tempo.bpm <= 300)) throw new Error(`${sample.id}: positive tempo requires a BPM in (0, 300].`)
    if (sample.reference.key.kind === 'positive') parseKey(sample.reference.key.key)
  }
}

async function loadDsp(root) {
  const require = createRequire(path.join(root, 'package.json'))
  const esbuild = require('esbuild')
  const directory = await mkdtemp(path.join(tmpdir(), 'sonic-real-dsp-'))
  const bundle = path.join(directory, 'dsp.mjs')
  try {
    await esbuild.build({ entryPoints: [path.join(root, 'src/main/analysis/dsp.ts')], outfile: bundle, bundle: true, platform: 'neutral', format: 'esm', target: 'node22', logLevel: 'silent' })
    return { dsp: await import(pathToFileURL(bundle).href), cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function decode(ffmpeg, file) {
  // No sidecars or metadata are requested. The DSP sees only f32le PCM.
  const { stdout } = await execFileAsync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-vn', '-map', '0:a:0', '-t', '180', '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 18_000_000, timeout: 120_000, windowsHide: true })
  if (stdout.byteLength < sampleRate * 4 * 6 || stdout.byteLength % 4 !== 0) throw new Error('Decoded audio is shorter than 6 seconds or truncated.')
  const pcm = new Float32Array(stdout.byteLength / 4)
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = stdout.readFloatLE(i * 4)
  if (pcm.length / sampleRate >= 179.9) throw new Error('Source reached the 180-second decode cap; this benchmark requires a shorter recording.')
  return pcm
}

function scoreTempo(expected, result) {
  const primary = result.status === 'estimated' ? result.bpmExact ?? result.bpm : null
  const alternatives = (result.alternatives ?? []).map((entry) => entry.bpm)
  if (expected.kind === 'unscored') return { category: 'unscored', primary, alternatives }
  if (expected.kind === 'negative') return { category: primary == null ? 'correct-abstention' : 'false-positive', primary, alternatives }
  if (primary == null) return { category: 'abstention', primary, alternatives }
  if (Math.abs(primary - expected.bpm) <= tempoToleranceBpm) return { category: 'exact-primary', primary, alternatives }
  if (alternatives.some((bpm) => Math.abs(bpm - expected.bpm) <= tempoToleranceBpm)) return { category: 'exact-alternative', primary, alternatives }
  if ([0.5, 2].some((ratio) => Math.abs(primary - expected.bpm * ratio) <= tempoToleranceBpm)) return { category: 'octave-primary', primary, alternatives }
  if (alternatives.some((bpm) => [0.5, 2].some((ratio) => Math.abs(bpm - expected.bpm * ratio) <= tempoToleranceBpm))) return { category: 'octave-alternative', primary, alternatives }
  return { category: 'incorrect', primary, alternatives }
}

function scoreKey(expected, result) {
  const primary = result.status === 'estimated' ? result.key : null
  const alternatives = (result.alternatives ?? []).map((entry) => entry.key)
  if (expected.kind === 'unscored') return { category: 'unscored', primary, alternatives }
  if (expected.kind === 'negative') return { category: primary == null ? 'correct-abstention' : 'false-positive', primary, alternatives }
  if (primary == null) return { category: alternatives.some((key) => sameKey(key, expected.key)) ? 'abstention-with-exact-alternative' : 'abstention', primary, alternatives }
  if (sameKey(primary, expected.key)) return { category: 'exact-primary', primary, alternatives }
  if (relativeKey(primary, expected.key)) return { category: 'relative-primary', primary, alternatives }
  if (alternatives.some((key) => sameKey(key, expected.key))) return { category: 'exact-alternative', primary, alternatives }
  if (alternatives.some((key) => relativeKey(key, expected.key))) return { category: 'relative-alternative', primary, alternatives }
  return { category: 'incorrect', primary, alternatives }
}

function tally(rows, field) {
  const counts = {}
  let positive = 0, negative = 0, estimatedPositive = 0
  for (const row of rows) {
    const kind = row.reference[field].kind
    const category = row.score[field].category
    counts[category] = (counts[category] ?? 0) + 1
    if (kind === 'positive') {
      positive++
      if (row.score[field].primary != null) estimatedPositive++
    }
    if (kind === 'negative') negative++
  }
  return { positive, negative, estimatedPositive, estimateCoverage: positive ? estimatedPositive / positive : null, counts }
}

async function main() {
  const opt = options(process.argv.slice(2))
  if (opt.report === opt.manifest) throw new Error('Report path must differ from manifest path.')
  const root = path.resolve(import.meta.dirname, '..')
  const manifestBytes = await readFile(opt.manifest)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  validateManifest(manifest)
  const { stdout: versionOutput } = await execFileAsync(opt.ffmpeg, ['-version'], { encoding: 'utf8', maxBuffer: 100_000, timeout: 10_000, windowsHide: true })
  const ffmpegVersion = versionOutput.split(/\r?\n/)[0]
  const sourceBytes = await readFile(path.join(root, 'src/main/analysis/dsp.ts'))
  const loaded = await loadDsp(root)
  const rows = []
  try {
    for (const sample of manifest.samples) {
      const file = path.resolve(path.dirname(opt.manifest), sample.file)
      const content = await readFile(file)
      if (sha256(content) !== sample.sha256) throw new Error(`${sample.id}: source bytes do not match the manifest SHA-256.`)
      const pcm = await decode(opt.ffmpeg, file)
      const duration = pcm.length / sampleRate
      const skip = Math.min(8, duration * 0.2)
      const offset = Math.round(skip * sampleRate)
      const tempoPcm = pcm.subarray(offset, offset + Math.round(Math.min(150, duration - skip) * sampleRate))
      const keyPcm = pcm.subarray(offset, offset + Math.round(Math.min(90, duration - skip) * sampleRate))
      const tempo = loaded.dsp.estimateTempo({ pcm: tempoPcm, sampleRate, sourceDurationSec: duration })
      const key = loaded.dsp.estimateKey({ pcm: keyPcm, sampleRate, sourceDurationSec: duration })
      const score = { tempo: scoreTempo(sample.reference.tempo, tempo), key: scoreKey(sample.reference.key, key) }
      rows.push({ id: sample.id, sha256: sample.sha256, durationSec: Math.round(duration * 10) / 10, reference: sample.reference, score, analysis: { tempo, key }, provenance: { sourceUrl: sample.sourceUrl, annotationSource: sample.annotationSource, license: sample.license } })
      console.log(`${sample.id}: tempo ${score.tempo.category}; key ${score.key.category}`)
    }
  } finally { await loaded.cleanup() }
  const report = {
    schema: 'sonic-real-audio-benchmark-report/1',
    source: { dspSha256: sha256(sourceBytes), manifestSha256: sha256(manifestBytes), manifestPath: opt.manifest, dataset: manifest.dataset ?? null, decoder: opt.ffmpeg, ffmpegVersion, sampleRate },
    rules: { tempoToleranceBpm, halfDoubleRatios: [0.5, 2], primaryAndAlternativeScoredSeparately: true },
    summary: { sampleCount: rows.length, tempo: tally(rows, 'tempo'), key: tally(rows, 'key') },
    samples: rows
  }
  await writeFile(opt.report, JSON.stringify(report, null, 2) + '\n')
  console.log(`Benchmark: ${rows.length} recorded samples; report ${opt.report}`)
  if (!rows.length) process.exitCode = 2
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
