// Duplicate resolution must never move a record's annotations unless that
// record really left the library.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const STUBS = {
  electron: 'export const app = {}; export const dialog = {}; export const nativeImage = {}',
  './library': 'export const libraryService = new Proxy({}, { get: (_, key) => globalThis.__dupes.library[key] })',
  './organization': 'export const organizationService = new Proxy({}, { get: (_, key) => globalThis.__dupes.organization[key] })',
  '../lib/fsx': 'export const fileExists = async () => true'
}

async function load() {
  const directory = await mkdtemp(path.join(tmpdir(), 'sonic-duplicates-'))
  const outfile = path.join(directory, 'library-tools.mjs')
  await build({
    entryPoints: [path.join(root, 'src/main/services/libraryTools.ts')],
    outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    alias: { '@shared': path.join(root, 'src/shared') },
    plugins: [{
      name: 'stubs',
      setup(builder) {
        builder.onResolve({ filter: /^(electron|\.\/library|\.\/organization|\.\.\/lib\/fsx)$/ }, args => ({ path: args.path, namespace: 'stub' }))
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: STUBS[args.path], loader: 'js' }))
      }
    }]
  })
  return { modules: await import(pathToFileURL(outfile).href), directory }
}

const beat = (id) => ({ id, title: id, sourceUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', sourceKind: 'youtube', fingerprint: `fp-${id}`, filePath: `C:/x/${id}.mp3` })

test('annotations move only for records that were actually removed', async () => {
  const { modules, directory } = await load()
  try {
    let records = [beat('keep'), beat('gone'), beat('stuck')]
    const merged = []
    globalThis.__dupes = {
      library: {
        list: () => records,
        get: id => records.find(record => record.id === id),
        assertWritable() {},
        async remove(id) {
          if (id === 'stuck') return { ok: false, reason: 'This record is closing or already being deleted.' }
          records = records.filter(record => record.id !== id)
          return { ok: true }
        }
      },
      organization: { mergeInto: (keepId, ids) => merged.push([keepId, ...ids]) }
    }
    await assert.rejects(modules.resolveDuplicates('keep', ['gone', 'stuck']), /already being deleted/)
    assert.deepEqual(merged, [['keep', 'gone']])
    assert.deepEqual(records.map(record => record.id), ['keep', 'stuck'])

    // A library that cannot save refuses before anything moves.
    globalThis.__dupes.library.assertWritable = () => { throw new Error('Library storage needs attention.') }
    merged.length = 0
    await assert.rejects(modules.resolveDuplicates('keep', ['stuck']), /storage needs attention/)
    assert.deepEqual(merged, [])
  } finally {
    delete globalThis.__dupes
    await rm(directory, { recursive: true, force: true })
  }
})
