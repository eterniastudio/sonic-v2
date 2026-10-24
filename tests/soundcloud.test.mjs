import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
function load(file, dependencies = {}) {
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  new Script(`(function(require,module,exports){${source}\n})`).runInThisContext()(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}
const urls = load('../src/shared/url.ts', { './providers': load('../src/shared/providers.ts') })
const track = 'https://soundcloud.com/producer/beat-140-bpm'

test('SoundCloud tracks normalize mobile, trailing-slash and tracking variants', () => {
  for (const input of [track, `${track}/`, `${track}?utm_source=clipboard&in=producer/sets/beats`, track.replace('soundcloud', 'm.soundcloud'), track.replace('soundcloud', 'www.soundcloud')]) {
    assert.deepEqual(urls.parseVideoUrl(input), { ok: true, normalized: track, videoId: null, provider: 'soundcloud', reason: null })
  }
  assert.equal(urls.coverArtFor(track), null)
})

test('SoundCloud secret tokens survive normalization and share links are admitted for inspection', () => {
  assert.equal(urls.parseVideoUrl(`${track}/s-AbC123?utm_source=copy`).normalized, `${track}/s-AbC123`)
  assert.equal(urls.parseVideoUrl(`${track}?secret_token=s-AbC123`).normalized, `${track}/s-AbC123`)
  for (const input of ['https://on.soundcloud.com/AbC123', 'https://soundcloud.app.goo.gl/AbC123']) {
    assert.equal(urls.parseVideoUrl(input).ok, true)
    assert.equal(urls.isSoundCloudShareUrl(input), true)
  }
})

test('profiles, collections, unsupported URLs and misleading hosts never enter the queue', () => {
  for (const input of ['https://soundcloud.com/producer', 'https://soundcloud.com/producer/sets/beats', 'https://soundcloud.com/producer/tracks', 'https://soundcloud.com/producer/likes', `${track}/recommended`, 'https://soundcloud.com/stations/track/producer/beat', 'https://soundcloud.com/search/sounds', 'https://soundcloud.com.evil.invalid/a/b', 'http://soundcloud.com/a/b', 'https://user:password@soundcloud.com/a/b', 'https://soundcloud.com:9000/a/b', 'https://on.soundcloud.com/', 'https://on.soundcloud.com/a/b']) {
    assert.equal(urls.parseVideoUrl(input).ok, false, input)
  }
})

test('mixed YouTube and SoundCloud intake deduplicates canonical links and retains both providers', () => {
  const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  const result = urls.extractVideoUrls(`${track}, ${track}?utm_source=copy\nhttps://youtu.be/dQw4w9WgXcQ ${youtube} https://example.invalid/foo`)
  assert.deepEqual(result.accepted.map(value => [value.provider, value.normalized]), [['soundcloud', track], ['youtube', youtube]])
  assert.equal(result.rejected.length, 1)
  assert.equal(urls.coverArtFor(youtube), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
})

function probeFixture(info, overrides = {}) {
  const calls = []
  const service = load('../src/main/services/probe.ts', {
    '@shared/url': urls,
    './settings': { settingsService: { get: () => ({ cookiesFromBrowser: 'none' }) } },
    './engine': { engineService: { resolve: async () => ({ path: '/isolated/tool' }) } },
    '../lib/child': { run: async (binary, args, options) => {
      calls.push({ args, options })
      return { code: 0, stdout: JSON.stringify(info), stderr: '', ...overrides }
    } }
  })
  return { ...service, calls }
}

test('SoundCloud metadata includes track identity, uploader, duration and artwork', async () => {
  const f = probeFixture({ id: '12345', title: 'Beat 140 BPM', uploader: 'Producer', duration: 120, thumbnail: 'https://i1.sndcdn.com/art.jpg' })
  const result = await f.probeUrl(track)
  assert.equal(result.error, null)
  assert.equal(result.url, track)
  assert.equal(result.videoId, '12345')
  assert.equal(result.uploader, 'Producer')
  assert.equal(result.durationSec, 120)
  assert.equal(result.thumbnail, 'https://i1.sndcdn.com/art.jpg')
  assert.equal(f.calls[0].args.at(-1), track)
  assert.ok(f.calls[0].args.includes('--no-playlist'))
})

test('unexpected playlist metadata is rejected before media acquisition', async () => {
  const f = probeFixture({ _type: 'playlist', entries: [{ id: '123' }] })
  assert.match((await f.probeUrl(track)).error, /single track/)
})

test('SoundCloud errors identify the correct provider', async () => {
  const f = probeFixture({}, { code: 1, stderr: 'ERROR: unable to download JSON metadata: network error' })
  assert.match((await f.probeUrl(track)).error, /SoundCloud/)
  assert.match(f.summariseYtDlpError('ERROR: timed out', 'youtube'), /YouTube/)
  assert.match(f.summariseYtDlpError('ERROR: private track', 'soundcloud'), /private or unavailable/)
})

test('share links resolve to a validated track before probing, and reject other hosts or collections', async t => {
  const f = probeFixture({ id: '12345', title: 'Shared track' })
  const requested = []
  let target = `${track}?utm_source=copy`
  t.mock.method(globalThis, 'fetch', async url => {
    requested.push(url)
    return new Response(null, { status: 302, headers: { location: target } })
  })
  assert.equal((await f.probeUrl('https://on.soundcloud.com/AbC123')).url, track)
  assert.equal(f.calls[0].args.at(-1), track)
  for (const rejected of ['https://example.invalid/private', 'https://soundcloud.com/producer/sets/beats']) {
    target = rejected
    assert.match((await f.probeUrl('https://on.soundcloud.com/AbC123')).error, /supported SoundCloud track/)
  }
  assert.equal(f.calls.length, 1)
  assert.equal(requested.length, 3)
})

test('share-link loops are bounded and cancellation prevents network or extractor work', async t => {
  const f = probeFixture({})
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://on.soundcloud.com/Loop' } }) })
  assert.match((await f.probeUrl('https://on.soundcloud.com/Loop')).error, /full track link/)
  assert.equal(requests, 6)
  const controller = new AbortController(); controller.abort()
  assert.equal((await f.probeUrl('https://on.soundcloud.com/Loop', controller.signal)).error, 'Cancelled')
  assert.equal(requests, 6)
  assert.equal(f.calls.length, 0)
})
