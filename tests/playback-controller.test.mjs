import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: ['src/renderer/src/features/playback/playbackController.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false
})
const { PlaybackController } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

class DeferredEngine {
  constructor() {
    this.listeners = new Map()
    this.loadCalls = []
    this.playCalls = 0
    this.destroyCalls = 0
    this.time = 0
    this.setTimeCalls = 0
    this.volume = 1
    this.loadPromise = new Promise((resolve, reject) => { this.resolveLoad = resolve; this.rejectLoad = reject })
  }
  load(url) { this.loadCalls.push(url); return this.loadPromise }
  play() { this.playCalls++; this.emit('play'); return Promise.resolve() }
  pause() { this.emit('pause') }
  stop() { this.time = 0 }
  setTime(seconds) { this.setTimeCalls++; this.time = seconds; this.emit('timeupdate', seconds) }
  getDuration() { return 18 }
  setVolume(volume) { this.volume = volume }
  on(event, callback) { this.listeners.set(event, callback) }
  destroy() { this.destroyCalls++ }
  emit(event, value) { this.listeners.get(event)?.(value) }
}

function createFixture(overrides = {}) {
  const beats = new Map(['a', 'b', 'c', 'd'].map(id => [id, {
    id, fingerprint: `fingerprint-${id}`, filePath: `/${id}.wav`, missing: false, durationSec: 18
  }]))
  const engines = []
  const checkpoints = []
  const notices = []
  let now = 0
  const controller = new PlaybackController({
    getBeat: id => beats.get(id),
    identify: async id => beats.get(id).fingerprint,
    createEngine: () => { const engine = new DeferredEngine(); engines.push(engine); return engine },
    checkpoint: command => checkpoints.push(command),
    onNotice: message => notices.push(message),
    now: () => now,
    ...overrides
  })
  controller.attachWaveform({})
  return { controller, beats, engines, checkpoints, notices, setNow: value => { now = value } }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

test('recovery retains captured queue and saved position, releases stale path, and waits for explicit Play', async () => {
  const { controller, beats, engines } = createFixture()
  controller.playQueue(['a', 'b', 'c'], 'b', 'Captured collection')
  await flush()
  engines[0].resolveLoad()
  await flush()
  engines[0].emit('timeupdate', 7)
  beats.get('b').missing = true
  controller.reconcile()
  assert.equal(controller.getSnapshot().beatId, 'b')
  assert.equal(controller.getSnapshot().current, 7)
  assert.equal(controller.getSnapshot().status, 'error')
  assert.deepEqual(controller.getSnapshot().queueContext, { label: 'Captured collection', index: 2, count: 3 })
  assert.equal(engines[0].destroyCalls, 1)
  beats.get('b').missing = false
  beats.get('b').filePath = '/recovered/b.wav'
  controller.reconcile()
  await flush()
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.equal(engines.length, 1, 'recovery must not load or autoplay')
  controller.toggle()
  await flush()
  engines[1].resolveLoad()
  await flush()
  assert.equal(engines[1].time, 7)
  assert.equal(controller.getSnapshot().status, 'playing')
  controller.next()
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'c')
  controller.dispose()
})

test('recovering another track leaves active decoder and captured queue untouched', async () => {
  const { controller, beats, engines } = createFixture()
  controller.playQueue(['a', 'b'], 'a', 'Original queue')
  await flush()
  engines[0].resolveLoad()
  await flush()
  beats.get('b').filePath = '/recovered/b.wav'
  controller.reconcile()
  engines[0].emit('timeupdate', 8)
  assert.equal(controller.getSnapshot().current, 8)
  assert.equal(controller.getSnapshot().status, 'playing')
  assert.equal(engines[0].destroyCalls, 0)
  assert.deepEqual(controller.getSnapshot().queueContext, { label: 'Original queue', index: 1, count: 2 })
  controller.dispose()
})

