import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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
const providers = load('../src/shared/providers.ts')
const urls = load('../src/shared/url.ts', { './providers': providers })
const organization = load('../src/shared/organization.ts', { './providers': providers })

/** [input, expected provider, expected canonical link] */
const ACCEPTED = [
  // Bandcamp tracks
  ['https://artist.bandcamp.com/track/night-drive', 'bandcamp', 'https://artist.bandcamp.com/track/night-drive'],
  ['https://ARTIST.bandcamp.com/track/night-drive/?from=embed#t=10', 'bandcamp', 'https://artist.bandcamp.com/track/night-drive'],
  // Vimeo
  ['https://vimeo.com/76979871', 'vimeo', 'https://vimeo.com/76979871'],
  ['https://www.vimeo.com/76979871?share=copy', 'vimeo', 'https://vimeo.com/76979871'],
  ['https://vimeo.com/76979871/abc123def0', 'vimeo', 'https://vimeo.com/76979871/abc123def0'],
  ['https://player.vimeo.com/video/76979871?h=abc123def0&autoplay=1', 'vimeo', 'https://vimeo.com/76979871/abc123def0'],
  ['https://vimeo.com/channels/staffpicks/76979871', 'vimeo', 'https://vimeo.com/76979871'],
  ['https://vimeo.com/groups/beats/videos/76979871', 'vimeo', 'https://vimeo.com/76979871'],
  // Mixcloud
  ['https://www.mixcloud.com/dj-name/late-night-mix/', 'mixcloud', 'https://www.mixcloud.com/dj-name/late-night-mix/'],
  ['https://m.mixcloud.com/dj-name/late-night-mix?utm=1', 'mixcloud', 'https://www.mixcloud.com/dj-name/late-night-mix/'],
  // Audiomack
  ['https://audiomack.com/producer/song/dark-trap-beat', 'audiomack', 'https://audiomack.com/producer/song/dark-trap-beat'],
  ['https://www.audiomack.com/song/producer/dark-trap-beat', 'audiomack', 'https://audiomack.com/producer/song/dark-trap-beat'],
  // Dailymotion
  ['https://www.dailymotion.com/video/x7tgad0', 'dailymotion', 'https://www.dailymotion.com/video/x7tgad0'],
  ['https://www.dailymotion.com/video/x7tgad0_some-title', 'dailymotion', 'https://www.dailymotion.com/video/x7tgad0'],
  ['https://dai.ly/x7tgad0', 'dailymotion', 'https://www.dailymotion.com/video/x7tgad0'],
  ['https://geo.dailymotion.com/player.html?video=x7tgad0', 'dailymotion', 'https://www.dailymotion.com/video/x7tgad0'],
  // Twitch clips and VODs
  ['https://clips.twitch.tv/FunnyClipSlug-abc123', 'twitch', 'https://clips.twitch.tv/FunnyClipSlug-abc123'],
  ['https://www.twitch.tv/streamer/clip/FunnyClipSlug-abc123?filter=clips', 'twitch', 'https://clips.twitch.tv/FunnyClipSlug-abc123'],
  ['https://www.twitch.tv/videos/1234567890', 'twitch', 'https://www.twitch.tv/videos/1234567890'],
  ['https://m.twitch.tv/videos/1234567890', 'twitch', 'https://www.twitch.tv/videos/1234567890'],
  // TikTok
  ['https://www.tiktok.com/@producer.beats/video/7234567890123456789?lang=en', 'tiktok', 'https://www.tiktok.com/@producer.beats/video/7234567890123456789'],
  ['https://vm.tiktok.com/ZMabc123/', 'tiktok', 'https://vm.tiktok.com/ZMabc123/'],
  ['https://www.tiktok.com/t/ZTabc123', 'tiktok', 'https://www.tiktok.com/t/ZTabc123/'],
  // Instagram
  ['https://www.instagram.com/reel/Cabc123XYZ/?igsh=1', 'instagram', 'https://www.instagram.com/reel/Cabc123XYZ/'],
  ['https://instagram.com/reels/Cabc123XYZ', 'instagram', 'https://www.instagram.com/reel/Cabc123XYZ/'],
  ['https://www.instagram.com/p/Cabc123XYZ/', 'instagram', 'https://www.instagram.com/p/Cabc123XYZ/'],
  ['https://www.instagram.com/producer/reel/Cabc123XYZ/', 'instagram', 'https://www.instagram.com/reel/Cabc123XYZ/'],
  // Reddit
  ['https://www.reddit.com/r/makinghiphop/comments/abc123/my_new_beat/', 'reddit', 'https://www.reddit.com/r/makinghiphop/comments/abc123/'],
  ['https://old.reddit.com/r/makinghiphop/comments/abc123/', 'reddit', 'https://www.reddit.com/r/makinghiphop/comments/abc123/'],
  ['https://redd.it/abc123', 'reddit', 'https://www.reddit.com/comments/abc123/'],
  ['https://v.redd.it/x1y2z3a4b5', 'reddit', 'https://v.redd.it/x1y2z3a4b5'],
  // Streamable
  ['https://streamable.com/moo', 'streamable', 'https://streamable.com/moo'],
  ['https://streamable.com/e/abc12x', 'streamable', 'https://streamable.com/abc12x'],
  // X / Twitter
  ['https://twitter.com/producer/status/1234567890123456789', 'twitter', 'https://x.com/producer/status/1234567890123456789'],
  ['https://x.com/producer/status/1234567890123456789/video/1?s=20', 'twitter', 'https://x.com/producer/status/1234567890123456789'],
  ['https://mobile.twitter.com/i/web/status/1234567890123456789', 'twitter', 'https://x.com/i/status/1234567890123456789'],
  // Internet Archive
  ['https://archive.org/details/some-item_2020', 'archive', 'https://archive.org/details/some-item_2020'],
  ['https://www.archive.org/details/some-item_2020/track01.mp3', 'archive', 'https://archive.org/details/some-item_2020/track01.mp3'],
  ['https://archive.org/embed/some-item_2020', 'archive', 'https://archive.org/details/some-item_2020'],
  ['https://archive.org/download/some-item_2020/track01.flac', 'archive', 'https://archive.org/download/some-item_2020/track01.flac'],
  // Direct media files
  ...['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'mp4', 'webm'].map(ext =>
    [`https://cdn.example.com/beats/loop.${ext}`, 'direct', `https://cdn.example.com/beats/loop.${ext}`]),
  ['https://cdn.example.com/beats/LOOP.MP3?token=abc#frag', 'direct', 'https://cdn.example.com/beats/LOOP.MP3?token=abc']
]

