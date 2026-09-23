import { build } from 'esbuild'
import { mkdtemp, writeFile, mkdir, readFile, rename, rmdir, readdir } from 'node:fs/promises'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const root = await mkdtemp(path.join(tmpdir(), 'sonic-capture-'))
await build({ entryPoints: ['src/main/lib/child.ts', 'src/main/lib/jsonStore.ts'], outdir: root, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } })
const { run } = await import(pathToFileURL(path.join(root, 'child.mjs')))
const storeUrl = pathToFileURL(path.join(root, 'jsonStore.mjs'))
const { JsonStore, storageStatus } = await import(storeUrl)
const checks = []
async function check(name, fn) { try { await fn(); checks.push({ name, ok: true }) } catch (error) { checks.push({ name, ok: false, error: String(error) }); process.exitCode = 1 } }
const child = (code, opts = {}) => run(process.execPath, ['-e', code], opts)
await check('valid JSON beyond old 512KiB cap', async () => { const r = await child('process.stdout.write(JSON.stringify({title:"x".repeat(1300000)}))', { maxCaptureBytes: 32 * 1024 * 1024 }); assert.equal(r.stdoutTruncated, false); assert.equal(JSON.parse(r.stdout).title.length, 1300000) })
for (const delta of [-1, 0, 1]) await check(`32MiB boundary ${delta}`, async () => { const n = 32 * 1024 * 1024 + delta; const r = await child(`process.stdout.write('x'.repeat(${n}))`, { maxCaptureBytes: 32 * 1024 * 1024 }); assert.equal(Buffer.byteLength(r.stdout), Math.min(n, 32 * 1024 * 1024)); assert.equal(r.stdoutTruncated, delta > 0) })
await check('multibyte byte cap and safe terminal UTF-8', async () => { const r = await child('process.stdout.write("🎵é".repeat(100))', { maxCaptureBytes: 11 }); assert.equal(r.stdout, '🎵é🎵'); assert.equal(Buffer.byteLength(r.stdout), 10); assert.equal(r.stdoutTruncated, true) })
await check('noisy stderr independent of valid stdout', async () => { const r = await child('process.stderr.write("x".repeat(10000));process.stdout.write("{\\"ok\\":true}")', { maxCaptureBytes: 100 }); assert.equal(r.stderrTruncated, true); assert.equal(r.stdoutTruncated, false); assert.equal(JSON.parse(r.stdout).ok, true) })
await check('truncated JSON distinct from malformed JSON', async () => { const a = await child('process.stdout.write(JSON.stringify({x:"a".repeat(200)}))', { maxCaptureBytes: 20 }); assert.equal(a.stdoutTruncated, true); const b = await child('process.stdout.write("{bad}")'); assert.equal(b.stdoutTruncated, false); assert.throws(() => JSON.parse(b.stdout)) })
await check('timeout distinct from cancellation and failure', async () => { const a = await child('setInterval(()=>{},100)', { timeoutMs: 80 }); assert.equal(a.timedOut, true); assert.equal(a.aborted, false); const abort = new AbortController(); abort.abort(); const b = await child('setInterval(()=>{},100)', { signal: abort.signal }); assert.equal(b.aborted, true); assert.equal(b.timedOut, false); const c = await child('process.exit(7)'); assert.equal(c.code, 7); assert.equal(c.aborted, false); await assert.rejects(run(path.join(root, 'missing.exe'), [])) })
await check('failed settings write does not update cache', async () => { const file = path.join(root, 'store.json'); const store = new JsonStore(file, { value: 1 }); store.write({ value: 2 }); await rename(file, `${file}.saved`); await mkdir(file); assert.throws(() => store.write({ value: 3 })); assert.equal(store.read().value, 2); assert.equal(JSON.parse(await readFile(`${file}.saved`, 'utf8')).value, 2) })
await check('shared path cache and immutable committed queue snapshot', async () => {
  const file = path.join(root, 'shared.json'), a = new JsonStore(file, { order: [] }), b = new JsonStore(file, { order: [] })
  const input = { order: ['a', 'b'] }; a.write(input); input.order.reverse()
  assert.deepEqual(a.read().order, ['a', 'b']); b.update(value => ({ order: [...value.order, 'c'] }))
  assert.deepEqual(a.read().order, ['a', 'b', 'c'])
})
await check('injected replacement failure retains pending and previous valid commit; bounded explicit retry', async () => {
  const module = await import(`${storeUrl}?retry`), file = path.join(root, 'retry.json'), store = new module.JsonStore(file, { value: 0 })
  store.write({ value: 1 }); await rename(file, `${file}.saved`); await mkdir(file)
  assert.throws(() => store.write({ value: 2 })); assert.equal(store.read().value, 1)
  assert.equal(module.storageStatus()[0].revision, 2); assert.equal(module.storageStatus()[0].persisted, 1)
  await rmdir(file); await rename(`${file}.saved`, file); module.retryStorage()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).value, 2); assert.equal(module.storageStatus()[0].error, null)
})
await check('removed profile is not recreated by a late write', async () => {
  const directory = path.join(root, 'removed-profile'); await mkdir(directory)
  const store = new JsonStore(path.join(directory, 'queue.json'), {}); store.write({ value: 1 })
  await rename(directory, `${directory}.owner-removed`)
  assert.throws(() => store.write({ value: 2 })); assert.equal(fs.existsSync(directory), false)
})
await check('truncated library recovers validated backup and preserves damaged bytes across a fresh module', async () => {
  const file = path.join(root, 'recover.json'), store = new JsonStore(file, [])
  store.write([{ id: 'one' }]); store.write([{ id: 'one' }, { id: 'two' }])
  await writeFile(file, '[{"id":')
  const fresh = await import(`${storeUrl}?recovery`), recovered = new fresh.JsonStore(file, [])
  assert.deepEqual(recovered.read(), [{ id: 'one' }]); assert.equal(await readFile(file, 'utf8'), '[{"id":')
  assert.ok((await readdir(root)).some(name => name.startsWith('recover.json.damaged-')))
})
await check('unrecoverable malformed library never becomes empty defaults', async () => {
  const file = path.join(root, 'broken.json'); await writeFile(file, 'truncated')
  const store = new JsonStore(file, []); assert.throws(() => store.read(), /Cannot recover/)
  assert.equal(await readFile(file, 'utf8'), 'truncated')
})
await check('injected nested synchronous commit cannot overwrite a newer acknowledgement', async () => {
  const file = path.join(root, 'nested.json'), store = new JsonStore(file, { value: 0 }); store.write({ value: 1 })
  const original = fs.renameSync; let intercepted = false
  fs.renameSync = (from, to) => {
    if (to === file && !intercepted) { intercepted = true; assert.throws(() => store.write({ value: 99 }), /Reentrant write rejected/) }
    return original(from, to)
  }; syncBuiltinESMExports()
  try { store.write({ value: 2 }) } finally { fs.renameSync = original; syncBuiltinESMExports() }
  assert.equal(intercepted, true); assert.equal(JSON.parse(await readFile(file, 'utf8')).value, 2)
})
await check('injected interrupted replacement preserves destination and unrelated temporary files', async () => {
  const file = path.join(root, 'interrupt.json'), store = new JsonStore(file, { value: 0 }); store.write({ value: 1 })
  const unrelated = `${file}.other-operation.tmp`; await writeFile(unrelated, 'owned by another operation')
  const original = fs.renameSync
  fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('Injected interruption before replace'), { code: 'EINTR' }); return original(from, to) }; syncBuiltinESMExports()
  try { assert.throws(() => store.write({ value: 2 })) } finally { fs.renameSync = original; syncBuiltinESMExports() }
  assert.equal(JSON.parse(await readFile(file, 'utf8')).value, 1); assert.equal(await readFile(unrelated, 'utf8'), 'owned by another operation')
  assert.throws(() => store.write({ value: 3 }), /must be retried/)
  store.write({ value: 2 }); store.write({ value: 3 }); assert.equal(store.read().value, 3)
  assert.equal(storageStatus().find(s => s.file.endsWith('interrupt.json')).error, null)
})
await mkdir('test-results', { recursive: true }); await writeFile('test-results/capture.json', JSON.stringify(checks, null, 2)); console.log(JSON.stringify(checks, null, 2))