test('late A/B ready, play, error and time callbacks cannot replace C', async () => {
  const { controller, engines } = createFixture()
  controller.playOne('a')
  await flush()
  controller.playOne('b')
  await flush()
  controller.playOne('c')
  await flush()
  assert.equal(engines.length, 3)
  engines[2].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'c')
  assert.equal(controller.getSnapshot().status, 'playing')
  engines[2].emit('timeupdate', 2)
  engines[0].resolveLoad()
  engines[1].resolveLoad()
  await flush()
  engines[0].emit('play')
  engines[0].emit('timeupdate', 15)
  engines[0].emit('error', new Error('stale decoder failure'))
  engines[1].emit('finish')
  assert.deepEqual([engines[0].playCalls, engines[1].playCalls, engines[2].playCalls], [0, 0, 1])
  assert.deepEqual({ id: controller.getSnapshot().beatId, status: controller.getSnapshot().status,
    current: controller.getSnapshot().current, error: controller.getSnapshot().error },
  { id: 'c', status: 'playing', current: 2, error: null })
  controller.dispose()
})

test('pause or stop during deferred load cancels pending autoplay', async () => {
  const { controller, engines } = createFixture()
  controller.playOne('a')
  await flush()
  controller.pause()
  engines[0].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.equal(engines[0].playCalls, 0)
  controller.playOne('b')
  await flush()
  controller.stop()
  engines[1].resolveLoad()
  engines[1].emit('play')
  await flush()
  assert.equal(controller.getSnapshot().status, 'idle')
  assert.equal(controller.getSnapshot().beatId, null)
  assert.equal(engines[1].playCalls, 0)
  controller.dispose()
})

test('captured queue skips missing IDs, preserves paused navigation and never wraps', async () => {
  const { controller, beats, engines, notices } = createFixture()
  beats.get('b').missing = true
  controller.playQueue(['a', 'b', 'c', 'd'], 'a', 'Album candidates')
  await flush()
  engines.at(-1).resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().status, 'playing')
  controller.pause()
  controller.next()
  await flush()
  engines.at(-1).resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'c')
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.deepEqual(controller.getSnapshot().queueContext, { label: 'Album candidates', index: 3, count: 4 })
  assert.match(notices.join(' '), /missing or removed/)

  controller.seek(5)
  controller.previous()
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'c')
  assert.equal(controller.getSnapshot().current, 0)
  controller.previous()
  await flush()
  engines.at(-1).resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'a')
  assert.equal(controller.getSnapshot().status, 'paused')
  controller.next()
  await flush()
  engines.at(-1).resolveLoad()
  await flush()
  controller.next()
  await flush()
  engines.at(-1).resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'd')
  controller.next()
  assert.equal(controller.getSnapshot().beatId, 'd')
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.match(notices.at(-1), /End of audition queue/)
  controller.dispose()
})

test('metadata revisions retain the decoder; content changes reset stale positions', async () => {
  const { controller, beats, engines, checkpoints } = createFixture()
  controller.playOne('a')
  await flush()
  engines[0].resolveLoad()
  await flush()
  controller.seek(6)
  controller.pause()
  const original = engines[0]
  beats.set('a', { ...beats.get('a'), title: 'New metadata only' })
  controller.reconcile()
  assert.equal(engines.length, 1)
  assert.equal(controller.getSnapshot().current, 6)
  assert.equal(original.destroyCalls, 0)
  beats.set('a', { ...beats.get('a'), fingerprint: 'replacement-bytes' })
  controller.reconcile()
  await flush()
  assert.equal(original.destroyCalls, 1)
  assert.equal(engines.length, 2)
  engines[1].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().current, 0)
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.ok(checkpoints.some(command => command.type === 'position' && command.positionSec === 6))
  controller.dispose()
})

test('natural finish advances the captured queue; repeat wins and final finish does not wrap', async () => {
  const { controller, engines, checkpoints } = createFixture()
  controller.playQueue(['a', 'b'], 'a', 'Shortlist')
  await flush()
  engines[0].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().status, 'playing')
  engines[0].emit('finish')
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'b')
  const outgoing = checkpoints.filter(command => command.type === 'position' && command.beatId === 'a')
  assert.ok(outgoing.length > 0)
  assert.equal(outgoing.at(-1).completed, true)
  assert.deepEqual(controller.getSnapshot().queueContext, { label: 'Shortlist', index: 2, count: 2 })
  engines[1].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().status, 'playing')
  assert.equal(checkpoints.filter(command => command.type === 'position' && command.beatId === 'a').at(-1).completed, true)
  controller.setRepeat(true)
  engines[1].emit('finish')
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'b')
  assert.equal(engines.length, 2)
  assert.equal(engines[1].playCalls, 2)
  assert.equal(engines[1].time, 0)
  controller.setRepeat(false)
  engines[1].emit('finish')
  assert.equal(controller.getSnapshot().status, 'ended')
  assert.equal(controller.getSnapshot().beatId, 'b')
  assert.equal(engines.length, 2)
  assert.ok(checkpoints.some(command => command.type === 'position' && command.beatId === 'b' && command.completed))
  controller.dispose()
})