test('every provider accepts and canonicalises its single-track links', () => {
  for (const [input, provider, normalized] of ACCEPTED) {
    const parsed = urls.parseVideoUrl(input)
    assert.equal(parsed.ok, true, `${input}: ${parsed.reason}`)
    assert.equal(parsed.provider, provider, input)
    assert.equal(parsed.normalized, normalized, input)
    assert.equal(parsed.videoId, null, `${input} must not claim a YouTube video id`)
    assert.equal(urls.coverArtFor(input), null, `${input} must not derive i.ytimg artwork`)
  }
  for (const provider of new Set(ACCEPTED.map(entry => entry[1]))) assert.ok(urls.providerById(provider), provider)
})

const REJECTED = [
  // Bandcamp: discovery, profile, album (album is a collection, not a track)
  ['https://bandcamp.com/discover', 'bandcamp'], ['https://artist.bandcamp.com/', 'bandcamp'], ['https://artist.bandcamp.com/music', 'bandcamp'],
  ['https://daily.bandcamp.com/track/feature', 'bandcamp'], ['https://artist.bandcamp.com/album/first-album', 'bandcamp'],
  // Vimeo profiles and showcases
  ['https://vimeo.com/someuser', 'vimeo'], ['https://vimeo.com/channels/staffpicks', 'vimeo'], ['https://player.vimeo.com/video/abc', 'vimeo'],
  // Mixcloud profiles, playlists and reserved pages
  ['https://www.mixcloud.com/dj-name/', 'mixcloud'], ['https://www.mixcloud.com/dj-name/uploads/', 'mixcloud'],
  ['https://www.mixcloud.com/dj-name/playlists/', 'mixcloud'], ['https://www.mixcloud.com/discover/house/', 'mixcloud'],
  ['https://www.mixcloud.com/dj-name/playlists/my-list/', 'mixcloud'],
  // Audiomack albums and profiles
  ['https://audiomack.com/producer', 'audiomack'], ['https://audiomack.com/producer/album/tape', 'audiomack'],
  // Dailymotion channels
  ['https://www.dailymotion.com/someuser', 'dailymotion'], ['https://www.dailymotion.com/video/notanid', 'dailymotion'],
  // Twitch live channels
  ['https://www.twitch.tv/streamer', 'twitch'], ['https://www.twitch.tv/directory', 'twitch'], ['https://www.twitch.tv/videos/abc', 'twitch'],
  // TikTok profiles and sounds
  ['https://www.tiktok.com/@producer', 'tiktok'], ['https://www.tiktok.com/music/sound-123', 'tiktok'], ['https://www.tiktok.com/@producer/video/abc', 'tiktok'],
  // Instagram profiles and stories
  ['https://www.instagram.com/producer/', 'instagram'], ['https://www.instagram.com/stories/producer/123/', 'instagram'],
  // Reddit listings and profiles
  ['https://www.reddit.com/r/makinghiphop/', 'reddit'], ['https://www.reddit.com/user/someone/', 'reddit'], ['https://www.reddit.com/', 'reddit'],
  // Streamable home and multi-part paths
  ['https://streamable.com/', 'streamable'], ['https://streamable.com/a/b/c', 'streamable'],
  // X profiles and non-numeric ids
  ['https://x.com/producer', 'twitter'], ['https://twitter.com/producer/status/abc', 'twitter'], ['https://x.com/i/spaces/1abc', 'twitter'],
  // Internet Archive search and traversal
  ['https://archive.org/search?query=beats', 'archive'], ['https://archive.org/details/', 'archive'], ['https://archive.org/download/item', 'archive'],
  ['https://archive.org/about/', 'archive'], ['https://archive.org/details/bad%20id', 'archive']
]

