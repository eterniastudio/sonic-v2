import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import * as https from 'node:https'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import * as streams from 'node:stream'
import * as streamPromises from 'node:stream/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
function load(relativePath, dependencies, overrides = {}) {
  const source = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  const module = { exports: {} }
  const factory = new Script(`(function(require,module,exports,fetch,process){\n${compiled.outputText}\n})`, { filename: source.pathname }).runInThisContext()
  factory(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports, overrides.fetch ?? fetch, overrides.process ?? process)
  return module.exports
}

async function downloadFixture(t, respond, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sonic-download-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = createServer(respond)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const { downloadToFile, fetchText } = load('../src/main/lib/net.ts', {
    './publicAddress': { publicLookup: () => {}, refuseLiteral: () => {} },
    'node:https': https,
    'node:fs': overrides.fs ?? fs,
    'node:stream': streams,
    'node:stream/promises': streamPromises,
    'node:path': path,
    './fsx': {
      ensureDir: target => mkdir(target, { recursive: true }),
      removeFile: overrides.removeFile ?? (target => unlink(target).catch(error => {
        if (error.code !== 'ENOENT') throw error
      }))
    }
  }, { fetch: overrides.fetch })
  return { downloadToFile, fetchText, destination: path.join(directory, 'download.bin'), url: `http://127.0.0.1:${server.address().port}/asset` }
}

test('downloads stream exact bytes and report completion after closing the output', async t => {
  const bytes = Buffer.alloc(256 * 1024, 7)
  const f = await downloadFixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': bytes.length })
    response.end(bytes)
  })
  const progress = []
  await f.downloadToFile(f.url, f.destination, { onProgress: (...values) => progress.push(values) })
  assert.deepEqual(await readFile(f.destination), bytes)
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length])
  await unlink(f.destination) // A Windows handle left open would fail this operation.
})

test('an already cancelled download makes no request and leaves the destination untouched', async t => {
  let requests = 0
  const f = await downloadFixture(t, (_request, response) => { requests++; response.end('unexpected') })
  await writeFile(f.destination, 'existing bytes')
  const controller = new AbortController()
  controller.abort(new Error('Cancelled before start'))
  await assert.rejects(f.downloadToFile(f.url, f.destination, { signal: controller.signal }), /Cancelled before start/)
  assert.equal(requests, 0)
  assert.equal(await readFile(f.destination, 'utf8'), 'existing bytes')
})

test('HTTP failure before opening output leaves existing destination untouched', async t => {
  const f = await downloadFixture(t, (_request, response) => { response.writeHead(404); response.end() })
  await writeFile(f.destination, 'existing bytes')
  await assert.rejects(f.downloadToFile(f.url, f.destination), /404/)
  assert.equal(await readFile(f.destination, 'utf8'), 'existing bytes')
})

test('HTTP error responses cancel their unread body before returning', async t => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const f = await downloadFixture(t, (_request, response) => response.end(), {
    fetch: async () => new Response(body, { status: 503 })
  })
  await assert.rejects(f.downloadToFile(f.url, f.destination), /503/)
  assert.equal(cancelled, true)
})

test('failed checksum-text responses also release their unread body', async t => {
  let cancelled = false
  const f = await downloadFixture(t, (_request, response) => response.end(), {
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 502 })
  })
  await assert.rejects(f.fetchText(f.url), /502/)
  assert.equal(cancelled, true)
})

test('cancelling an active download closes its streams and removes partial bytes', async t => {
  const f = await downloadFixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 100_000 })
    response.write(Buffer.alloc(1024))
  })
  const controller = new AbortController()
  await assert.rejects(f.downloadToFile(f.url, f.destination, {
    signal: controller.signal,
    onProgress: () => controller.abort()
  }))
  assert.equal(fs.existsSync(f.destination), false)
  await writeFile(f.destination, 'retry can write immediately')
})

test('a broken response closes the output before removing the partial file', async t => {
  let response
  const f = await downloadFixture(t, (_request, incoming) => {
    response = incoming
    response.writeHead(200, { 'content-length': 100_000 })
    response.write(Buffer.alloc(1024))
  })
  await assert.rejects(f.downloadToFile(f.url, f.destination, {
    onProgress: () => response.destroy()
  }))
  assert.equal(fs.existsSync(f.destination), false)
  await writeFile(f.destination, 'retry can write immediately')
})

test('a stalled response is cancelled with a useful error and no retained partial file', async t => {
  const f = await downloadFixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 100_000 })
    response.write(Buffer.alloc(1024))
  })
  await assert.rejects(f.downloadToFile(f.url, f.destination, { idleTimeoutMs: 100 }), /Download stalled and was cancelled/)
  assert.equal(fs.existsSync(f.destination), false)
})

test('asynchronous disk errors reject the download, close the writer, and clean up', async t => {
  let writer, removed = false
  const f = await downloadFixture(t, (_request, response) => { response.end(Buffer.alloc(128)) }, {
    fs: { createWriteStream() {
      writer = new streams.Writable({ write(_chunk, _encoding, callback) {
        setImmediate(() => callback(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })))
      } })
      queueMicrotask(() => writer.emit('open', 99))
      return writer
    } },
    removeFile: async () => { assert.equal(writer.closed, true); removed = true }
  })
  await assert.rejects(f.downloadToFile(f.url, f.destination), error => error.code === 'ENOSPC')
  assert.equal(removed, true)
  assert.equal(writer.destroyed, true)
})