test('failed decoders traverse a queue once, preserving paused manual Next', async () => {
  const { controller, engines, notices, beats } = createFixture()
  controller.playQueue(['a', 'b', 'c'], 'a', 'Failures')
  await flush()
  engines[0].resolveLoad()
  await flush()
  controller.pause()
  controller.next()
  await flush()
  engines[1].rejectLoad(new Error('b cannot decode'))
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'c')
  engines[2].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.equal(engines[2].playCalls, 0)
  controller.dispose()

  const all = createFixture()
  all.controller.playQueue(['a', 'b', 'c'], 'a', 'All unreadable')
  for (let index = 0; index < 3; index++) {
    await flush()
    assert.equal(all.engines.length, index + 1)
    all.engines[index].rejectLoad(new Error(`unreadable ${index}`))
  }
  await flush()
  assert.equal(all.engines.length, 3)
  assert.equal(all.controller.getSnapshot().beatId, 'c')
  assert.equal(all.controller.getSnapshot().status, 'error')
  assert.equal(all.notices.filter(message => message.includes('could not be played')).length, 3)
  all.controller.dispose()

  const missing = createFixture()
  for (const beat of missing.beats.values()) beat.missing = true
  missing.controller.playQueue(['a', 'b', 'c'], 'a', 'All missing')
  assert.equal(missing.controller.getSnapshot().status, 'error')
  assert.equal(missing.engines.length, 0)
  assert.match(missing.controller.getSnapshot().error, /No playable tracks/)
  missing.controller.dispose()
})

test('a failed single-track load can retry; removing the active record releases its engine', async () => {
  const { controller, beats, engines } = createFixture()
  controller.playOne('a')
  await flush()
  engines[0].rejectLoad(new Error('decoder unavailable'))
  await flush()
  assert.equal(controller.getSnapshot().status, 'error')
  controller.toggle()
  await flush()
  assert.equal(engines.length, 2)
  engines[1].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().status, 'playing')
  beats.delete('a')
  controller.reconcile()
  assert.equal(engines[1].destroyCalls, 1)
  assert.equal(controller.getSnapshot().beatId, null)
  assert.equal(controller.getSnapshot().status, 'error')
  assert.match(controller.getSnapshot().error, /removed or is now missing/)
  controller.dispose()
})

test('a late play event and fulfilled play promise cannot undo Pause', async () => {
  let resolvePlay
  const { controller, engines } = createFixture({
    createEngine: () => {
      const engine = new DeferredEngine()
      engine.play = () => {
        engine.playCalls++
        return new Promise(resolve => { resolvePlay = resolve })
      }
      engines.push(engine)
      return engine
    }
  })
  controller.playOne('a')
  await flush()
  engines[0].resolveLoad()
  await flush()
  controller.pause()
  assert.equal(controller.getSnapshot().status, 'paused')
  engines[0].emit('play')
  assert.equal(controller.getSnapshot().status, 'paused')
  resolvePlay()
  await flush()
  assert.equal(controller.getSnapshot().status, 'paused')
  controller.dispose()
})

test('restored position waits for decoded duration when library duration is unknown', async () => {
  const { controller, beats, engines } = createFixture()
  beats.get('a').durationSec = 0
  controller.restore({ schemaVersion: 1, lastTrackId: 'a', volume: 0.4,
    positions: [{ beatId: 'a', fingerprint: 'fingerprint-a', positionSec: 6,
      completed: false, updatedAt: 1 }] })
  await flush()
  assert.equal(engines.length, 1)
  engines[0].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.equal(controller.getSnapshot().current, 6)
  assert.equal(engines[0].time, 6)
  assert.equal(engines[0].volume, 0.4)
  controller.dispose()
})

