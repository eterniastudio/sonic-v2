import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: ['src/renderer/src/features/playback/playbackCheckpointDrain.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false
})
const { drainPlaybackCheckpoints } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

function state() {
  return { pending: [], drainPromise: null, blocked: false, disposed: false }
}

test('empty flush does not pin a completed promise or suppress later checkpoints', async () => {
  const save = state()
  const sent = []
  const send = async command => { sent.push(command) }
  await drainPlaybackCheckpoints(save, send, () => undefined, () => undefined)
  assert.equal(save.drainPromise, null)
  save.pending.push({ type: 'volume', volume: 0.35 })
  await drainPlaybackCheckpoints(save, send, () => undefined, () => undefined)
  assert.deepEqual(sent, [{ type: 'volume', volume: 0.35 }])
  assert.equal(save.pending.length, 0)
  assert.equal(save.drainPromise, null)
  // A later final close checkpoint must still be delivered.
  save.pending.push({ type: 'active', beatId: 'track-a' })
  await drainPlaybackCheckpoints(save, send, () => undefined, () => undefined)
  assert.equal(sent.at(-1).beatId, 'track-a')
})

test('failed checkpoint remains pending, then retry and a later checkpoint drain in order', async () => {
  const save = state()
  const sent = []
  const errors = []
  let fail = true
  const send = async command => {
    if (fail) throw new Error('replacement failed')
    sent.push(command)
  }
  save.pending.push({ type: 'volume', volume: 0.8 })
  await drainPlaybackCheckpoints(save, send, () => undefined, error => errors.push(error.message))
  assert.deepEqual(errors, ['replacement failed'])
  assert.equal(save.blocked, true)
  assert.equal(save.pending.length, 1)
  fail = false
  save.blocked = false // explicit storage retry succeeded
  await drainPlaybackCheckpoints(save, send, () => undefined, error => errors.push(error.message))
  save.pending.push({ type: 'active', beatId: 'track-b' })
  await drainPlaybackCheckpoints(save, send, () => undefined, error => errors.push(error.message))
  assert.deepEqual(sent, [{ type: 'volume', volume: 0.8 }, { type: 'active', beatId: 'track-b' }])
  assert.equal(save.pending.length, 0)
  assert.equal(save.drainPromise, null)
})

test('a synchronous IPC bridge error does not pin the drain promise', async () => {
  const save = state()
  save.pending.push({ type: 'volume', volume: 0.5 })
  const errors = []
  await drainPlaybackCheckpoints(save, () => { throw new Error('bridge unavailable') },
    () => undefined, error => errors.push(error.message))
  assert.deepEqual(errors, ['bridge unavailable'])
  assert.equal(save.drainPromise, null)
  assert.equal(save.pending.length, 1)
  save.blocked = false
  const delivered = []
  await drainPlaybackCheckpoints(save, async command => { delivered.push(command) },
    () => undefined, error => errors.push(error.message))
  assert.deepEqual(delivered, [{ type: 'volume', volume: 0.5 }])
  assert.equal(save.drainPromise, null)
})
