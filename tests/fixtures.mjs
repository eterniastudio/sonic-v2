import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

// Test-runner-only setup: no fixture IPC or environment backdoor in the app.
export async function fixtures(root, seconds = 24, { sidecars = false } = {}) {
  await mkdir(path.join(root, 'exports'), { recursive: true })
  await mkdir(path.join(root, 'engine'), { recursive: true })
  const tools = []
  for (const name of ['ffmpeg', 'ffprobe']) {
    // Copy real static executables, never Chocolatey shims which resolve back
    // into a machine installation. Runtime PATH remains restricted.
    const source = process.env[`SONIC_TEST_${name.toUpperCase()}`] || `C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\${name}.exe`
    const destination = path.join(root, 'engine', `${name}.exe`)
    await copyFile(source, destination)
    const contents = await readFile(destination)
    if (contents.length < 1_000_000) throw new Error(`${source} is too small to be the expected standalone FFmpeg binary; do not supply a launcher shim.`)
    tools.push({ name, fixtureSource: source, runtimePath: destination, sizeBytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') })
  }
  await writeFile(path.join(root, 'test-tools.json'), JSON.stringify(tools, null, 2))
  const sr = 22050, count = sr * seconds
  const audio = Buffer.alloc(44 + count * 2)
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(sr, 24); audio.writeUInt32LE(sr * 2, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
  audio.write('data', 36); audio.writeUInt32LE(count * 2, 40)
  for (let i = 0; i < count; i++) {
    const t = i / sr, beat = t % .5
    const value = .3 * Math.exp(-beat * 50) * Math.sin(2 * Math.PI * 90 * t) + .1 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 261.626 * t) + Math.sin(2 * Math.PI * 329.628 * t))
    audio.writeInt16LE(Math.round(value * 20000), 44 + i * 2)
  }
  const beats = []
  for (let i = 0; i < 4; i++) {
    const id = `fixture-${i}`, filePath = path.join(root, 'exports', `${id}.wav`)
    audio.writeInt16LE(i, 44)
    const fingerprint = createHash('sha256').update(audio).digest('hex')
    await writeFile(filePath, audio)
    beats.push({ id, title: `Offline beat ${i}`, producer: null, bpm: null, altBpm: null, key: null, camelot: null, detune: null, presetId: 'wav-44100-24', format: 'wav', filePath, fileName: `${id}.wav`, sidecarPath: null, sizeBytes: audio.length, durationSec: seconds, sampleRate: sr, channels: 1, bitrateKbps: null, sourceUrl: null, sourceKind: 'unknown', addedAt: Date.now() - i, fingerprint, missing: false, analysisStatus: 'not-analyzed', analysis: null, overrides: [], sources: { title: {}, description: {}, filename: {} }, embedded: {}, verification: null })
    if (sidecars) {
      const beat = beats.at(-1)
      beat.sidecarPath = path.join(root, 'exports', `${id}.json`)
      await writeFile(beat.sidecarPath, JSON.stringify({ schema: 'sonic-v2/beat', schemaVersion: 2, id: `export-${id}`, app: { name: 'Sonic V2', version: 'test-fixture' }, exportedAt: new Date().toISOString(), source: { kind: 'unknown', url: null, videoId: null, uploader: null, title: null }, metadata: { title: beat.title, producer: null, bpm: null, altBpm: null, key: null, camelot: null, detune: null, tuning: null, genre: null }, evidence: [], conflicts: [], analysis: null, audioEvidence: [], verification: null, overrides: [], sources: beat.sources, embedded: {}, naming: { template: '{title}', fileName: beat.fileName }, recipe: { presetId: beat.presetId, channels: 'preserve', lufs: null, embedTags: false }, output: { filePath: beat.fileName, sizeBytes: beat.sizeBytes, durationSec: seconds, format: 'wav', bitrateKbps: null, sampleRate: sr, channels: 1, fingerprint }, engine: { ytdlp: null, ffmpeg: 'test fixture' } }, null, 2))
    }
  }
  const jobs = Array.from({ length: 6 }, (_, i) => ({ id: `job-${i}`, url: '', videoId: null, sourceKind: 'unknown', sourceTitle: `Offline job ${i}`, sourceDescription: null, uploader: null, thumbnail: null, durationSec: seconds, stage: i === 0 ? 'complete' : i === 5 ? 'queued' : 'ready', progress: i === 0 ? 1 : 0, speed: null, eta: null, message: null, error: null, presetId: 'mp3-320', metadata: { declared: { title: `Offline job ${i}` } }, outputPath: i === 0 ? beats[0].filePath : null, libraryId: i === 0 ? beats[0].id : null, revision: 0, createdAt: Date.now(), updatedAt: Date.now() }))
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ theme: 'dark', reduceMotion: 'on', downloadDir: path.join(root, 'exports'), autoStart: false, rescanIntervalMs: 0, analysisConcurrency: 1, embedThumbnail: false, ffmpegPath: null, ffprobePath: null }))
  await writeFile(path.join(root, 'library.json'), JSON.stringify(beats))
  await writeFile(path.join(root, 'queue.json'), JSON.stringify({ version: 1, paused: true, concurrency: 1, jobs }))
  return beats
}