test('a late finish after user Pause cannot advance, while natural pause then finish can', async () => {
  const { controller, engines, checkpoints } = createFixture()
  controller.playQueue(['a', 'b'], 'a', 'Two tracks')
  await flush()
  engines[0].resolveLoad()
  await flush()
  controller.pause()
  engines[0].emit('finish')
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'a')
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.equal(engines.length, 1)
  assert.equal(checkpoints.some(command => command.type === 'position' && command.beatId === 'a' && command.completed), false)

  controller.toggle()
  await flush()
  engines[0].emit('pause') // WaveSurfer can pause itself before natural finish.
  engines[0].emit('finish')
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'b')
  assert.equal(engines.length, 2)
  controller.dispose()
})

test('invalid new audition target checkpoints the previously playing track', async () => {
  const { controller, beats, engines, checkpoints } = createFixture()
  controller.playOne('a')
  await flush()
  engines[0].resolveLoad()
  await flush()
  engines[0].emit('timeupdate', 7)
  beats.get('b').missing = true
  controller.playQueue(['b'], 'b', 'Unavailable')
  const saved = checkpoints.filter(command => command.type === 'position' && command.beatId === 'a')
  assert.equal(saved.at(-1).positionSec, 7)
  assert.equal(controller.getSnapshot().beatId, null)
  assert.equal(controller.getSnapshot().status, 'error')
  controller.dispose()
})

test('close flush latches playback commands after checkpointing and releasing decoder', async () => {
  const { controller, engines, checkpoints } = createFixture()
  controller.playOne('a')
  await flush()
  engines[0].resolveLoad()
  await flush()
  engines[0].emit('timeupdate', 5)
  controller.beginClosing()
  const before = checkpoints.length
  assert.equal(controller.getSnapshot().closing, true)
  assert.equal(controller.getSnapshot().status, 'paused')
  assert.equal(engines[0].destroyCalls, 1)
  assert.equal(checkpoints.filter(command => command.type === 'position' && command.beatId === 'a').at(-1).positionSec, 5)
  controller.playOne('b')
  controller.playQueue(['b'], 'b', 'Blocked')
  controller.seek(10)
  controller.setVolume(0.2)
  controller.setRepeat(true)
  controller.next()
  controller.previous()
  controller.toggle()
  controller.stop()
  assert.equal(controller.getSnapshot().beatId, 'a')
  assert.equal(controller.getSnapshot().current, 5)
  assert.equal(controller.getSnapshot().volume, 1)
  assert.equal(engines.length, 1)
  assert.equal(checkpoints.length, before)
  controller.dispose()
})

for (const frameRate of [60, 120]) test(`${frameRate}Hz progress is bounded while Pause and checkpoints keep the latest position`, async () => {
  const { controller, engines, checkpoints, setNow } = createFixture()
  controller.playOne('a')
  await flush()
  engines[0].resolveLoad()
  await flush()
  let notifications = 0
  const unsubscribe = controller.subscribe(() => { notifications++ })
  for (let frame = 1; frame <= frameRate; frame++) {
    setNow(frame * 1000 / frameRate)
    engines[0].emit('timeupdate', frame / frameRate)
  }
  assert.ok(notifications <= 10, `one second published ${notifications} progress updates`)
  engines[0].emit('timeupdate', 1.012)
  controller.pause()
  assert.equal(controller.getSnapshot().current, 1.012)
  assert.equal(checkpoints.filter(command => command.type === 'position').at(-1).positionSec, 1.012)
  const before = notifications
  controller.setSaveError(null)
  controller.setRepeat(false)
  controller.setVolume(1)
  assert.equal(notifications, before, 'unchanged settings/save acknowledgements do not repaint the player')
  unsubscribe()
  controller.dispose()
})

test('paused waveform interaction saves the sought position and finished interaction resumes there', async () => {
  const { controller, engines, checkpoints } = createFixture()
  controller.playOne('a')
  await flush()
  engines[0].resolveLoad()
  await flush()
  controller.pause()
  engines[0].setTime(5) // WaveSurfer applies click seeks before emitting interaction.
  const beforeClick = engines[0].setTimeCalls
  engines[0].emit('interaction', 5)
  assert.equal(engines[0].setTimeCalls, beforeClick, 'interaction does not repeat the backend seek')
  assert.equal(controller.getSnapshot().current, 5)
  assert.equal(controller.getSnapshot().status, 'paused')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(checkpoints.filter(command => command.type === 'position').at(-1).positionSec, 5)

  controller.toggle()
  await flush()
  engines[0].emit('finish')
  assert.equal(controller.getSnapshot().status, 'ended')
  engines[0].setTime(9)
  engines[0].emit('interaction', 9)
  assert.equal(controller.getSnapshot().status, 'paused')
  controller.toggle()
  await flush()
  assert.equal(engines[0].time, 9)
  assert.equal(controller.getSnapshot().status, 'playing')
  controller.dispose()
})

