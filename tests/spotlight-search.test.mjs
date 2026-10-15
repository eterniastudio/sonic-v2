import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'

const output = path.resolve('test-results/spotlight-search/search.cjs')
await mkdir(path.dirname(output), { recursive: true })
await build({ entryPoints: ['src/renderer/src/components/obsidian/spotlightSearch.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs' })
const { indexCommands, searchCommands } = createRequire(import.meta.url)(output)

test('global search finds late-library matches without creating an unbounded result list', () => {
  const commands = Array.from({ length: 20_000 }, (_, index) => ({ id: index, label: `Beat ${index}`, group: 'Beats', keywords: '140 BPM A minor 8A' }))
  const catalog = indexCommands(commands)
  const all = searchCommands(catalog, '')
  assert.equal(all.items.length, 60)
  assert.equal(all.total, 20_000)
  assert.deepEqual(all.items.map(item => item.id), commands.slice(0, 60).map(item => item.id))
  assert.equal(searchCommands(catalog, 'Beat 19999').items[0].id, 19999)
  assert.equal(searchCommands(catalog, '140 8A').total, 20_000)
})

test('literal matches in long metadata outrank fuzzy results and disabled commands stay absent', () => {
  const commands = [
    { id: 'fuzzy', label: 'F-l-a-c', group: 'Formats' },
    { id: 'late-literal', label: 'x'.repeat(200), group: 'Beats', keywords: 'flac' },
    { id: 'exact', label: 'FLAC', group: 'Formats' },
    { id: 'disabled', label: 'FLAC', group: 'Formats', disabled: true }
  ]
  assert.deepEqual(searchCommands(indexCommands(commands), ' flac ').items.map(item => item.id), ['exact', 'late-literal', 'fuzzy'])
  assert.deepEqual(searchCommands(indexCommands(commands), 'impossible').items, [])
})
