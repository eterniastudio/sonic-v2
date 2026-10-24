import { _electron as electron, expect } from '@playwright/test'
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { establishAnchors, selectOwnedProcesses, sameProcess, youngestFirst } from './process-ownership.mjs'
import { launchCdpApp } from './cdp-app.mjs'

const exec = promisify(execFile)
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const states = new WeakMap()
const processHandles = path.resolve('scripts/test-process-handles.ps1')
export const isolatedEnv = { ...process.env, PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0' }
delete isolatedEnv.ELECTRON_RUN_AS_NODE
// Windows environment variable names are case insensitive: avoid two PATHs.
for (const name of Object.keys(isolatedEnv)) if (name.toLowerCase() === 'path' && name !== 'PATH') delete isolatedEnv[name]

export async function createOwnedProfile(info) {
  const id = randomUUID()
  const root = path.join(os.tmpdir(), 'SonicV2-owned-tests', id)
  await mkdir(root, { recursive: true })
  const ownership = { id, profile: root, test: info.title, repeat: info.repeatEachIndex, retry: info.retry, runnerPid: process.pid, createdAt: new Date().toISOString(), cleanup: 'Retained; never recycled or deleted by this harness.' }
  await writeFile(path.join(root, 'test-owner.json'), JSON.stringify(ownership, null, 2))
  await writeFile(info.outputPath('profile-ownership.json'), JSON.stringify(ownership, null, 2))
  return root
}

async function processTable() {
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-File', processHandles, '-Mode', 'Snapshot'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })
  // Unrelated processes can carry raw control characters in their command lines,
  // which ConvertTo-Json leaves unescaped; they are never part of what we match.
  return JSON.parse((stdout || '[]').replace(/[\u0000-\u001f]/g, ' '))
}

async function record(state, event, data = {}) {
  state.writes = state.writes.then(() => appendFile(state.log, JSON.stringify({ at: new Date().toISOString(), event, pid: state.pid, ...data }) + '\n'))
  await state.writes
}

export async function captureOwnedProcesses(app) {
  const state = states.get(app)
  const found = selectOwnedProcesses(await processTable(), state.anchors, state.owned)
  for (const entry of found) if (!state.owned.some(old => sameProcess(old, entry))) state.owned.push(entry)
  await record(state, 'process-snapshot', { processes: found })
  return found
}

export async function launchOwnedApp(root, info) {
  const executablePath = process.env.SONIC_PACKAGED_EXE
  const launchedAfter = ((BigInt(Date.now()) + 11644473600000n) * 10000n).toString()
  const options = { ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ['.']), `--user-data-dir=${root}`], env: isolatedEnv }
  let app, launchError
  try {
    app = process.env.SONIC_TEST_TRANSPORT === 'cdp' ? await launchCdpApp(options) : await electron.launch(options)
  } catch (error) {
    if (!error.launchedApp) throw error
    app = error.launchedApp
    launchError = error
  }
  const child = app.process()
  const log = path.join(root, `app-${child.pid}-lifecycle.jsonl`)
  const state = { pid: child.pid, launcherPid: child.pid, child, root, log, anchors: [], owned: [], writes: Promise.resolve(), closed: false, stdout: app.initialStdout || '', stderr: app.initialStderr || '', transport: app.transport || 'electron-inspector' }
  states.set(app, state)
  child.stdout?.on('data', data => { state.stdout += data.toString() })
  child.stderr?.on('data', data => { state.stderr += data.toString() })
  try {
    state.pid = app.mainPid || await app.evaluate(() => process.pid)
    state.anchors = establishAnchors(await processTable(), { mainPid: state.pid, launcherPid: child.pid, profile: root, launchedAfter })
    await record(state, 'launched', { actualMainPid: state.pid, launcherPid: child.pid, anchors: state.anchors, transport: state.transport, executable: executablePath || 'development Electron', args: child.spawnargs, profile: root })
    const tree = await captureOwnedProcesses(app)
    expect(tree.some(entry => entry.ProcessId === state.pid && entry.CommandLine?.includes(root))).toBe(true)
    await writeFile(info.outputPath(`app-${state.pid}-ownership.json`), JSON.stringify({ actualMainPid: state.pid, launcherPid: child.pid, anchors: state.anchors, transport: state.transport, root, log, executable: executablePath || 'development Electron' }, null, 2))
    if (launchError) throw launchError
  } catch (error) {
    await record(state, 'launch-verification-failed', { error: String(error) })
    await closeOwnedApp(app, await app.firstWindow().catch(() => null), info, { timeoutMs: launchError ? 1 : 30000 }).catch(() => {})
    throw error
  }
  return app
}

export async function readyPage(app, root) {
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await expect(page.getByTitle('Default export format', { exact: true })).toBeVisible()
  if (process.env.SONIC_TEST_HIDDEN === '1' && !process.env.SONIC_PACKAGED_EXE && app.evaluate) {
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true)
  }
  const info = await page.evaluate(() => window.sonic.invoke('app:info'))
  expect(path.resolve(info.userDataDir)).toBe(path.resolve(root))
  const engine = await page.evaluate(() => window.sonic.invoke('engine:status'))
  for (const name of ['ffmpeg', 'ffprobe']) {
    const tool = engine.components.find(component => component.name === name)
    expect(tool.available).toBe(true)
    expect(tool.origin).toBe('managed')
    expect(path.resolve(tool.path)).toBe(path.resolve(root, 'engine', `${name}.exe`))
    expect(tool.version).toBeTruthy()
  }
  return page
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { child.off('exit', done); reject(new Error(`Normal close exceeded ${timeoutMs}ms; PID ${child.pid} is still alive.`)) }, timeoutMs)
    child.once('exit', done)
  })
}

