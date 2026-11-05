import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  nextReleaseVersion,
  releaseCommitSubject,
  resolveReleaseVersion
} from '../scripts/release-version.mjs'

test('the first release uses the version declared in package.json', () => {
  assert.equal(nextReleaseVersion('2.0.0', []), '2.0.0')
  assert.deepEqual(
    resolveReleaseVersion({ packageVersion: '2.0.0', head: 'abc', refs: [] }),
    { version: '2.0.0', mode: 'new' }
  )
})

test('a commit already tagged at its package.json version is reused', () => {
  const result = resolveReleaseVersion({
    packageVersion: '2.0.0',
    head: 'abc',
    refs: [{ tag: 'v2.0.0', commit: 'abc', parent: 'zzz', subject: 'Ship Sonic' }]
  })
  assert.deepEqual(result, { version: '2.0.0', mode: 'reuse' })
})

test('a later push of the same package version takes the next patch', () => {
  const result = resolveReleaseVersion({
    packageVersion: '2.0.0',
    head: 'abc',
    refs: [{ tag: 'v2.0.0', commit: 'old', parent: 'older', subject: 'Ship Sonic' }]
  })
  assert.deepEqual(result, { version: '2.0.1', mode: 'new' })
})

test('re-running a push reuses the release commit created for it', () => {
  const result = resolveReleaseVersion({
    packageVersion: '2.0.0',
    head: 'abc',
    refs: [{
      tag: 'v2.0.1',
      commit: 'def',
      parent: 'abc',
      subject: releaseCommitSubject('2.0.1')
    }]
  })
  assert.deepEqual(result, { version: '2.0.1', mode: 'reuse' })
})

test('the highest release commit for this push wins', () => {
  const result = resolveReleaseVersion({
    packageVersion: '2.0.0',
    head: 'abc',
    refs: [
      { tag: 'v2.0.1', commit: 'c1', parent: 'abc', subject: releaseCommitSubject('2.0.1') },
      { tag: 'v2.0.2', commit: 'c2', parent: 'abc', subject: releaseCommitSubject('2.0.2') }
    ]
  })
  assert.deepEqual(result, { version: '2.0.2', mode: 'reuse' })
})

test('an unrelated tag on a child commit does not block the next patch', () => {
  const result = resolveReleaseVersion({
    packageVersion: '2.0.0',
    head: 'abc',
    refs: [{ tag: 'v2.0.1', commit: 'c1', parent: 'abc', subject: 'not a release' }]
  })
  assert.deepEqual(result, { version: '2.0.2', mode: 'new' })
})

test('raising package.json above every tag is an intentional version', () => {
  const result = resolveReleaseVersion({
    packageVersion: '2.1.0',
    head: 'abc',
    refs: [{ tag: 'v2.0.4', commit: 'old', parent: 'older', subject: releaseCommitSubject('2.0.4') }]
  })
  assert.deepEqual(result, { version: '2.1.0', mode: 'new' })
})

test('package.json behind the latest tag continues from that tag', () => {
  assert.equal(nextReleaseVersion('2.0.0', ['v2.0.4']), '2.0.5')
})

test('patch order is numeric', () => {
  assert.equal(nextReleaseVersion('2.0.0', ['v2.0.9', 'v2.0.10']), '2.0.11')
})

test('tags that are not major.minor.patch are ignored', () => {
  assert.equal(nextReleaseVersion('2.0.0', ['latest', 'v2.0.0-beta.1', 'v2.0']), '2.0.0')
})

test('a version that is not major.minor.patch is rejected', () => {
  assert.throws(() => nextReleaseVersion('2.0', []), /major\.minor\.patch/)
})

test('the release commit subject is the marker the workflow pushes', () => {
  assert.equal(releaseCommitSubject('2.0.1'), 'chore: release v2.0.1 [skip ci]')
})
