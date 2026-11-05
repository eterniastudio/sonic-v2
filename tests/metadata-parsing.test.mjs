import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = path.resolve('test-results/metadata-parsing')
const entry = path.join(root, 'entry.ts')
const output = path.join(root, 'metadata.cjs')
await mkdir(root, { recursive: true })
await writeFile(entry, [
  `export * from ${JSON.stringify(path.resolve('src/shared/metadata.ts'))}`,
  `export * from ${JSON.stringify(path.resolve('src/shared/template.ts'))}`,
  `export { verifyMetadata, isHalfOrDoubleTempo } from ${JSON.stringify(path.resolve('src/shared/verification.ts'))}`
].join('\n'))
await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
const { parseDeclared, parseText, reconcile, decideMetadataField, renderTemplate, renderExportStem, sanitizeFilename,
  verifyMetadata, isHalfOrDoubleTempo } = require(output)

/** [title, expected values] — `null` asserts the field was not parsed at all. */
const TITLES = [
  // Compact keys that are English words, never keys.
  ['Am I Dreaming Type Beat', { key: null, camelot: null }],
  ['DM me on IG for beats', { key: null }],
  ['10 AM upload - Drake Type Beat', { key: null }],
  ['Hit Em Up Type Beat', { key: null }],
  ['Love Me - AM - Arctic Monkeys Type Beat', { key: null }],
  ['this is a major vibe', { key: null }],
  ['Late Night FM Type Beat', { key: null }],
  ['Drake Type Beat "Am I Wrong" 140 BPM', { title: 'Am I Wrong', bpm: 140, key: null }],
  // Compact keys that must keep parsing.
  ['F#m 150 BPM Jersey Club', { bpm: 150, key: 'F# minor', camelot: '11A', genre: 'Jersey Club' }],
  ['Dark Drill Type Beat - Am - 140bpm - detuned -18 cents', { bpm: 140, key: 'A minor', camelot: '8A', detune: -18 }],
  ['Sad Piano Type Beat [Am]', { key: 'A minor' }],
  ['Trap Beat | Cm | 2024', { key: 'C minor', camelot: '5A' }],
  ['Melodic Trap Beat 140 BPM Am', { bpm: 140, key: 'A minor' }],
  ['Am 140bpm Melodic', { bpm: 140, key: 'A minor' }],
  ['Pain (Gm) Type Beat', { key: 'G minor', camelot: '6A' }],
  ['Lil Baby Type Beat C#m', { key: 'C# minor', camelot: '12A' }],
  ['Rod Wave Type Beat Ebm', { key: 'D# minor' }],
  ['Pop Beat [CM]', { key: 'C major', camelot: '8B' }],
  ['Pop Beat 120 BPM CM', { bpm: 120, key: 'C major' }],
  ['Soul Beat - Cmaj - 90 BPM', { bpm: 90, key: 'C major' }],
  ['Drill Beat - F# minor', { key: 'F# minor' }],
  // Tempo: `N BPM` wins over `BPM N`, and `BPM N` stops at the number.
  ['Name 140 BPM 2024', { bpm: 140 }],
  ['140 BPM 100% FREE', { bpm: 140 }],
  ['BPM 100% FREE beat', { bpm: null }],
  ['BPM: 145 | Key: A minor', { bpm: 145, key: 'A minor' }],
  ['Trap Beat 2024 | prod. LXST | 72 / 144 BPM | Key: 11A', { producer: 'LXST', bpm: 144, altBpm: 72, camelot: '11A', key: 'F# minor' }],
  ['Tempo: 128.5 house', { bpm: 128.5 }],
  // Underscore, colon, equals and slash delimiters.
  ['beat_140bpm_F#m', { bpm: 140, key: 'F# minor', camelot: '11A' }],
  ['140BPM_Am', { bpm: 140, key: 'A minor' }],
  ['Key:F#m', { key: 'F# minor', camelot: '11A' }],
  ['KEY=Am', { key: 'A minor', camelot: '8A' }],
  ['key:11A', { key: 'F# minor', camelot: '11A' }],
  ['Key - Ebm', { key: 'D# minor' }],
  ['key: C dorian', { key: 'C dorian', camelot: null }],
  ['Key Glock Type Beat', { key: null }],
  ['Monkey Business 90 BPM', { key: null, bpm: 90 }],
  ['dark/140bpm/8A', { bpm: 140, camelot: '8A', key: 'A minor' }],
  ['Camelot: 4B', { camelot: '4B', key: 'G# major' }],
  ['Top 5 A Boogie Type Beats', { camelot: null, key: null }],
  // Quoted beat names: curly, straight, guillemets and single curly quotes.
  ['Drake Type Beat - “Night” | 140 BPM', { title: 'Night', bpm: 140 }],
  ['[FREE] "Midnight Drive" Type Beat 2026 - prod. by KBeats [144 BPM] [F# minor]',
    { title: 'Midnight Drive', producer: 'KBeats', bpm: 144, key: 'F# minor', camelot: '11A' }],
  ['Future Type Beat «Paris» 150 BPM', { title: 'Paris', bpm: 150 }],
  ['Gunna Type Beat ‘Wunna Flow’ (prod. X)', { title: 'Wunna Flow' }],
  ['Don’t Stop Type Beat', { title: 'Don’t Stop' }],
  // Tuning and detune.
  ['Soul Sample Beat (prod. by J Dilla Tribute) Tuning: A=432Hz', { producer: 'J Dilla Tribute', tuning: 'A=432Hz', detune: -31.8 }],
  ['My 1st Beat of 2024', { detune: null }],
  ['Dark Beat +2 st', { detune: 200 }],
  ['Pitched -1.5 semitones', { detune: -150 }],
  // October 24, 2026: producer tempo shapes.
  ['Dark Trap Beat 140bpm', { bpm: 140, altBpm: null }],
  ['bpm:140 trap', { bpm: 140 }],
  ['Drill Type Beat 140 - 145 BPM', { bpm: 140, altBpm: null }],
  ['Drill Type Beat 140–145bpm', { bpm: 140 }],
  ['Melodic Beat 70 - 140 BPM', { bpm: 140, altBpm: 70 }],
  ['Trap Beat 140/70 BPM', { bpm: 140, altBpm: 70 }],
  ['Trap Beat bpm 140/70', { bpm: 140, altBpm: 70 }],
  ['Drill Type Beat @ 140', { bpm: 140 }],
  ['Drill Type Beat @140bpm', { bpm: 140 }],
  ['Pain [140] Type Beat', { bpm: 140 }],
  ['Pain (140) [Am] Type Beat', { bpm: 140, key: 'A minor' }],
  // ...and the numbers that are not tempos.
  ['Track 12 - 140 BPM', { bpm: 140, altBpm: null }],
  ['Episode 95 - 140 BPM', { bpm: 140, altBpm: null }],
  ['Room 808 - 140bpm', { bpm: 140 }],
  ['Future Type Beat 2026', { bpm: null }],
  ['[2026] Type Beat', { bpm: null }],
  ['808 Mafia Type Beat', { bpm: null }],
  ['Lil Baby Type Beat [808]', { bpm: null }],
  ['Hard 808 Beat 2026', { bpm: null }],
  ['Vol. [2] Pain [140]', { bpm: null }],
  ['Beat Tape [10] [140]', { bpm: null }],
  ['Type Beat (Part 2)', { bpm: null }],
  ['@2026 upload', { bpm: null }],
  ['@100k subs special', { bpm: null }],
  ['Top 100 type beats', { bpm: null }],
  ['Episode 140', { bpm: null }],
  // October 24, 2026: producer key shapes.
  ['Type Beat C# Minor', { key: 'C# minor', camelot: '12A' }],
  ['Type Beat C sharp minor', { key: 'C# minor', camelot: '12A' }],
  ['Type Beat B-flat major', { key: 'A# major', camelot: '6B' }],
  ['Soul Beat Db maj', { key: 'C# major', camelot: '3B' }],
  ['Beat F#min', { key: 'F# minor', camelot: '11A' }],
  ['Beat Key - Am', { key: 'A minor', camelot: '8A' }],
  ['Guitar Beat in the key of G', { key: 'G major', camelot: '9B' }],
  ['Piano Beat in the key of F# minor', { key: 'F# minor', camelot: '11A' }],
  ['Piano Beat in the key of B flat', { key: 'A# major' }],
  ['Beat Ebm', { key: 'D# minor', camelot: '2A' }],
  ['Beat G♯m', { key: 'G# minor', camelot: '1A' }],
  ['Beat Bbmin', { key: 'A# minor', camelot: '3A' }],
  ['Beat 8A', { key: 'A minor', camelot: '8A' }],
  ['Beat 08A', { key: 'A minor', camelot: '8A' }],
  ['Key: 08A', { key: 'A minor', camelot: '8A' }],
  ['Camelot 04B', { key: 'G# major', camelot: '4B' }],
  ['Key of the Night Beat', { key: null }],
  ['the key of a lifetime', { key: null }],
  ['a sharp minor turn', { key: null }],
  ['a minor setback', { key: null }],
  // October 24, 2026: producer credits and FREE descriptors.
  ['Type Beat prod. @kbeats', { producer: 'kbeats' }],
  ['Type Beat (prod by Metro x Southside)', { producer: 'Metro x Southside' }],
  ['Type Beat prod. Wheezy & Turbo', { producer: 'Wheezy & Turbo' }],
  ['Free For Profit Drake Type Beat 2026 - Silence', { title: 'Drake - Silence', bpm: null }],
  ['FREE FOR PROFIT Lil Baby Type Beat - Pain', { title: 'Lil Baby - Pain' }],
  ['[FREE] Drake Type Beat 2026 - "Night"', { title: 'Night', bpm: null }]
]