test('provider pages that are not single tracks are rejected with that provider named', () => {
  for (const [input, provider] of REJECTED) {
    for (const options of [{}, { allowOtherSites: true }]) {
      const parsed = urls.parseVideoUrl(input, options)
      assert.equal(parsed.ok, false, `${input} ${JSON.stringify(options)}`)
      assert.equal(parsed.provider, provider, `${input} must be judged by its own provider, never the generic fallback`)
      assert.ok(parsed.reason && parsed.reason.length > 10, input)
    }
  }
})

test('common link hygiene applies to every provider', () => {
  for (const input of ['http://vimeo.com/76979871', 'https://user:pass@vimeo.com/76979871', 'https://vimeo.com:8443/76979871',
    'http://cdn.example.com/a.mp3', 'https://vimeo.com.evil.test/76979871', 'https://evil-bandcamp.com/track/x', 'ftp://cdn.example.com/a.mp3']) {
    assert.equal(urls.parseVideoUrl(input).ok, false, input)
    assert.equal(urls.parseVideoUrl(input, { allowOtherSites: true }).ok, input === 'https://evil-bandcamp.com/track/x', input)
  }
})

test('direct media is refused for local and private network hosts', () => {
  for (const host of ['localhost', '127.0.0.1', '127.1', '0x7f000001', '2130706433', '0177.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.1', '169.254.1.1', '[::1]', 'nas', 'printer.local', 'router.lan']) {
    for (const options of [{}, { allowOtherSites: true }]) {
      assert.equal(urls.parseVideoUrl(`https://${host}/beat.mp3`, options).ok, false, `${host} ${JSON.stringify(options)}`)
    }
  }
  assert.equal(urls.parseVideoUrl('https://8.8.8.8/beat.mp3').provider, 'direct')
  assert.equal(urls.parseVideoUrl('https://cdn.example.com/beat.txt').ok, false)
  assert.equal(urls.parseVideoUrl('https://cdn.example.com/beat.mp3.html').ok, false)
})

