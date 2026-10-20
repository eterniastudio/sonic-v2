import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
function load(relativePath, dependencies) {
  const source = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  const module = { exports: {} }
  const factory = new Script(`(function(require,module,exports,__dirname){\n${compiled.outputText}\n})`, { filename: source.pathname }).runInThisContext()
  factory(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports, '/isolated/analysis')
  return module.exports
}
const decoding = load('../src/main/analysis/decode.ts', {
  'node:fs/promises': require('node:fs/promises'), 'node:path': path,
  '../lib/child': { run: () => assert.fail('Unexpected decoder launch') },
  '../lib/fsx': { ensureDir: () => {}, removeFile: () => {} }
})
const shared = load('../src/shared/analysis.ts', {})

function serviceFixture(t, decodeWindow) {
  const jobs = [], removed = [], progress = []
  const { analysisService: service } = load('../src/main/analysis/service.ts', {
    'node:events': { EventEmitter }, '../lifecycle': { isStopping: () => false },
    'node:crypto': { createHash }, 'node:path': path,
    'node:fs': { createReadStream() {
      const stream = new EventEmitter()
      stream.destroy = error => queueMicrotask(() => stream.emit('error', error))
      queueMicrotask(() => { stream.emit('data', Buffer.from('audio')); stream.emit('end') })
      return stream
    } },
    'node:worker_threads': { Worker: class extends EventEmitter {
      constructor(_path, { workerData }) {
        super(); jobs.push(workerData)
        queueMicrotask(() => this.emit('message', { ok: false, error: null }))
      }
      async terminate() {}
    } },
    '@shared/analysis': shared,
    '../lib/fsx': { ensureDir: async () => {}, removeFile: async target => { removed.push(target) } },
    '../services/paths': { analysisDir: () => '/isolated/analysis' },
    '../services/engine': { engineService: { resolve: async () => ({ path: '/isolated/ffmpeg' }) } },
    '../services/settings': { settingsService: { get: () => ({ analysisConcurrency: 1 }) } },
    './cache': { analysisCache: { get: () => null, set: () => {} } },
    './decode': { planWindows: decoding.planWindows, decodeWindow },
    '../services/ffprobe': { probeMediaFile: async () => ({ durationSec: 0 }) },
    './merge': { assembleAnalysis: input => input }
  })
  service.on('progress', event => progress.push(event))
  t.after(() => service.shutdown())
  return { service, jobs, removed, progress }
}

test('every decode window failing reports the decoder error and never starts the worker', async t => {
  let attempt = 0
  const f = serviceFixture(t, async () => {
    attempt += 1
    throw new Error(attempt === 1 ? 'Invalid data found when processing input' : 'Late window: moov atom not found')
  })
  const result = await f.service.analyze({ requestId: 'request', inputPath: '/input.m4a', durationSec: 200 })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, false)
  assert.equal(f.jobs.length, 0)
  assert.match(result.error, /could not be decoded/)
  assert.match(result.error, /moov atom not found/)
  assert.ok(attempt >= 2)
  assert.equal(f.removed.length, attempt)
  assert.equal(f.progress.at(-1).phase, 'failed')
})