test('real-world titles parse to the declared values only', () => {
  const failures = []
  for (const [title, expected] of TITLES) {
    const { values } = parseDeclared({ title })
    for (const [field, want] of Object.entries(expected)) {
      const got = values[field] ?? null
      const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(want - got) < 0.05 : got === want
      if (!ok) failures.push(`${JSON.stringify(title)} ${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
    }
  }
  assert.deepEqual(failures, [])
})

test('descriptions and embedded comment tags share the word-safe key rules', () => {
  const description = 'DM me for exclusive rights\nI am uploading daily at 10 AM\nBPM: 140\nKey: Gm'
  assert.equal(parseText(description, 'description').values.key, 'G minor')
  assert.equal(parseText('Am I the only one\nsend a DM', 'description').values.key, undefined)
  assert.equal(parseText('Am', 'tags').values.key, 'A minor')
  assert.equal(parseText('F#m', 'tags').values.camelot, '11A')
  assert.equal(parseText('Visit my site for more beats. Contact me at 9 AM', 'tags').values.key, undefined)
})

test('reconcile takes the alternate tempo from the layer that supplied the tempo', () => {
  const crossed = reconcile({ declared: { bpm: 140 }, analyzed: { bpm: 95.6, altBpm: 191.2 } })
  assert.equal(crossed.final.bpm, 140)
  assert.equal(crossed.final.altBpm, null)
  const paired = reconcile({ analyzed: { bpm: 95.6, altBpm: 191.2 } })
  assert.deepEqual([paired.final.bpm, paired.final.altBpm], [95.6, 191.2])
  const declaredPair = reconcile({ declared: { bpm: 144, altBpm: 72 }, analyzed: { bpm: 95, altBpm: 190 } })
  assert.deepEqual([declaredPair.final.bpm, declaredPair.final.altBpm], [144, 72])
  // An unrelated alternate is not an alternate, even from the same layer.
  assert.equal(reconcile({ declared: { bpm: 140, altBpm: 150 } }).final.altBpm, null)
  assert.equal(reconcile({ declared: { bpm: 140, altBpm: 71 } }).final.altBpm, 71)
  // A manual tempo keeps the carried alternate only when it still relates.
  assert.equal(reconcile({ overrides: ['bpm'], previousFinal: { bpm: 133, altBpm: 72 }, analyzed: { bpm: 66.5, altBpm: 133 } }).final.altBpm, null)
  assert.equal(reconcile({ overrides: ['bpm'], previousFinal: { bpm: 140, altBpm: 70 } }).final.altBpm, 70)
  // A hand-typed alternate stands.
  assert.equal(reconcile({ overrides: ['altBpm'], previousFinal: { altBpm: 150 }, declared: { bpm: 140 } }).final.altBpm, 150)

  const decision = decideMetadataField('altBpm', { current: {}, overrides: [],
    sources: { title: { bpm: 140 }, description: {}, filename: {} }, embedded: {}, analyzed: { bpm: 95.6, altBpm: 191.2 } })
  assert.equal(decision.resetValue, null)
  assert.equal(decision.origin, 'none')
  const audioDecision = decideMetadataField('altBpm', { current: {}, overrides: [],
    sources: { title: {}, description: {}, filename: {} }, embedded: {}, analyzed: { bpm: 95.6, altBpm: 191.2 } })
  assert.deepEqual([audioDecision.resetValue, audioDecision.origin], [191.2, 'audio'])
})

test('half/double tempo and detune comparisons are symmetric', () => {
  assert.equal(isHalfOrDoubleTempo(70, 140), true)
  assert.equal(isHalfOrDoubleTempo(140, 70), true)
  for (const [a, b] of [[144, 70], [70, 144], [146, 70.5], [70.5, 146]]) {
    assert.equal(isHalfOrDoubleTempo(a, b), isHalfOrDoubleTempo(b, a), `${a}/${b}`)
  }
  assert.equal(isHalfOrDoubleTempo(150, 70), false)
  const verdict = (stated, measured) => verifyMetadata({
    sources: { title: { bpm: stated }, description: {}, filename: {} }, embedded: {}, analyzed: { bpm: measured },
    analysis: null, final: { bpm: stated }, overrides: []
  }).fields.find(field => field.field === 'bpm').verdict
  // 3% either way: 2× of 70 is 140, and 143 / 70 is 2.04 (2% off) — previously
  // close in one direction and a mismatch in the other.
  assert.equal(verdict(143, 70), 'close')
  assert.equal(verdict(70, 143), 'close')
  assert.equal(verdict(150, 70), 'mismatch')

  const detune = (stated, tuningCents) => verifyMetadata({
    sources: { title: { detune: stated }, description: {}, filename: {} }, embedded: {}, analyzed: {},
    analysis: { key: { tuningCents } }, final: { detune: stated }, overrides: []
  }).fields.find(field => field.field === 'detune').verdict
  assert.equal(detune(-18, -20), 'match')
  assert.equal(detune(-118, -20), 'match')
  assert.equal(detune(100, 2), 'match')
  assert.equal(detune(-45, 48), 'match')
  assert.equal(detune(30, -20), 'close')
})

const metadata = (patch = {}) => ({ title: 'Midnight Drive', producer: 'KBeats', bpm: null, altBpm: null, key: null,
  camelot: null, detune: null, tuning: null, genre: null, ...patch })
const context = (patch) => ({ metadata: metadata(patch), presetId: 'wav-44100-24', sourceKind: 'youtube' })

test('templates keep title text, tempo and key suffixes, and whole characters', () => {
  const template = '{producer} - {title} [{bpm} BPM] [{key}]'
  assert.equal(renderTemplate(template, context({ bpm: 144, key: 'F# minor' })).rendered, 'KBeats - Midnight Drive [144 BPM] [F# minor]')
  assert.equal(renderTemplate(template, context()).rendered, 'KBeats - Midnight Drive')
  assert.equal(renderTemplate(template, context({ producer: null, bpm: 140 })).rendered, 'Midnight Drive [140 BPM]')
  // Brackets inside a title are the producer's text, not template debris.
  assert.equal(renderTemplate('{title}', context({ title: 'Love (Key)' })).rendered, 'Love (Key)')
  assert.equal(renderTemplate('{title} [{bpm} BPM]', context({ title: 'Night [BPM]' })).rendered, 'Night [BPM]')
  assert.equal(renderExportStem('{title}', context({ title: 'Love (Key)', bpm: 140, key: 'A minor' })), 'Love (Key) [140 BPM] [A minor]')

  // An odd prefix puts the 150-unit cut in the middle of a surrogate pair.
  const long = `a${'🔥'.repeat(100)}`
  const rendered = renderTemplate('{title}', context({ title: long })).rendered
  assert.ok(rendered.length <= 150)
  assert.equal(rendered, `a${'🔥'.repeat(74)}`)
  assert.doesNotMatch(rendered, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)

  const stem = renderExportStem('{title}', context({ title: 'x'.repeat(200), bpm: 140, key: 'F# minor' }))
  assert.ok(stem.length <= 150)
  assert.match(stem, / \[140 BPM\] \[F# minor\]$/)
  const emojiStem = renderExportStem('{title}', context({ title: '👨‍👩‍👧'.repeat(40), bpm: 140 }))
  assert.match(emojiStem, /^(?:👨‍👩‍👧)+ \[140 BPM\]$/u)
})

test('sanitised names are NFC and avoid every reserved device name', () => {
  const decomposed = 'Café Beat'
  assert.equal(sanitizeFilename(decomposed).value, 'Café Beat')
  assert.equal(renderTemplate('{title}', context({ title: decomposed })).rendered, 'Café Beat')
  for (const name of ['CON', 'com1', 'COM¹', 'COM²', 'COM³', 'LPT¹', 'lpt²', 'LPT³', 'nul.txt']) {
    assert.ok(sanitizeFilename(name).value.startsWith('_'), name)
  }
  assert.equal(sanitizeFilename('COM10').value, 'COM10')
})