test('the generic fallback is accepted only when "Allow other sites" is on', () => {
  const page = 'https://www.example.org/beats/123?ref=feed#comments'
  const off = urls.parseVideoUrl(page)
  assert.equal(off.ok, false)
  assert.equal(off.provider, null)
  assert.match(off.reason, /Allow other sites/)
  assert.deepEqual(urls.parseVideoUrl(page, { allowOtherSites: true }), {
    ok: true, normalized: 'https://www.example.org/beats/123?ref=feed', videoId: null, provider: 'generic', reason: null
  })
  const blob = `${page}\nhttps://vimeo.com/76979871\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ`
  assert.deepEqual(urls.extractVideoUrls(blob).accepted.map(value => value.provider), ['vimeo', 'youtube'])
  assert.deepEqual(urls.extractVideoUrls(blob, { allowOtherSites: true }).accepted.map(value => value.provider), ['generic', 'vimeo', 'youtube'])
  assert.equal(urls.extractIntakeUrls(blob).rejected.length, 1)
  assert.equal(urls.extractIntakeUrls(blob, { allowOtherSites: true }).rejected.length, 0)
  // Generic links never pose as collections, and known sites never fall through.
  assert.equal(urls.parseCollectionUrl(page), null)
  assert.equal(urls.parseVideoUrl('https://www.youtube.com/@channel', { allowOtherSites: true }).provider, 'youtube')
  assert.equal(urls.parseVideoUrl('https://www.youtube.com/@channel', { allowOtherSites: true }).ok, false)
  for (const input of ['https://localhost/page', 'https://192.168.0.1/admin', 'https://intranet/page']) {
    assert.equal(urls.parseVideoUrl(input, { allowOtherSites: true }).ok, false, input)
  }
})

