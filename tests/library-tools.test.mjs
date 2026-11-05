import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const outDir = path.resolve('test-results/library-tools')
await mkdir(outDir, { recursive: true })
const entry = path.join(outDir, 'entry.ts')
await writeFile(entry, [
  `export * from ${JSON.stringify(path.resolve('src/shared/libraryTools.ts'))}`,
  `export * from ${JSON.stringify(path.resolve('src/shared/libraryExport.ts'))}`,
  `export { clipboardOffer } from ${JSON.stringify(path.resolve('src/renderer/src/features/intake/clipboardWatch.ts'))}`
].join('\n'))
const output = path.join(outDir, 'tools.cjs')
await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'cjs',
  alias: { '@shared': path.resolve('src/shared') } })
const tools = require(output)

const beat = (id, patch = {}) => ({ id, title: id, producer: null, bpm: null, key: null, camelot: null, sourceUrl: null,
  fingerprint: `${id}-fingerprint-0000000000`, addedAt: 0, verification: null, durationSec: 180, sourceKind: 'local',
  fileName: `${id}.wav`, ...patch })

test('compatible keys are the same Camelot position, one step either way, and the relative key', () => {
  assert.deepEqual(tools.compatibleCamelots('8A'), ['8A', '7A', '9A', '8B'])
  assert.deepEqual(tools.compatibleCamelots('12B'), ['12B', '11B', '1B', '12A'])
  assert.deepEqual(tools.compatibleCamelots('1A'), ['1A', '12A', '2A', '1B'])
  assert.deepEqual(tools.compatibleCamelots('not a key'), [])
  assert.equal(tools.camelotOf({ key: 'A minor', camelot: null }), '8A')
  assert.equal(tools.camelotOf({ key: null, camelot: '8b' }), '8B')
})

test('find compatible: Camelot neighbours and tempo within tolerance, including half and double time', () => {
  const seed = beat('seed', { bpm: 140, key: 'A minor', camelot: '8A' })
  const library = [
    beat('same', { bpm: 141, camelot: '8A' }),
    beat('down', { bpm: 138, key: 'D minor' }), // 7A
    beat('relative', { bpm: 140, camelot: '8B' }),
    beat('half', { bpm: 70, camelot: '9A' }),
    beat('double', { bpm: 282, camelot: '8A' }),
    beat('clash', { bpm: 140, camelot: '3A' }),
    beat('too-fast', { bpm: 150, camelot: '8A' }),
    beat('unknown-key', { bpm: 140 }),
    beat('unknown-tempo', { camelot: '8A' }),
    seed
  ]
  const ids = options => tools.findCompatible(seed, library, options).map(item => item.id)
  assert.deepEqual(ids({ bpmTolerance: 4, includeHalfDouble: true }), ['seed', 'same', 'down', 'relative', 'half', 'double'])
  assert.deepEqual(ids({ bpmTolerance: 4, includeHalfDouble: false }), ['seed', 'same', 'down', 'relative'])
  assert.deepEqual(ids({ bpmTolerance: 0, includeHalfDouble: false }), ['seed', 'relative'])
  const criteria = tools.compatibilityCriteria(seed, { bpmTolerance: 2, includeHalfDouble: true })
  assert.deepEqual(criteria.tempoRanges, [{ min: 138, max: 142 }, { min: 68, max: 72 }, { min: 278, max: 282 }])
})

test('a seed with only a key or only a tempo constrains only that; neither gives no criteria', () => {
  const library = [beat('a', { bpm: 90, camelot: '8A' }), beat('b', { bpm: 140, camelot: '2B' }), beat('c', { camelot: '8B' })]
  const keyOnly = beat('key-only', { camelot: '8A' })
  assert.deepEqual(tools.findCompatible(keyOnly, library, { bpmTolerance: 4, includeHalfDouble: true }).map(item => item.id), ['a', 'c'])
  const tempoOnly = beat('tempo-only', { bpm: 140 })
  assert.deepEqual(tools.findCompatible(tempoOnly, library, { bpmTolerance: 4, includeHalfDouble: false }).map(item => item.id), ['b'])
  assert.equal(tools.compatibilityCriteria(beat('blank'), { bpmTolerance: 4, includeHalfDouble: true }), null)
  assert.deepEqual(tools.findCompatible(beat('blank'), library, { bpmTolerance: 4, includeHalfDouble: true }), [])
})

