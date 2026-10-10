import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
const require = createRequire(import.meta.url)
const ts = require('typescript')
function load(file, dependencies = {}) {
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  new Script(`(function(require,module,exports){${source}\n})`).runInThisContext()(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}
const urls = load('../src/shared/url.ts')
const playlist = 'https://www.youtube.com/playlist?list=PLtest123'
const video = 'dQw4w9WgXcQ'
function fixture(run = async () => ({ code: 0, stdout: JSON.stringify({ title: 'Beats', entries: [{ id: video, title: 'First beat' }] }) }), resolve = async () => ({ path: '/tool' })) {
  return load('../src/main/services/playlist.ts', {
    '@shared/url': urls, '@shared/playlist': { PLAYLIST_LIMIT: 500 },
    '../lifecycle': { assertAccepting() {} },
    '../lib/child': { run }, './engine': { engineService: { resolve } },
    './probe': { baseYtDlpArgs: async () => ['--ignore-config', '--no-playlist', '--cookies-from-browser', 'firefox'], summariseYtDlpError: value => value }
  })
}
test('playlist intake canonicalizes watch, mobile, music and short links while single-video parsing stays unchanged', () => {
  for (const input of [playlist, `https://music.youtube.com/watch?v=${video}&list=PLtest123`, `https://m.youtube.com/playlist?list=PLtest123&index=2`, `https://youtu.be/${video}?list=PLtest123`]) assert.equal(urls.parsePlaylistUrl(input), playlist)
  assert.equal(urls.parseVideoUrl(`https://www.youtube.com/watch?v=${video}&list=PLtest123`).normalized, `https://www.youtube.com/watch?v=${video}`)
  const result = urls.extractIntakeUrls(`${playlist}\n${playlist}&index=2\nhttps://soundcloud.com/artist/track\nhttps://example.com`)
  assert.deepEqual(result.playlists, [playlist]); assert.equal(result.tracks.length, 1); assert.equal(result.rejected.length, 1)
})
test('playlist parser rejects misleading hosts, credentials, invalid identifiers and nonplaylist pages', () => {
  for (const input of ['http://youtube.com/playlist?list=PL1', 'https://youtube.com.evil.test/playlist?list=PL1', 'https://user:pass@youtube.com/playlist?list=PL1', 'https://youtube.com:9000/playlist?list=PL1', 'https://youtube.com/playlist?list=a%20b', 'https://youtube.com/@artist?list=PL1', 'https://soundcloud.com/a/sets?list=PL1']) assert.equal(urls.parsePlaylistUrl(input), null, input)
})
test('playlist metadata excludes duplicate, private, deleted, malformed and live entries, never trusting arbitrary URLs', () => {
  const result = fixture().readPlaylistInfo({ title: 'Beats', entries: [
    { id: video, title: 'First' }, { id: video }, null, { id: 'invalid', url: 'file:///secret' },
    { id: '9bZkp7q19f0', title: '[Private video]' }, { id: '9bZkp7q19f0', availability: 'private' },
    { id: '9bZkp7q19f0', title: '[Deleted video]' }, { id: '9bZkp7q19f0', is_live: true },
    { id: '9bZkp7q19f0', live_status: 'is_upcoming' }, { id: '9bZkp7q19f0', title: 'Second' }
  ] })
  assert.equal(result.tracks.length, 2); assert.equal(result.skipped, 8)
  assert.deepEqual(result.tracks.map(track => track.title), ['First', 'Second'])
})
test('playlist inspection preserves cookies, uses flat bounded enumeration, and never starts media downloads', async () => {
  const f = fixture(async (_tool, args, options) => {
    for (const flag of ['--ignore-config', '--yes-playlist', '--flat-playlist', '--skip-download', '--dump-single-json', '--cookies-from-browser']) assert.ok(args.includes(flag))
    assert.ok(!args.includes('--no-playlist')); assert.equal(args[args.indexOf('--playlist-end') + 1], '501')
    assert.equal(args.at(-1), playlist); assert.equal(options.maxCaptureBytes, 8 * 1024 * 1024)
    return { code: 0, stdout: JSON.stringify({ entries: [] }) }
  })
  assert.deepEqual((await f.inspectPlaylist(playlist, 'request')).tracks, [])
})
test('large playlists are explicitly limited and malformed output never produces jobs', async () => {
  const result = fixture().readPlaylistInfo({ entries: Array.from({ length: 501 }, (_, i) => ({ id: String(i).padStart(11, '0') })) })
  assert.equal(result.tracks.length, 500); assert.equal(result.limited, true)
  for (const response of [{ code: 0, stdout: 'bad json' }, { code: 0, stdout: '{}', stdoutTruncated: true }, { code: 1, stderr: 'Private playlist' }, { timedOut: true }]) await assert.rejects(fixture(async () => response).inspectPlaylist(playlist, 'request'))
})
test('cancel and shutdown abort owned work, reject overlapping reads, and permit retry after cleanup', async () => {
  for (const method of ['cancelPlaylist', 'stopPlaylists']) {
    let entered
    const ready = new Promise(resolve => { entered = resolve })
    const f = fixture(async (_tool, _args, { signal }) => {
      entered()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      return { code: 1, aborted: true }
    })
    const pending = f.inspectPlaylist(playlist, 'first')
    await ready
    await assert.rejects(f.inspectPlaylist(playlist, 'second'), /already/)
    f[method]('first')
    await assert.rejects(pending)
    const retry = f.inspectPlaylist(playlist, 'retry')
    f.cancelPlaylist('retry')
    await assert.rejects(retry)
  }
})
test('missing engine and invalid URLs fail before extractor launch', async () => {
  const f = fixture(() => assert.fail('must not launch'), async () => ({ path: null }))
  await assert.rejects(f.inspectPlaylist(playlist, 'a'), /media engine/)
  await assert.rejects(f.inspectPlaylist('https://evil.test/playlist?list=PL1', 'a'), /valid YouTube/)
})