function engineFixture(overrides = {}) {
  const downloads = [], moves = [], removed = [], runs = []
  const checksum = 'a'.repeat(64)
  const result = { code: 0, aborted: false, timedOut: false, stdout: '', stderr: '' }
  const { engineService } = load('../src/main/services/engine.ts', {
    'node:events': { EventEmitter },
    'node:fs': { chmodSync() {}, existsSync: () => false,
      readdirSync: () => ['ffmpeg.exe', 'ffprobe.exe'], statSync: () => ({ isFile: () => true, isDirectory: () => false }) },
    'node:path': path,
    '../lib/net': {
      fetchText: overrides.fetchText ?? (async () => `${checksum}  yt-dlp.exe\n${checksum}  ffmpeg-master-latest-win64-gpl.zip`),
      downloadToFile: async (...args) => { downloads.push(args) }
    },
    '../lib/child': { run: async (...args) => { runs.push(args); return overrides.run ? overrides.run(...args) : result } },
    '../lib/fsx': { ensureDir: async () => {}, removeDir: overrides.removeDir ?? (async () => {}),
      removeFile: async file => { removed.push(file) }, sha256File: async () => overrides.actualHash ?? checksum,
      moveFile: async (...args) => { moves.push(args) } },
    './paths': { engineDir: () => 'C:\\fixture\\engine', stagingDir: () => "C:\\fixture's staging" },
    './settings': { settingsService: { get: () => ({}) } }
  }, { process: { platform: 'win32', env: {} } })
  return { service: engineService, downloads, moves, removed, runs }
}

test('FFmpeg extraction yields to the main event loop and publishes only after the child completes', async () => {
  let finish
  const extraction = new Promise(resolve => { finish = resolve })
  const f = engineFixture({ run: () => extraction })
  const pending = f.service.installFfmpeg()
  await nextTurn()
  assert.equal(f.runs.length, 1)
  assert.equal(f.moves.length, 0)
  assert.equal(f.runs[0][0], 'powershell.exe')
  assert.match(f.runs[0][1].at(-1), /fixture''s staging/)
  assert.equal(f.runs[0][2].timeoutMs, 300_000)
  assert.equal(f.runs[0][2].maxCaptureBytes, 16 * 1024)
  finish({ code: 0, aborted: false, timedOut: false, stderr: '' })
  await pending
  assert.equal(f.moves.length, 2)
})

test('FFmpeg extraction reports timeout, cancellation, and errors without installing partial tools', async () => {
  for (const [result, message] of [
    [{ code: null, timedOut: true, aborted: false, stderr: '' }, /timed out after five minutes/],
    [{ code: null, timedOut: false, aborted: true, stderr: '' }, /cancelled/],
    [{ code: 1, timedOut: false, aborted: false, stderr: 'broken archive' }, /broken archive/]
  ]) {
    const f = engineFixture({ run: async () => result })
    await assert.rejects(f.service.installFfmpeg(), message)
    assert.equal(f.moves.length, 0)
  }
})

test('FFmpeg forwards cancellation to the asynchronous extraction', async () => {
  const controller = new AbortController()
  const f = engineFixture({ run: async (_command, _args, options) => {
    assert.equal(options.signal, controller.signal)
    controller.abort()
    return { code: 0, timedOut: false, aborted: false, stderr: '' }
  } })
  await assert.rejects(f.service.installFfmpeg(controller.signal), /cancelled/)
  assert.equal(f.moves.length, 0)
})

test('closing aborts engine setup and waits for staging cleanup before resolving', async () => {
  let releaseCleanup, cleaning = false, closed = false
  const cleanup = new Promise(resolve => { releaseCleanup = resolve })
  const f = engineFixture({
    run: async (_command, _args, options) => new Promise(resolve => {
      options.signal.addEventListener('abort', () => resolve({ code: null, timedOut: false, aborted: true, stderr: '' }), { once: true })
    }),
    removeDir: async () => {
      if (f.runs.length) { cleaning = true; await cleanup }
    }
  })
  f.service.resolve = async name => ({ name, path: name === 'yt-dlp' ? 'yt-dlp.exe' : null })
  const setup = f.service.setup()
  const failedSetup = assert.rejects(setup, /cancelled/)
  await nextTurn()
  assert.equal(f.runs.length, 1)
  const closing = f.service.shutdown().then(() => { closed = true })
  await nextTurn()
  assert.equal(f.runs[0][2].signal.aborted, true)
  assert.equal(cleaning, true)
  assert.equal(closed, false)
  assert.equal(f.moves.length, 0)
  releaseCleanup()
  await Promise.all([closing, failedSetup])
  assert.equal(closed, true)
  assert.ok(f.removed.some(file => file.endsWith('ffmpeg.zip')))
  await assert.rejects(f.service.setup(), /Sonic is closing/)
})

test('yt-dlp setup requires a valid platform checksum before downloading or replacing a tool', async () => {
  for (const fetchText of [
    async () => { throw new Error('manifest unavailable') },
    async () => '',
    async () => 'bad-hash  yt-dlp.exe',
    async () => `${'a'.repeat(64)}  unrelated.exe`
  ]) {
    const f = engineFixture({ fetchText })
    await assert.rejects(f.service.installYtDlp(), /checksum/)
    assert.equal(f.downloads.length, 0)
    assert.equal(f.moves.length, 0)
  }
})

test('yt-dlp rejects mismatched bytes and installs only a checksum-matching download', async () => {
  const rejected = engineFixture({ actualHash: 'b'.repeat(64) })
  await assert.rejects(rejected.service.installYtDlp(), /did not match its published checksum/)
  assert.equal(rejected.moves.length, 0)
  assert.equal(rejected.removed.length, 1)
  const accepted = engineFixture()
  await accepted.service.installYtDlp()
  assert.equal(accepted.moves.length, 1)
  assert.match(accepted.moves[0][0], /yt-dlp\.exe\.download$/)
  assert.match(accepted.moves[0][1], /yt-dlp\.exe$/)
})
