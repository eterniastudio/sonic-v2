import test from 'node:test'
import assert from 'node:assert/strict'
import { establishAnchors, selectOwnedProcesses, sameProcess, youngestFirst } from './process-ownership.mjs'
const profile = 'C:\\test\\unique-profile'
const process = (pid, parent, born, command = 'owned child') => ({ ProcessId: pid, ParentProcessId: parent, CreationTicks: String(born), CommandLine: command })
const launcher = process(10, 1, 100, `cmd --user-data-dir=${profile}`)
const main = process(11, 10, 110, `electron --user-data-dir=${profile}`)
const anchors = establishAnchors([launcher, main], { mainPid: 11, launcherPid: 10, profile, launchedAfter: '99' })
test('old unrelated child of reused launcher PID is excluded, including its descendants', () => {
  const old = process(20, 10, 50, 'DiscordSystemHelper')
  const child = process(21, 20, 120, 'unrelated helper')
  assert.deepEqual(selectOwnedProcesses([launcher, main, old, child], anchors).map(p => p.ProcessId), [10, 11])
})
test('child born before actual parent and null commandline are excluded', () => {
  assert.deepEqual(selectOwnedProcesses([launcher, main, process(20, 11, 109), process(21, 11, 120, null)], anchors).map(p => p.ProcessId), [10, 11])
})
test('replaced anchored PID and new descendants cannot inherit ownership', () => {
  const replacement = process(11, 99, 200, 'unrelated')
  assert.equal(sameProcess(main, replacement), false)
  assert.deepEqual(selectOwnedProcesses([replacement, process(20, 11, 210)], anchors), [])
})
test('owned valid child remains identifiable after parent exits, but its replacement does not', () => {
  const child = process(20, 11, 120)
  const known = selectOwnedProcesses([launcher, main, child], anchors)
  assert.deepEqual(selectOwnedProcesses([child], anchors, known), [child])
  assert.deepEqual(selectOwnedProcesses([process(20, 99, 300)], anchors, known), [])
})
test('profile anchors and creation time are mandatory', () => {
  for (const malformed of [process(11, 10, 110, null), process(11, 10, 110, 'unrelated'), process(11, 10, 90, `electron --user-data-dir=${profile}`)]) {
    assert.throws(() => establishAnchors([launcher, malformed], { mainPid: 11, launcherPid: 10, profile, launchedAfter: '99' }))
  }
})
test('profile in another argument or longer profile name cannot establish an anchor', () => {
  for (const command of [`electron --user-data-dir=C:\\other "${profile}"`, `electron --user-data-dir=${profile}-other`]) {
    assert.throws(() => establishAnchors([launcher, process(11, 10, 110, command)], { mainPid: 11, launcherPid: 10, profile, launchedAfter: '99' }))
  }
  for (const command of [`electron "--user-data-dir=${profile}"`, `electron --user-data-dir="${profile}"`]) {
    assert.equal(establishAnchors([launcher, process(11, 10, 110, command)], { mainPid: 11, launcherPid: 10, profile, launchedAfter: '99' }).length, 2)
  }
})
test('cleanup order is youngest first and unknown creation times never compare equal', () => {
  assert.deepEqual(youngestFirst([launcher, main, process(20, 11, 120)]).map(p => p.ProcessId), [20, 11, 10])
  assert.equal(sameProcess({ ProcessId: 1 }, { ProcessId: 1 }), false)
})
