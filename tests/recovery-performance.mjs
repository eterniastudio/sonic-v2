import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Script } from 'node:vm'
import { fileURLToPath } from 'node:url'

// Reproduce: node tests/recovery-performance.mjs
// This is a service + single-process search experiment, not Electron UI timing.
// Recovery/file identity/search execute checked-in source; only the library read
// boundary and lifecycle state are doubles. All candidate I/O and hashes are real.
const require = createRequire(import.meta.url)
const ts = require('typescript')
const workspace = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = path.join(workspace, 'test-results', 'recovery-performance', `run-${Date.now()}`)
const fixtureRoot = path.join(output, 'fixture')
const pickedRoot = path.join(fixtureRoot, 'picked')
const candidateRoot = path.join(pickedRoot, 'moved')
const irrelevantRoot = path.join(pickedRoot, 'unrelated')
const count = 10_000
const candidateCount = 24
const candidateBytes = 8 * 1024 ** 2
const irrelevantCount = 512
const owner = 710
const queryCount = 64
const queryPeriodMs = 16
const progressPeriodMs = 16
const loadedSources = []
let telemetry = null
let onHashChunk = null
const digest = data => createHash('sha256').update(data).digest('hex')
const round = n => Number(n.toFixed(3))
const quantile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null
const summary = values => ({ samples: values.length, mean: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
  p50: values.length ? round(quantile(values, 0.5)) : null, p95: values.length ? round(quantile(values, 0.95)) : null,
  max: values.length ? round(Math.max(...values)) : null })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function compileSource(relative, dependencies = {}, selectFunction = null) {
  const filename = path.join(workspace, relative)
  const original = readFileSync(filename, 'utf8')
  loadedSources.push({ path: relative, sha256: digest(original), selectedFunction: selectFunction })
  let source = original
  if (selectFunction) {
    const ast = ts.createSourceFile(filename, original, ts.ScriptTarget.Latest, true)
    const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === selectFunction)
    assert.ok(declaration, `Missing checked-in function ${selectFunction}`)
    source = declaration.getText(ast)
  }
  const compiled = ts.transpileModule(source, { fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true })
  const errors = compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  assert.equal(errors.length, 0, errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  const module = { exports: {} }
  const factory = new Script(`(function(require, module, exports) {\n${compiled.outputText}\n})`, { filename }).runInThisContext()
  factory(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name} in ${relative}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

await fs.mkdir(candidateRoot, { recursive: true })
await fs.mkdir(irrelevantRoot, { recursive: true })
const fingerprints = []
for (let i = 0; i < candidateCount; i++) {
  const bytes = Buffer.alloc(candidateBytes, i + 1)
  bytes.writeUInt32LE(i, 0)
  fingerprints.push(digest(bytes))
  // Renamed AND moved, so the size/hash path must discover these candidates.
  await fs.writeFile(path.join(candidateRoot, `renamed-${i}.wav`), bytes)
}
await Promise.all(Array.from({ length: irrelevantCount }, (_, i) =>
  fs.writeFile(path.join(irrelevantRoot, `unrelated-${i}.wav`), Buffer.alloc(1024 + i, i % 255))))

const records = Array.from({ length: count }, (_, i) => ({
  id: `performance-${i}`, title: `Instrumental group${i % 40} beat ${i}`, producer: `Producer ${i % 17}`,
  bpm: 80 + i % 101, altBpm: null, key: i % 2 ? 'A minor' : 'C major', camelot: i % 2 ? '8A' : '8B', detune: null,
  presetId: 'original', format: 'wav', filePath: path.join(fixtureRoot, 'old', `audio-${i}.wav`), fileName: `audio-${i}.wav`,
  fileOwnership: 'external', sidecarPath: null, sizeBytes: candidateBytes, durationSec: 95, bitrateKbps: 1411,
  sampleRate: 44100, channels: 2, sourceUrl: null, sourceChannel: 'Benchmark source', thumbnail: null,
  sourceKind: 'local', addedAt: 1_790_000_000_000 - i, fingerprint: fingerprints[i] ?? digest(`absent-${i}`),
  missing: true, analysisStatus: 'not-analyzed', analysis: null, overrides: [],
  sources: { title: {}, description: {}, filename: {} }, embedded: {}, verification: null
}))
const recordsById = new Map(records.map(record => [record.id, record]))
const initialRecords = digest(JSON.stringify(records))
const shared = compileSource('src/shared/recovery.ts')
const identity = compileSource('src/main/lib/fileIdentity.ts', {
  'node:crypto': { createHash: (...args) => {
    const hash = createHash(...args)
    const update = hash.update.bind(hash)
    const current = telemetry
    hash.update = (chunk, ...rest) => {
      const result = update(chunk, ...rest)
      if (current) current.bytesReadIntoHashes += chunk.byteLength
      onHashChunk?.()
      return result
    }
    return hash
  } }, 'node:fs/promises': fs, 'node:path': { default: path }
})
const { recoveryRecordKey } = compileSource('src/main/services/library.ts', {}, 'recoveryRecordKey')
const music = compileSource('src/shared/music.ts')
const { createLibraryIndex, searchLibrary } = compileSource('src/renderer/src/features/library/librarySearch.ts', {
  minisearch: { default: require('minisearch') }, '@shared/music': music
})
const index = createLibraryIndex(records)
const options = { query: '', sort: 'newest', bands: new Set(), formats: new Set(), fileFilter: 'all', reviewFilter: 'all',
  bpm: '', bpmTolerance: 3, includeHalfDouble: false, key: '' }
const queryOptions = [
  { query: 'group7', sort: 'relevance' }, { bpm: '140', includeHalfDouble: true },
  { query: 'group19', sort: 'title' }, { key: '8A', sort: 'bpm-asc' },
  { query: 'group31', sort: 'newest' }, { query: '', sort: 'newest' },
  { query: 'group2', fileFilter: 'missing' }, { query: 'group24', sort: 'producer' }
].map(patch => ({ ...options, ...patch }))
const expectedQueryResults = queryOptions.map(option => searchLibrary(records, index, option).map(record => record.id))
// Warm only the search implementation; candidate verification still uses real I/O.
for (let i = 0; i < 32; i++) searchLibrary(records, index, queryOptions[i % queryOptions.length])

const countedFs = { ...fs, lstat: async (...args) => {
  if (telemetry) telemetry.scanLstatCalls++
  return fs.lstat(...args)
}, readdir: async (...args) => {
  if (telemetry) telemetry.readdirCalls++
  return fs.readdir(...args)
}, opendir: async (...args) => {
  if (telemetry) telemetry.opendirCalls++
  return fs.opendir(...args)
} }
const countedIdentity = { ...identity, verifyFile: async (...args) => {
  const current = telemetry
  const started = performance.now()
  if (current) {
    current.hashAttempts++
    current.activeHashes++
    current.maxActiveHashes = Math.max(current.maxActiveHashes, current.activeHashes)
    current.attemptedPaths.push(path.relative(pickedRoot, args[0]))
  }
  try {
    const result = await identity.verifyFile(...args)
    if (current) { current.hashCompleted++; current.verifiedBytes += result.sizeBytes }
    return result
  } finally {
    if (current) { current.activeHashes--; current.hashDurationsMs.push(performance.now() - started) }
  }
} }
const { RecoveryService } = compileSource('src/main/services/recovery.ts', {
  'node:crypto': require('node:crypto'), 'node:fs/promises': countedFs, 'node:path': { default: path },
  '@shared/recovery': shared, '../lib/fileIdentity': countedIdentity, '../lifecycle': { isStopping: () => false },
  './library': { recoveryRecordKey, libraryService: { get: id => recordsById.get(id), list: () => records,
    pendingRevision: () => null } }
})
const freshTelemetry = () => ({ scanLstatCalls: 0, readdirCalls: 0, opendirCalls: 0, hashAttempts: 0, hashCompleted: 0,
  activeHashes: 0, maxActiveHashes: 0, bytesReadIntoHashes: 0, verifiedBytes: 0, hashDurationsMs: [], attemptedPaths: [] })

async function exercise(label, selectedIds = null) {
  const service = new RecoveryService()
  const stats = freshTelemetry()
  telemetry = stats
  let planId = null
  let phase = selectedIds ? 'scanning' : 'idle'
  let latest = null
  const queries = [], callbacks = [], progress = []
  const started = performance.now()
  let lastCallback = started
  let scanFinishedAt = null
  let beginSyncMs = null
  let firstCallbackMs = null
  const callback = setInterval(() => {
    const now = performance.now()
    if (firstCallbackMs === null) firstCallbackMs = now - started
    callbacks.push({ atMs: now - started, gapMs: now - lastCallback,
      delayMs: Math.max(0, now - lastCallback - progressPeriodMs), phase })
    lastCallback = now
    if (!planId || phase !== 'scanning') return
    const snapshotStart = performance.now()
    latest = service.status(planId, owner)
    const snapshotMs = performance.now() - snapshotStart
    const serialized = JSON.stringify(latest)
    progress.push({ atMs: now - started, phase: latest.phase, snapshotMs, items: latest.items.length,
      bytes: Buffer.byteLength(serialized), visited: latest.stats.visited, hashed: latest.stats.hashed,
      hashedBytes: latest.stats.hashedBytes })
    phase = latest.phase
    if (phase !== 'scanning') scanFinishedAt = performance.now() - started
  }, progressPeriodMs)
  try {
    if (selectedIds) {
      const begin = performance.now()
      planId = service.begin(owner, selectedIds, pickedRoot, 'folder')
      beginSyncMs = performance.now() - begin
    }
    for (let i = 0; i < queryCount; i++) {
      await delay(queryPeriodMs)
      const before = performance.now()
      const duringPhase = phase
      const results = searchLibrary(records, index, queryOptions[i % queryOptions.length])
      const elapsed = performance.now() - before
      assert.deepEqual(results.map(record => record.id), expectedQueryResults[i % queryOptions.length], `${label}: query ${i}`)
      queries.push({ sequence: i, query: i % queryOptions.length, atMs: before - started, elapsedMs: elapsed,
        phase: duringPhase, resultCount: results.length })
    }
    while (selectedIds && phase === 'scanning') {
      assert.ok(performance.now() - started < 60_000, `${label}: scan exceeded benchmark timeout`)
      await delay(progressPeriodMs)
    }
    if (selectedIds) {
      assert.equal(latest.phase, 'ready')
      assert.deepEqual(latest.errors, [])
      assert.equal(latest.items.length, selectedIds.length)
      assert.equal(latest.items.filter(item => item.status === 'matched').length, candidateCount)
      assert.equal(latest.stats.hashed, candidateCount)
      assert.equal(latest.stats.hashedBytes, candidateBytes * candidateCount)
      assert.equal(latest.stats.visited, candidateCount + irrelevantCount + 2)
      assert.equal(stats.hashCompleted, candidateCount)
      assert.equal(stats.bytesReadIntoHashes, candidateCount * candidateBytes)
      assert.ok(stats.maxActiveHashes <= shared.RECOVERY_LIMITS.hashConcurrency)
      assert.ok(progress.filter(item => item.phase === 'scanning').every(item => item.items === 0))
      assert.ok(stats.attemptedPaths.every(file => file.startsWith(`moved${path.sep}`)))
    }
  } finally {
    clearInterval(callback)
    await service.shutdown()
    telemetry = null
  }
  return { label, requestedRecords: selectedIds?.length ?? 0, wallMs: round(performance.now() - started), beginSyncMs,
    firstCallbackMs, scanFinishedAt, queries, callbacks, progress, io: stats,
    final: latest && { phase: latest.phase, stats: latest.stats, matched: latest.items.filter(item => item.status === 'matched').length,
      unmatched: latest.items.filter(item => item.status === 'not-found').length, completeSearch: latest.completeSearch } }
}

function compare(baseline, during, after) {
  const overlapped = during.queries.filter(sample => sample.phase === 'scanning')
  assert.ok(overlapped.length >= 2, 'Too few overlapping query callbacks; increase candidate byte size for this machine')
  const sequence = new Set(overlapped.map(sample => sample.sequence))
  const baselineQueries = baseline.queries.filter(sample => sequence.has(sample.sequence))
  const activeCallbacks = during.callbacks.filter(sample => sample.phase === 'scanning')
  const pairedCallbackCount = Math.min(baseline.callbacks.length, activeCallbacks.length)
  const baselineCallbacks = baseline.callbacks.slice(0, pairedCallbackCount)
  const pairedScanCallbacks = activeCallbacks.slice(0, pairedCallbackCount)
  const scanProgress = during.progress.filter(sample => sample.phase === 'scanning')
  return { pairedQuerySequences: [...sequence], baselineQueryMs: summary(baselineQueries.map(sample => sample.elapsedMs)),
    duringScanQueryMs: summary(overlapped.map(sample => sample.elapsedMs)),
    afterScanQueryMs: summary(after.queries.filter(sample => sequence.has(sample.sequence)).map(sample => sample.elapsedMs)),
    baselineCallbackDelayMs: summary(baselineCallbacks.map(sample => sample.delayMs)),
    duringScanCallbackDelayMs: summary(pairedScanCallbacks.map(sample => sample.delayMs)),
    allActiveCallbackDelayMs: summary(activeCallbacks.map(sample => sample.delayMs)),
    progressSnapshotMs: summary(scanProgress.map(sample => sample.snapshotMs)),
    progressSerializedBytes: summary(scanProgress.map(sample => sample.bytes)),
    readySnapshot: during.progress.find(sample => sample.phase === 'ready'),
    beginSyncMs: round(during.beginSyncMs), firstCallbackMs: round(during.firstCallbackMs),
    scanFinishedMs: round(during.scanFinishedAt), io: { ...during.io, hashDurationsMs: summary(during.io.hashDurationsMs) } }
}

const trials = []
for (const selectedCount of [candidateCount, count]) {
  const baseline = await exercise(`before-${selectedCount}`)
  const during = await exercise(`scan-${selectedCount}`, records.slice(0, selectedCount).map(record => record.id))
  const after = await exercise(`after-${selectedCount}`)
  const result = { selectedCount, baseline, during, after, comparison: compare(baseline, during, after) }
  trials.push(result)
  console.log(JSON.stringify({ selectedCount, ...result.comparison, io: { ...result.comparison.io, attemptedPaths: undefined } }))
}

// Cancel after the first real chunk has entered SHA-256; do not slow or
// replace the filesystem. This isolates cancellation from 10k review-copy cost.
async function cancelDuringHash() {
  const service = new RecoveryService()
  telemetry = freshTelemetry()
  const stats = telemetry
  let resolveStarted
  const hashingStarted = new Promise(resolve => { resolveStarted = resolve })
  onHashChunk = resolveStarted
  const planId = service.begin(owner, records.slice(0, candidateCount).map(record => record.id), pickedRoot, 'folder')
  let timeout
  try {
    await Promise.race([hashingStarted, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Cancellation fixture never started hashing')), 10_000)
    })])
  } finally { clearTimeout(timeout) }
  onHashChunk = null
  const before = service.status(planId, owner)
  assert.equal(before.phase, 'scanning')
  const activeWhenRequested = stats.activeHashes
  const bytesReadWhenRequested = stats.bytesReadIntoHashes
  assert.ok(bytesReadWhenRequested > 0)
  const start = performance.now()
  const cancelled = await service.cancel(planId, owner)
  const cancellationMs = performance.now() - start
  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(cancelled.committedIds.length, 0)
  const activeWhenCancelSettled = stats.activeHashes
  assert.ok(stats.hashAttempts < candidateCount)
  const attemptsAtCompletion = stats.hashAttempts
  await delay(40)
  assert.equal(stats.hashAttempts, attemptsAtCompletion, 'hash work continued after cancellation settled')
  await service.shutdown()
  telemetry = null
  return { cancellationMs: round(cancellationMs), activeWhenRequested, activeWhenCancelSettled, bytesReadWhenRequested,
    before: before.stats, after: cancelled.stats, io: stats,
    noHashesAfterCancelSettled: true, libraryUnchanged: digest(JSON.stringify(records)) === initialRecords }
}
const cancellation = await cancelDuringHash()
assert.equal(digest(JSON.stringify(records)), initialRecords, 'Preview/cancel mutated the fixture library')
const report = {
  recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
  cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemoryBytes: os.totalmem(),
  fixture: { libraryRecords: count, candidateCount, candidateBytes, totalCandidateBytes: candidateCount * candidateBytes,
    irrelevantFiles: irrelevantCount, candidateRoot, selectedRoot: pickedRoot, allRecordsMissing: true,
    sourceBytesAreSynthetic: true, filesRetainedForInspection: true },
  methodology: [
    'Checked-in RecoveryService, fileIdentity and library search run via TypeScript transpilation and VM. Candidate reads, metadata checks and SHA-256 hashes use the real local filesystem.',
    'LibraryService get/list/pendingRevision are in-memory doubles; recoveryRecordKey is extracted from its checked-in function. No save, apply, persistence, Electron IPC, React render or audio playback is measured.',
    'The same 64 queries and 16ms callback schedule run before, during and after each scan. Paired query timings select the identical sequence indices that overlapped scanning. Timer comparisons use equal counts of initial baseline/scan callbacks; all scan callback delays are reported separately, including time after the fixed query sequence finishes.',
    'Search and hashing share one Node event loop in this experiment. The application normally separates renderer search from main-process recovery; these are service/scheduler measurements, not whole-application responsiveness.',
    'Two request sizes (24 and 10,000) share the same 10,000-record library and 24 moved files. The other 9,976 saved paths are intentionally absent. Every candidate is 8 MiB; 512 unrelated-size files verify hash prefiltering.',
    'Generated files and repeated passes may be warm in the OS cache. Timings are one paired run per request size, not statistically stable cold-disk throughput.',
    'Progress bytes are UTF-8 JSON sizes, a transport-size proxy, not measured Electron IPC bytes. hashedBytes is the service attempt budget; bytesReadIntoHashes counts bytes passed to real SHA-256 updates; verifiedBytes counts successfully completed real hashes.',
    'scanLstatCalls counts only RecoveryService lstat calls. Additional file identity lstat/realpath/open/stat calls execute normally but are not included in that counter.',
    'The historical baseline had no recovery service; before/after means pre-scan/post-scan activity on the same current implementation, not an old-versus-new recovery speedup.'
  ],
  loadedSources: loadedSources.map(source => ({ ...source,
    unchangedAtFinish: digest(readFileSync(path.join(workspace, source.path), 'utf8')) === source.sha256 })),
  trials, cancellation, libraryUnchanged: digest(JSON.stringify(records)) === initialRecords
}
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
const textRows = trials.map(({ selectedCount, comparison: result }) => `| ${selectedCount.toLocaleString()} | ${result.beginSyncMs} | ${result.scanFinishedMs} | ${result.baselineQueryMs.p95} / ${result.duringScanQueryMs.p95} | ${result.baselineCallbackDelayMs.p95} / ${result.duringScanCallbackDelayMs.p95} | ${result.progressSerializedBytes.max} |`)
await fs.writeFile(path.join(output, 'SUMMARY.md'), `# Recovery service performance experiment\n\nRecorded ${report.recordedAt}. Reproduce with \`node tests/recovery-performance.mjs\`.\n\n10,000 in-memory library records; 24 real moved 8 MiB files (192 MiB); 512 irrelevant-size files. Both scans verified exactly 24 candidates and visited 538 entries. ${shared.RECOVERY_LIMITS.hashConcurrency} simultaneous hashes maximum.\n\n| Selected records | Begin, ms | Scan observed done, ms | Query p95 before / during, ms | Callback delay p95 before / during, ms | Maximum scanning JSON bytes |\n| --- | --- | --- | --- | --- | --- |\n${textRows.join('\n')}\n\nCancellation settled in ${cancellation.cancellationMs} ms with ${cancellation.activeWhenRequested} active verifications. No new hashes started after cancellation settled; preview and cancellation did not change records.\n\n${report.methodology.map(item => `- ${item}`).join('\n')}\n\nFull samples, loaded source hashes, final ready-snapshot cost and cancellation counters are in \`report.json\`. These figures do not establish Electron UI responsiveness or a historical application speedup.\n`)
console.log(JSON.stringify({ output, cancellation, libraryUnchanged: report.libraryUnchanged }))
assert.equal(cancellation.activeWhenCancelSettled, 0, 'Cancel resolved before all verification workers settled; report retained')