test('Previous uses the actual position across the throttled three-second boundary', async () => {
  const { controller, engines, setNow } = createFixture()
  controller.playQueue(['a', 'b'], 'b', 'Two tracks')
  await flush()
  engines[0].resolveLoad()
  await flush()
  setNow(2990)
  engines[0].emit('timeupdate', 2.99)
  setNow(3000)
  engines[0].emit('timeupdate', 3.04)
  assert.equal(controller.getSnapshot().current, 2.99, 'display has not repainted the next frame')
  controller.previous()
  assert.equal(controller.getSnapshot().beatId, 'b')
  assert.equal(controller.getSnapshot().current, 0)
  assert.equal(engines.length, 1)
  assert.equal(engines[0].time, 0)
  controller.previous()
  await flush()
  assert.equal(controller.getSnapshot().beatId, 'a', 'after restart Previous can navigate the prior track')
  controller.dispose()
})

test('paused waveform dragging preserves the backend debounce and checkpoints the actual position', async () => {
  const { controller, engines, checkpoints } = createFixture()
  controller.playOne('a')
  await flush()
  engines[0].resolveLoad()
  await flush()
  controller.pause()
  engines[0].setTime(4)
  const beforeDrag = engines[0].setTimeCalls
  engines[0].emit('interaction', 7)
  engines[0].emit('interaction', 10)
  assert.equal(controller.getSnapshot().current, 10, 'controls preview the pending drag target')
  assert.equal(engines[0].time, 4, 'the decoder has not applied the debounced drag')
  assert.equal(engines[0].setTimeCalls, beforeDrag, 'pointer moves do not seek the decoder')
  controller.pause()
  assert.equal(checkpoints.filter(command => command.type === 'position').at(-1).positionSec, 4)
  await new Promise(resolve => setTimeout(resolve, 200))
  engines[0].setTime(10) // WaveSurfer applies the final paused drag after its debounce.
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(controller.getSnapshot().current, 10)
  assert.equal(checkpoints.filter(command => command.type === 'position').at(-1).positionSec, 10)
  controller.dispose()
})

test('decoder construction failures become retryable player errors', async () => {
  let fail = true
  const { controller, engines, notices } = createFixture({
    createEngine: () => {
      if (fail) throw new Error('Audio context unavailable')
      const engine = new DeferredEngine()
      engines.push(engine)
      return engine
    }
  })
  controller.playOne('a')
  await flush()
  assert.equal(controller.getSnapshot().status, 'error')
  assert.equal(controller.getSnapshot().error, 'Audio context unavailable')
  assert.equal(notices.length, 1)
  fail = false
  controller.toggle()
  await flush()
  engines[0].resolveLoad()
  await flush()
  assert.equal(controller.getSnapshot().status, 'playing')
  controller.dispose()
})

test('decoder setup failures and live errors release their engine exactly once', async () => {
  const { controller, engines } = createFixture({
    createEngine: () => {
      const engine = new DeferredEngine()
      engine.setVolume = () => { throw new Error('Decoder setup failed') }
      engines.push(engine)
      return engine
    }
  })
  controller.playOne('a')
  await flush()
  assert.equal(controller.getSnapshot().status, 'error')
  assert.equal(engines[0].destroyCalls, 1)
  controller.dispose()
  assert.equal(engines[0].destroyCalls, 1)

  const active = createFixture()
  active.controller.playOne('a')
  await flush()
  active.engines[0].resolveLoad()
  await flush()
  active.engines[0].emit('error', new Error('Decoder stopped'))
  assert.equal(active.controller.getSnapshot().status, 'error')
  assert.equal(active.engines[0].destroyCalls, 1)
  active.engines[0].emit('play')
  active.engines[0].emit('timeupdate', 15)
  assert.equal(active.controller.getSnapshot().status, 'error')
  active.controller.dispose()
  assert.equal(active.engines[0].destroyCalls, 1)
})
