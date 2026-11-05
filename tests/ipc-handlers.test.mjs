import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
function load(relativePath, resolve) {
  const source = new URL(relativePath, import.meta.url)
  const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  })
  const module = { exports: {} }
  const factory = new Script(`(function(require,module,exports){\n${compiled.outputText}\n})`, { filename: source.pathname }).runInThisContext()
  factory(resolve, module, module.exports)
  return module.exports
}
/** Any service the handler under test does not touch resolves to inert functions. */
const inert = new Proxy({}, { get: (_target, name) => name === '__esModule' ? false : new Proxy(() => undefined, { get: () => () => undefined }) })

async function ipcFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sonic-ipc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const handlers = new Map(), opened = [], added = [], retried = [], dragged = []
  const queueJobs = [{ id: 'failed-1', stage: 'failed' }, { id: 'cancelled-1', stage: 'cancelled' }, { id: 'done-1', stage: 'complete' }, { id: 'failed-2', stage: 'failed' }]
  const webContents = { mainFrame: {} }
  const window = { isDestroyed: () => false, webContents }
  const paths = { userData: root, engine: path.join(root, 'missing-engine'), downloads: root }
  const fsx = load('../src/main/lib/fsx.ts', name => require(name))
  const modules = {
    electron: {
      app: { getPath: () => paths.userData }, clipboard: {}, dialog: {},
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      shell: { openPath: async target => { opened.push(target); return '' } }
    },
    './lifecycle': { assertAccepting() {}, ownOperation: operation => operation() },
    './lib/fsx': fsx,
    './window': { getMainWindow: () => window },
    './services/engine': { engineService: { get directory() { return paths.engine } } },
    './services/settings': { settingsService: { get: () => ({ downloadDir: paths.downloads }) } },
    './services/paths': { defaultDownloadDir: () => paths.downloads },
    './services/queue': { queueService: { add: urls => { added.push(urls); return { jobs: [], paused: false, concurrency: 2 } }, flush() {},
      snapshot: () => ({ jobs: queueJobs, paused: false, concurrency: 2 }), retry: id => { retried.push(id) } } },
    './services/libraryTools': {
      MAX_DRAG_FILES: 100,
      startLibraryDrag: async (_sender, ids) => { dragged.push(ids); return { started: true, count: ids.length } },
      exportLibraryList: async ids => ({ saved: true, count: ids.length, fileName: 'list.csv' }),
      resolveDuplicates: async () => []
    }
  }
  load('../src/main/ipc.ts', name => modules[name] ?? inert).registerIpcHandlers()
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  const invoke = (channel, ...args) => handlers.get(channel)(event, ...args)
  return { root, paths, opened, added, invoke, retried, dragged, queueJobs }
}

test('app:openDirectory opens existing folders and refuses missing ones or files', async t => {
  const f = await ipcFixture(t)
  assert.equal(await f.invoke('app:openDirectory', 'userData'), true)
  assert.equal(await f.invoke('app:openDirectory', 'downloads'), true)
  assert.equal(await f.invoke('app:openDirectory', 'engine'), false)
  f.paths.engine = path.join(f.root, 'a-file')
  await writeFile(f.paths.engine, 'not a folder')
  assert.equal(await f.invoke('app:openDirectory', 'engine'), false)
  assert.deepEqual(f.opened, [f.root, f.root])
})

test('queue:add accepts a large paste only as individual links', async t => {
  const f = await ipcFixture(t)
  const urls = Array.from({ length: 120 }, (_, index) => `https://www.youtube.com/watch?v=${String(index).padStart(11, 'a')}`)
  // The whole textarea as one entry exceeds the per-entry cap: the old intake bug.
  await assert.rejects(f.invoke('queue:add', [urls.join('\n')]), /invalid|argument/i)
  await f.invoke('queue:add', urls)
  assert.deepEqual(f.added, [urls])
})

test('queue:retryFailed re-queues failed jobs only; cancelled and finished jobs stay put', async t => {
  const f = await ipcFixture(t)
  await f.invoke('queue:retryFailed')
  assert.deepEqual(f.retried, ['failed-1', 'failed-2'])
  await assert.rejects(f.invoke('queue:retryFailed', 'extra'), /invalid/i)
})

test('library drag, list export and duplicate resolution take record ids only, within limits', async t => {
  const f = await ipcFixture(t)
  assert.deepEqual(await f.invoke('library:startDrag', ['beat-1', 'beat-2']), { started: true, count: 2 })
  assert.deepEqual(f.dragged, [['beat-1', 'beat-2']])
  await assert.rejects(f.invoke('library:startDrag', []), /invalid/i)
  await assert.rejects(f.invoke('library:startDrag', Array.from({ length: 101 }, (_, index) => `beat-${index}`)), /invalid/i)
  await assert.rejects(f.invoke('library:startDrag', 'C:\\audio\\beat.wav'), /invalid/i)
  await assert.rejects(f.invoke('library:exportList', []), /invalid/i)
  await assert.rejects(f.invoke('library:resolveDuplicates', 'keep', []), /invalid/i)
  assert.deepEqual(await f.invoke('library:exportList', ['beat-1']), { saved: true, count: 1, fileName: 'list.csv' })
})