test('duplicates group by source identity and by audio fingerprint, transitively, oldest first', () => {
  const library = [
    beat('watch', { sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', addedAt: 5 }),
    beat('short', { sourceUrl: 'https://youtu.be/dQw4w9WgXcQ', addedAt: 2, fingerprint: 'shared-audio-fingerprint-abc' }),
    beat('copy', { addedAt: 9, fingerprint: 'shared-audio-fingerprint-abc' }),
    beat('cloud-a', { sourceUrl: 'https://soundcloud.com/artist/track-one', addedAt: 1 }),
    beat('cloud-b', { sourceUrl: 'https://m.soundcloud.com/artist/track-one', addedAt: 3 }),
    beat('unique', { sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
    beat('blank-a', { fingerprint: '' }),
    beat('blank-b', { fingerprint: '' })
  ]
  const groups = tools.findDuplicateGroups(library)
  assert.equal(groups.length, 2)
  const video = groups.find(group => group.beatIds.includes('watch'))
  assert.deepEqual(video.beatIds, ['short', 'watch', 'copy'])
  assert.deepEqual(video.reasons, ['source', 'audio'])
  const cloud = groups.find(group => group.beatIds.includes('cloud-a'))
  assert.deepEqual(cloud.beatIds, ['cloud-a', 'cloud-b'])
  assert.deepEqual(cloud.reasons, ['source'])
  assert.equal(tools.sourceIdentity('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube:dQw4w9WgXcQ')
  assert.equal(tools.sourceIdentity('not a link'), null)
})

test('smart views: needs review and recently added', () => {
  assert.deepEqual(tools.reviewReasons(beat('x')), ['no-bpm', 'no-key'])
  assert.deepEqual(tools.reviewReasons(beat('x', { bpm: 140, camelot: '8A' })), [])
  assert.deepEqual(tools.reviewReasons(beat('x', { bpm: 140, key: 'A minor',
    verification: { fields: [{ field: 'bpm', verdict: 'mismatch' }, { field: 'key', verdict: 'close' }] } })), ['bpm-disagreement'])
  assert.equal(tools.needsReview(beat('x', { bpm: 140, key: 'A minor', verification: { fields: [{ field: 'key', verdict: 'mismatch' }] } })), true)
  const now = Date.UTC(2026, 9, 24)
  assert.equal(tools.isRecentlyAdded({ addedAt: now - 13 * 86_400_000 }, now), true)
  assert.equal(tools.isRecentlyAdded({ addedAt: now - 15 * 86_400_000 }, now), false)
  assert.ok(tools.BUILT_IN_VIEW_IDS.includes(tools.DUPLICATES_VIEW_ID))
})

test('library export: CSV quoting, formula guard, durations and collections; JSON shape', () => {
  const rows = tools.libraryExportRows([
    beat('one', { title: 'Night, "Drive"', producer: '=HYPERLINK("x")', bpm: 140, key: 'A minor', durationSec: 185.4,
      sourceKind: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    beat('two', { title: 'Plain', durationSec: 3725, sourceUrl: 'file:///C:/secret.wav' })
  ], new Map([['one', ['Vocals', 'Late night']]]))
  assert.equal(rows[0].camelot, '8A')
  assert.equal(rows[1].sourceUrl, null)
  const csv = tools.serializeLibraryExport(rows, 'csv')
  assert.ok(csv.startsWith('\ufeffTitle,Producer,BPM,Key,Camelot,Duration,Source,Source URL,File name,Collections\r\n'))
  const lines = csv.slice(1).trim().split('\r\n')
  assert.equal(lines[1], '"Night, ""Drive""","\'=HYPERLINK(""x"")",140,A minor,8A,3:05,YouTube,https://www.youtube.com/watch?v=dQw4w9WgXcQ,one.wav,Vocals; Late night')
  assert.equal(lines[2], 'Plain,,,,,1:02:05,Local file,,two.wav,')
  assert.equal(tools.csvCell('-5'), "'-5")
  const json = JSON.parse(tools.serializeLibraryExport(rows, 'json', new Date('2026-10-24T00:00:00Z')))
  assert.equal(json.schema, 'sonic-v2/library-list')
  assert.equal(json.count, 2)
  assert.deepEqual(json.tracks[0].collections, ['Vocals', 'Late night'])
  assert.ok(!JSON.stringify(json).includes('filePath'))
})

test('clipboard offer: supported links only, skips queued and answered clipboards', () => {
  const queued = ['https://www.youtube.com/watch?v=aaaaaaaaaaa']
  assert.equal(tools.clipboardOffer('just some text', queued, null), null)
  assert.equal(tools.clipboardOffer('https://example.com/song', queued, null), null)
  assert.deepEqual(tools.clipboardOffer('https://example.com/song', [], null, { allowOtherSites: true }).urls, ['https://example.com/song'])
  assert.deepEqual(tools.clipboardOffer('https://cdn.example.com/a.mp3', [], null).urls, ['https://cdn.example.com/a.mp3'])
  assert.equal(tools.clipboardOffer('https://youtu.be/aaaaaaaaaaa', queued, null), null)
  const offer = tools.clipboardOffer('https://youtu.be/bbbbbbbbbbb\nhttps://www.youtube.com/watch?v=bbbbbbbbbbb https://soundcloud.com/a/b', queued, null)
  assert.deepEqual(offer.urls, ['https://www.youtube.com/watch?v=bbbbbbbbbbb', 'https://soundcloud.com/a/b'])
  assert.equal(tools.clipboardOffer(` ${offer.text} `, queued, offer.text), null)
  assert.equal(tools.clipboardOffer('x'.repeat(30_000), [], null), null)
})
