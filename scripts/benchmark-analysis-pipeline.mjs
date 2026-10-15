// Measures decode + PCM loading only, with the same windows before and after
// sharing. Generated audio is not an accuracy benchmark; DSP is excluded.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const run = promisify(execFile)
const ffmpeg = process.env.SONIC_FFMPEG || 'ffmpeg'
const directory = await mkdtemp(path.join(tmpdir(), 'sonic-decode-benchmark-'))
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
try {
  const bundle = path.join(directory, 'decode.mjs')
  await build({ entryPoints: ['src/main/analysis/decode.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { decodeWindow, readPcmFile, planWindows } = await import(pathToFileURL(bundle).href)
  const source = path.join(directory, 'source.flac')
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=133', '-ac', '2', source], { windowsHide: true, timeout: 60000 })
  const plan = planWindows(133)
  const counts = {}
  async function measure(shared) {
    const started = performance.now()
    const outputs = []
    const windows = shared ? [plan.tempo] : [plan.tempo, ...plan.key]
    let bytes = 0
    for (let index = 0; index < windows.length; index++) {
      const result = await decodeWindow({ ...windows[index], inputPath: source, ffmpegPath: ffmpeg, outputPath: path.join(directory, `pcm-${shared}-${index}.f32`), signal: new AbortController().signal })
      outputs.push(result.path)
      bytes += result.sampleCount * 4
    }
    const samples = []
    for (const output of outputs) {
      if (shared) samples.push(await readPcmFile(output))
      else {
        // The previous worker read each PCM file and copied every float.
        const buffer = await readFile(output)
        const pcm = new Float32Array(buffer.length / 4)
        for (let index = 0; index < pcm.length; index++) pcm[index] = buffer.readFloatLE(index * 4)
        samples.push(pcm)
      }
    }
    const elapsedMs = performance.now() - started
    if (shared) samples.push(samples[0].subarray(0, Math.round(plan.key[0].durationSec * 22050)))
    assert.equal(samples[1].length, 90 * 22050)
    const firstKey = new Uint8Array(samples[1].buffer, samples[1].byteOffset, samples[1].byteLength)
    for (const output of outputs) await rm(output)
    counts[shared ? 'after' : 'before'] = { processes: windows.length, scratchBytes: bytes }
    return { elapsedMs, firstKey: Buffer.from(firstKey) }
  }
  // One warm-up per path, then alternate order to reduce order/cache bias.
  await measure(false); await measure(true)
  const before = [], after = []
  for (let repeat = 0; repeat < 5; repeat++) {
    const order = repeat % 2 ? [true, false] : [false, true]
    const results = new Map()
    for (const shared of order) {
      const result = await measure(shared)
      ;(shared ? after : before).push(result.elapsedMs)
      results.set(shared, result)
    }
    assert.deepEqual(results.get(false).firstKey, results.get(true).firstKey, 'Shared key PCM must be byte-identical')
  }
  const report = {
    scope: '133-second generated stereo FLAC; 125-second tempo and 90-second key; decode and PCM loading, excluding DSP',
    repeats: 5, node: process.version, platform: process.platform,
    before: { ...counts.before, milliseconds: before, medianMs: median(before) },
    after: { ...counts.after, milliseconds: after, medianMs: median(after) },
    timeReductionPercent: 100 * (1 - median(after) / median(before)),
    scratchReductionPercent: 100 * (1 - counts.after.scratchBytes / counts.before.scratchBytes),
    identicalKeySamples: true
  }
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/analysis-pipeline-benchmark.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await rm(directory, { recursive: true, force: true })
}
