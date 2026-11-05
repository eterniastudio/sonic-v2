// End-to-end BPM/key tag round trip through the real transcode() and
// probeMediaFile() with a real ffmpeg/ffprobe. Skips when the tools are absent
// (set SONIC_FFMPEG / SONIC_FFPROBE to point at them explicitly).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const tools = { ffmpeg: process.env.SONIC_FFMPEG || 'ffmpeg', ffprobe: process.env.SONIC_FFPROBE || 'ffprobe' }
const available = Object.values(tools).every((tool) => spawnSync(tool, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0)
const skip = available ? false : 'ffmpeg/ffprobe not available'

async function loadModules(directory) {
  const outfile = path.join(directory, 'export-modules.mjs')
  await build({
    stdin: {
      contents: `export * from './src/main/services/transcode.ts'; export * from './src/main/services/ffprobe.ts'; export * from './src/shared/presets.ts'`,
      resolveDir: root,
      loader: 'ts'
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    alias: { '@shared': path.join(root, 'src/shared') },
    plugins: [{
      name: 'isolated-engine',
      setup(builder) {
        // The real engine service resolves Sonic's managed tools; the test
        // uses the system tools instead.
        builder.onResolve({ filter: /^\.\/engine$/ }, () => ({ path: 'engine', namespace: 'isolated' }))
        builder.onLoad({ filter: /.*/, namespace: 'isolated' }, () => ({
          contents: `export const engineService = { resolve: async (name) => ({ path: ${JSON.stringify(tools)}[name] }) }`,
          loader: 'js'
        }))
      }
    }]
  })
  return import(pathToFileURL(outfile).href)
}

/** Decoder error lines with per-run context addresses removed so files can be compared. */
function decodeErrors(file) {
  const result = spawnSync(tools.ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { windowsHide: true })
  const lines = String(result.stderr).split(/\r?\n/).map((line) => line.replace(/ @ (?:0x)?[0-9a-f]+\]/i, ']').trim()).filter(Boolean)
  return { status: result.status, lines }
}

const tags = { title: 'Tag Fixture', producer: 'Sonic Test', album: null, comment: null, date: '2026-10-20', genre: 'Trap', bpm: 141.5, key: 'F# minor' }
// [preset, staged source extension, expected BPM in the container, key embedded?]
const cases = [
  ['mp3-320', 'wav', 141.5, true],
  ['flac', 'wav', 141.5, true],
  ['opus-192', 'wav', 141.5, true],
  ['wav-44100-24', 'wav', 141.5, true],
  ['m4a-256', 'wav', 142, false],
  ['original', 'm4a', 142, false],
  ['original', 'webm', 141.5, true]
]

test('exports embed BPM and key in each container\'s own fields and read them back', { skip }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sonic-export-tags-'))
  try {
    const modules = await loadModules(directory)
    const sources = {}
    const make = (extension, codec) => {
      const output = path.join(directory, `source.${extension}`)
      const result = spawnSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5', '-ac', '2', ...codec, output], { windowsHide: true })
      assert.equal(result.status, 0, String(result.stderr))
      sources[extension] = output
    }
    make('wav', ['-c:a', 'pcm_s16le'])
    make('m4a', ['-c:a', 'aac', '-metadata', 'TBPM=99', '-metadata', 'title=Source title'])
    make('webm', ['-c:a', 'libopus'])

    for (const [presetId, sourceExtension, expectedBpm, keyEmbedded] of cases) {
      const extension = modules.sourceExtensionFor(presetId, sourceExtension)
      const outputPath = path.join(directory, `${presetId}-${sourceExtension}.${extension}`)
      await modules.transcode({
        inputPath: sources[sourceExtension], outputPath, presetId, channels: 'stereo', lufs: null, coverPath: null,
        tags, durationSec: 1.5, signal: new AbortController().signal, onProgress() {}
      })
      const media = await modules.probeMediaFile(outputPath)
      const readback = modules.tagsToMetadata(media.tags)
      const label = `${presetId} → .${extension}`
      assert.equal(readback.title, 'Tag Fixture', `${label}: title`)
      assert.equal(readback.bpm, expectedBpm, `${label}: BPM`)
      assert.equal(readback.key ?? null, keyEmbedded ? 'F# minor' : null, `${label}: key`)
      const lower = Object.keys(media.tags).map((key) => key.toLowerCase())
      // Raw frame names are never written into Vorbis/Matroska comments.
      if (['flac', 'opus', 'webm'].includes(extension)) assert.ok(!lower.includes('tbpm') && !lower.includes('tkey'), `${label}: no TBPM/TKEY comments`)
      // The decoded audio must still be intact after the WAV chunk is added.
      // Some FFmpeg builds (8.0) report errors decoding their own freshly
      // encoded Opus fixture, so only errors the export introduced count.
      const decode = decodeErrors(outputPath)
      assert.equal(decode.status, 0, `${label}: decodes cleanly`)
      const inherited = new Set(decodeErrors(sources[sourceExtension]).lines)
      assert.deepEqual(decode.lines.filter((line) => !inherited.has(line)), [], `${label}: no decoder errors`)
    }

    // The WAV id3 chunk is word aligned and the RIFF size matches the file.
    const wav = await readFile(path.join(directory, 'wav-44100-24-wav.wav'))
    assert.equal(wav.readUInt32LE(4), wav.length - 8)
    assert.ok(wav.includes(Buffer.from('id3 ')) && wav.includes(Buffer.from('TBPM')) && wav.includes(Buffer.from('TKEY')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('container tag dialects map BPM and key to standard field names', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sonic-export-args-'))
  try {
    const { buildFfmpegArgs } = await loadModules(directory)
    const args = (presetId, outputPath) => buildFfmpegArgs(presetId, { inputPath: 'in', outputPath, channels: 'source', lufs: null, coverPath: null, tags }).join(' ')
    assert.match(args('mp3-320', 'out.mp3'), /TBPM=141\.5 .*TKEY=F# minor .*-id3v2_version 3/)
    assert.match(args('flac', 'out.flac'), /BPM=141\.5 -metadata INITIALKEY=F# minor/)
    assert.match(args('opus-192', 'out.opus'), /BPM=141\.5 -metadata INITIALKEY=F# minor/)
    assert.match(args('original', 'out.webm'), /BPM=141\.5 -metadata INITIAL_KEY=F# minor/)
    assert.match(args('m4a-256', 'out.m4a'), /tmpo=142/)
    assert.match(args('original', 'out.mp3'), /TBPM=141\.5 .*-id3v2_version 3/)
    for (const [presetId, output] of [['flac', 'out.flac'], ['m4a-256', 'out.m4a'], ['wav-44100-24', 'out.wav'], ['original', 'out.webm']]) {
      assert.doesNotMatch(args(presetId, output), /TBPM|TKEY/, `${output}: no raw ID3 frame names`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