async function terminateVerified(state, entries, event) {
  for (const owned of youngestFirst(entries)) {
    const fresh = await processTable()
    if (!fresh.some(current => sameProcess(owned, current))) continue
    // The helper opens one kernel handle, compares its exact creation FILETIME,
    // then terminates that same handle. Never taskkill /T or PID-only killing.
    const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-File', processHandles, '-Mode', 'Terminate', '-TargetPid', String(owned.ProcessId), '-ExpectedCreationTicks', owned.CreationTicks], { windowsHide: true, timeout: 10000 })
    await record(state, event, JSON.parse(stdout))
  }
}

async function disconnectAfterExit(app, state) {
  if (!app.disconnect || state.child.exitCode === null && state.child.signalCode === null) return
  const table = await processTable()
  if (!state.owned.some(known => table.some(current => sameProcess(known, current)))) await app.disconnect()
}

/** Native/renderer close plus OS exit is the test; forced cleanup always fails it. */
export async function closeOwnedApp(app, page, info, { request = true, repeated = false, capture = true, timeoutMs = 30000 } = {}) {
  if (!app) return
  const state = states.get(app)
  if (!state || state.closed) return
  let failure
  try {
    if (capture) await captureOwnedProcesses(app)
    await record(state, 'close-request', { request, repeated })
    if (request && state.child.exitCode === null && state.child.signalCode === null && page && !page.isClosed()) {
      // Do not use ElectronApplication.close(): its inspector app.quit call
      // does not exercise the renderer/native close route.
      const closing = page.evaluate(count => {
        for (let index = 0; index < count; index++) void window.sonic.invoke('window:close').catch(() => {})
      }, repeated ? 3 : 1)
      // A native exception dialog can block this promise. Process exit below
      // has its own deadline, so an unresponsive renderer cannot bypass it.
      void closing.catch(error => { void record(state, 'close-ipc-result', { error: String(error) }) })
    }
    await waitForExit(state.child, timeoutMs)
    if (state.child.exitCode !== 0) throw new Error(`Application exited with code ${state.child.exitCode}, signal ${state.child.signalCode}.`)
    const deadline = Date.now() + 5000
    let survivors
    do {
      const table = await processTable()
      survivors = state.owned.filter(owned => table.some(current => sameProcess(owned, current)))
      if (!survivors.length) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    if (survivors.length) throw new Error(`Owned processes survived normal close: ${survivors.map(entry => entry.ProcessId).join(', ')}`)
    if (/Uncaught Exception|A JavaScript error occurred in the main process/.test(state.stderr)) throw new Error('Main-process exception was recorded during normal close.')
    await record(state, 'normal-close-passed', { exitCode: state.child.exitCode, survivingOwnedProcesses: 0 })
  } catch (error) {
    failure = error
    const table = await processTable()
    const currentOwned = state.owned.filter(owned => table.some(current => sameProcess(owned, current)))
    await record(state, 'normal-close-failed', { error: String(error), survivors: currentOwned })
    // Only verified identities from this test's process tree are cleanup targets.
    // Profiles and failed artifacts are retained regardless of termination.
    await terminateVerified(state, currentOwned, 'forced-cleanup-failure')
  } finally {
    state.closed = true
    await writeFile(path.join(state.root, `app-${state.pid}-stdout.log`), state.stdout)
    await writeFile(path.join(state.root, `app-${state.pid}-stderr.log`), state.stderr)
    await writeFile(info.outputPath(`app-${state.pid}-lifecycle.jsonl`), await readFile(state.log))
    await disconnectAfterExit(app, state)
  }
  if (failure) throw failure
}

/** Intentional crash simulation has a distinct event and never counts as close. */
export async function crashOwnedApp(app, info) {
  const state = states.get(app)
  if (!state || state.closed) throw new Error('Cannot crash an unowned or already closed application.')
  const owner = JSON.parse(await readFile(path.join(state.root, 'test-owner.json'), 'utf8'))
  if (owner.profile !== state.root) throw new Error('Test profile ownership does not match.')
  const table = await captureOwnedProcesses(app)
  const ownMain = state.owned.find(entry => entry.ProcessId === state.pid)
  if (!ownMain || !table.some(entry => sameProcess(entry, ownMain))) throw new Error('Owned main process identity changed before crash simulation.')
  await record(state, 'intentional-crash-simulation', { boundary: 'Only IPC-acknowledged changes are asserted after recovery. This is not a passing normal-close test.' })
  await terminateVerified(state, table, 'intentional-crash-process-terminated')
  await waitForExit(state.child, 10000)
  const remaining = await processTable()
  const survivors = state.owned.filter(owned => remaining.some(current => sameProcess(owned, current)))
  await record(state, 'intentional-crash-terminated', { exitCode: state.child.exitCode, survivors })
  state.closed = true
  await writeFile(path.join(state.root, `app-${state.pid}-stdout.log`), state.stdout)
  await writeFile(path.join(state.root, `app-${state.pid}-stderr.log`), state.stderr)
  await writeFile(info.outputPath(`app-${state.pid}-lifecycle.jsonl`), await readFile(state.log))
  if (survivors.length) throw new Error(`Crash simulation left owned children: ${survivors.map(entry => entry.ProcessId).join(', ')}`)
  await disconnectAfterExit(app, state)
}