test('YouTube and SoundCloud results are unchanged by the registry', () => {
  assert.deepEqual(urls.parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=4'), {
    ok: true, normalized: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', provider: 'youtube', reason: null
  })
  assert.deepEqual(urls.parseVideoUrl('https://www.youtube.com/@channel'), {
    ok: false, normalized: null, videoId: null, provider: 'youtube', reason: 'Could not read a video id — playlists and channel links are not supported'
  })
  assert.deepEqual(urls.parseVideoUrl('https://soundcloud.com/producer/sets/beats'), {
    ok: false, normalized: null, videoId: null, provider: 'soundcloud', reason: 'Use a SoundCloud track link — playlists and profiles are not supported'
  })
  assert.equal(urls.coverArtFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  assert.equal(urls.parsePlaylistUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest123'), 'https://www.youtube.com/playlist?list=PLtest123')
})

test('collections: YouTube playlists and Bandcamp albums expand; other providers do not', () => {
  assert.deepEqual(urls.parseCollectionUrl('https://artist.bandcamp.com/album/first-album?from=x'), {
    provider: 'bandcamp', normalized: 'https://artist.bandcamp.com/album/first-album'
  })
  assert.deepEqual(urls.parseCollectionUrl('https://youtube.com/playlist?list=PLtest123'), {
    provider: 'youtube', normalized: 'https://www.youtube.com/playlist?list=PLtest123'
  })
  for (const input of ['https://artist.bandcamp.com/track/one', 'https://www.bandcamp.com/album/x', 'https://audiomack.com/producer/album/tape',
    'https://soundcloud.com/producer/sets/beats', 'http://artist.bandcamp.com/album/x', 'https://vimeo.com/showcase/123']) {
    assert.equal(urls.parseCollectionUrl(input), null, input)
  }
  const intake = urls.extractIntakeUrls('https://artist.bandcamp.com/album/first-album https://artist.bandcamp.com/track/one')
  assert.deepEqual(intake.playlists, ['https://artist.bandcamp.com/album/first-album'])
  assert.deepEqual(intake.tracks.map(track => track.normalized), ['https://artist.bandcamp.com/track/one'])
  const flags = Object.fromEntries(urls.ALL_PROVIDERS.map(provider => [provider.id, provider.supportsCollections]))
  assert.deepEqual(Object.keys(flags).filter(id => flags[id]), ['youtube', 'bandcamp'])
})

test('Bandcamp album entries are admitted only as Bandcamp tracks', () => {
  const playlist = load('../src/main/services/playlist.ts', {
    '@shared/url': urls, '@shared/playlist': { PLAYLIST_LIMIT: 500 },
    '../lifecycle': { assertAccepting() {} }, '../lib/child': {}, './engine': {}, './probe': {}
  })
  const review = playlist.readPlaylistInfo({ title: 'First Album', entries: [
    { url: 'https://artist.bandcamp.com/track/one', title: 'One' },
    { url: 'https://artist.bandcamp.com/track/one?x=1', title: 'One again' },
    { webpage_url: 'https://artist.bandcamp.com/track/two' },
    { url: '1812978515', webpage_url: 'https://artist.bandcamp.com/track/three', title: 'Three' },
    { url: '/track/four', title: 'Four' },
    { url: 'https://evil.test/track/nope', webpage_url: 'https://artist.bandcamp.com/track/five', title: 'Five' },
    { url: '//169.254.169.254/latest/meta-data', title: 'Metadata' },
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Foreign' },
    { url: 'file:///C:/secret.mp3' }, { url: 'https://evil.test/track/x' }, { id: '123' }, null
  ] }, 'bandcamp', 'https://artist.bandcamp.com/album/first-album')
  assert.deepEqual(review.tracks, [
    { url: 'https://artist.bandcamp.com/track/one', title: 'One' },
    { url: 'https://artist.bandcamp.com/track/two', title: 'https://artist.bandcamp.com/track/two' },
    { url: 'https://artist.bandcamp.com/track/three', title: 'Three' },
    { url: 'https://artist.bandcamp.com/track/four', title: 'Four' },
    { url: 'https://artist.bandcamp.com/track/five', title: 'Five' }
  ])
  assert.equal(review.skipped, 7)
  assert.equal(playlist.readPlaylistInfo({ entries: [] }, 'bandcamp').title, 'Bandcamp collection')
  assert.throws(() => playlist.readPlaylistInfo({}, 'bandcamp'), /Bandcamp returned no playlist entries/)
})

test('artwork: YouTube keeps i.ytimg thumbnails, others use the probed https thumbnail', () => {
  assert.equal(urls.artworkFor('youtube', 'dQw4w9WgXcQ', 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp'), 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp')
  assert.equal(urls.artworkFor('youtube', 'dQw4w9WgXcQ', 'https://evil.test/a.jpg'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  assert.equal(urls.artworkFor('youtube', 'dQw4w9WgXcQ', null), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  assert.equal(urls.artworkFor('bandcamp', '123', 'https://f4.bcbits.com/img/a1_10.jpg'), 'https://f4.bcbits.com/img/a1_10.jpg')
  for (const bad of ['http://f4.bcbits.com/a.jpg', 'file:///C:/a.jpg', 'https://192.168.1.1/a.jpg', 'https://localhost/a.jpg', 'https://u:p@cdn.example.com/a.jpg', 'not a url', null]) {
    assert.equal(urls.artworkFor('generic', null, bad), null, String(bad))
  }
  for (const provider of urls.ALL_PROVIDERS) assert.equal(provider.artwork, provider.id === 'youtube' ? 'youtube-thumbnail' : 'probe-thumbnail')
})

test('yt-dlp errors become plain sentences naming the provider', () => {
  const describe = urls.describeProviderError
  assert.equal(describe('', 'vimeo'), 'yt-dlp could not read this link.')
  assert.equal(describe('WARNING: x\nERROR: [vimeo] 123: This video is private', 'vimeo'), 'This Vimeo link is private.')
  assert.match(describe('ERROR: [Instagram] abc: Requested content is not available, rate-limit reached or login required', 'instagram'), /^Instagram only shows this to signed-in viewers/)
  assert.match(describe('ERROR: Unable to download webpage: HTTP Error 404: Not Found', 'tiktok'), /TikTok link was not found/)
  assert.match(describe('ERROR: The uploader has not made this video available in your country (geo restricted)', 'dailymotion'), /Dailymotion media is region-locked/)
  assert.match(describe('ERROR: Read timed out.', 'mixcloud'), /connection to Mixcloud timed out/)
  assert.match(describe('ERROR: <urlopen error [Errno 11001] getaddrinfo failed>', 'streamable'), /Could not reach Streamable/)
  assert.match(describe('ERROR: [twitter] 123: No video could be found in this tweet', 'twitter'), /X post has no video/)
  assert.match(describe('ERROR: Unsupported URL: https://www.example.org/page', 'generic'), /no playable media on this page/)
  assert.match(describe('ERROR: [vimeo] 1: This video is protected by a password', 'vimeo'), /password-protected/)
  assert.match(describe('ERROR: [twitch:vod] v1: This video is only available to subscribers', 'twitch'), /subscribers only/)
  assert.equal(describe('ERROR: something odd happened', 'audiomack'), 'something odd happened')
  // YouTube and SoundCloud keep their established wording.
  assert.equal(describe('ERROR: timed out', 'youtube'), 'The connection to YouTube timed out.')
  assert.equal(describe('ERROR: timed out', null), 'The connection to YouTube timed out.')
  assert.equal(describe('ERROR: private track', 'soundcloud'), 'This SoundCloud track is private or unavailable. Check the track link and access.')
  for (const provider of urls.ALL_PROVIDERS) assert.equal(typeof describe('ERROR: network down', provider.id), 'string')
})

test('source kinds: legacy records still validate, every provider id is accepted, anything else is refused', () => {
  for (const kind of ['youtube', 'soundcloud', 'local', 'unknown', ...urls.PROVIDER_IDS]) {
    assert.equal(organization.isSourceKind(kind), true, kind)
    assert.equal(organization.validateSmartCollectionRule({ version: 1, sourceKind: kind }), true, kind)
  }
  for (const kind of ['YouTube', 'spotify', '', 'local ', 7, null]) {
    assert.equal(organization.validateSmartCollectionRule({ version: 1, sourceKind: kind }), false, String(kind))
  }
  assert.equal(organization.validateSmartCollectionRule({ version: 1 }), true)
  assert.equal(urls.sourceKindName('local'), 'Local')
  assert.equal(urls.sourceKindName('unknown'), 'Unknown')
  assert.equal(urls.sourceKindName('twitter'), 'X')
  const openLabels = Object.fromEntries(urls.ALL_PROVIDERS.map(provider => [provider.id, provider.openLabel]))
  assert.equal(openLabels.youtube, 'Open on YouTube')
  assert.equal(openLabels.soundcloud, 'Open on SoundCloud')
  assert.equal(openLabels.bandcamp, 'Open on Bandcamp')
  assert.equal(new Set(urls.PROVIDER_IDS).size, urls.PROVIDER_IDS.length)
})

test('"Allow other sites" defaults off and older settings files migrate to off', () => {
  let normalize
  const service = load('../src/main/services/settings.ts', {
    'node:events': { EventEmitter },
    '@shared/presets': { PRESET_MAP: { 'mp3-320': {} }, DEFAULT_PRESET_ID: 'mp3-320' },
    '@shared/template': { DEFAULT_NAMING_TEMPLATE: '{title}' },
    '@shared/format': { clamp: (value, min, max) => Math.min(max, Math.max(min, value)) },
    './paths': { defaultDownloadDir: () => '/isolated/downloads', settingsFile: () => '/isolated/settings.json' },
    '../lib/jsonStore': { JsonStore: class { constructor(file, defaults, normalizer) { normalize = normalizer; this.value = defaults } read() { return this.value } write(value) { this.value = value; return value } } }
  })
  assert.equal(service.defaultSettings().allowOtherSites, false)
  assert.equal(normalize({ theme: 'dark', cookiesFromBrowser: 'none' }).allowOtherSites, false)
  assert.equal(normalize({ allowOtherSites: 'yes' }).allowOtherSites, false)
  assert.equal(normalize({ allowOtherSites: true }).allowOtherSites, true)
  assert.equal(service.settingsService.patch({ allowOtherSites: true }).allowOtherSites, true)
  assert.equal(service.settingsService.reset().allowOtherSites, false)
})
