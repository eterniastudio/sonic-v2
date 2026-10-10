import { copyFile, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fixtures } from './fixtures.mjs'

export const recoveryHash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function physicalIdentity(filePath) {
  const info = await lstat(filePath, { bigint: true })
  return { device: String(info.dev), inode: String(info.ino), born: String(info.birthtimeNs) }
}

function artwork(index) {
  const color = ['#755bf2', '#e69b45', '#4aaf92', '#588dd9'][index % 4]
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><circle cx="32" cy="32" r="14" fill="#fff"/></svg>`)}`
}

function analysis(beat) {
  return {
    engine: 'sonic-dsp/2', inputId: `${beat.fingerprint}:${beat.sizeBytes}`,
    inputName: beat.fileName, analyzedAt: 1_790_000_000_000, analyzedSeconds: 12,
    sampleRate: 22050, channels: 1, durationSec: beat.durationSec,
    tempo: { status: 'estimated', bpm: 120, bpmExact: 120.1, alternatives: [{ bpm: 60, relation: 'half', strength: 0.7 }], confidence: 0.9, warning: null },
    key: { status: 'estimated', key: 'A minor', camelot: '8A', alternatives: [], correlation: 0.9, confidence: 0.8, tuningCents: 1.2, warning: null },
    warnings: ['Stored recovery fixture evidence; not a new acoustic analysis.']
  }
}

/** Test-runner-only fixtures. No renderer path admission or application backdoor. */
export async function recoveryFixtures(root, { manyCount = 0 } = {}) {
  const beats = await fixtures(root, 60, { sidecars: true })
  const definitions = [
    { title: 'YouTube shortlist', sourceKind: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', sourceChannel: 'Offline YouTube channel', fileOwnership: 'sonic-export' },
    { title: 'SoundCloud folder mix', sourceKind: 'soundcloud', sourceUrl: 'https://soundcloud.com/offline-fixture/folder-mix', sourceChannel: 'Offline SoundCloud uploader', fileOwnership: 'sonic-export' },
    { title: 'Imported original', sourceKind: 'local', sourceUrl: null, sourceChannel: null, fileOwnership: 'external' },
    { title: 'Unrelated audition', sourceKind: 'unknown', sourceUrl: null, sourceChannel: null, fileOwnership: 'sonic-export' }
  ]
  const externalDir = path.join(root, 'external-originals')
  await mkdir(externalDir, { recursive: true })
  for (const [index, beat] of beats.entries()) {
    Object.assign(beat, definitions[index], { producer: 'Saved producer', bpm: 136, altBpm: 68,
      key: 'F# minor', camelot: '11A', detune: 2, overrides: ['bpm', 'key'],
      sources: { title: { bpm: 130, key: 'A minor' }, description: { producer: 'Original source credit' }, filename: {} },
      embedded: { bpm: 128, key: 'C major' }, publishedTags: { bpm: 128, key: 'C major' },
      thumbnail: artwork(index), namingTemplate: '{title} [{bpm} BPM] [{key}]', namingIndex: index,
      analysisStatus: 'estimated' })
    beat.analysis = analysis(beat)
    if (beat.fileOwnership === 'external') {
      const originalPath = path.join(externalDir, beat.fileName)
      await rename(beat.filePath, originalPath)
      beat.filePath = originalPath
      beat.sidecarPath = null
      delete beat.sidecarSync
    } else {
      const sidecar = JSON.parse(await readFile(beat.sidecarPath, 'utf8'))
      Object.assign(sidecar.source, { kind: beat.sourceKind, url: beat.sourceUrl, channel: beat.sourceChannel, thumbnail: beat.thumbnail, title: beat.title })
      Object.assign(sidecar.metadata, { title: beat.title, producer: beat.producer, bpm: beat.bpm, altBpm: beat.altBpm,
        key: beat.key, camelot: beat.camelot, detune: beat.detune })
      Object.assign(sidecar, { analysis: beat.analysis, overrides: beat.overrides, sources: beat.sources, embedded: beat.embedded })
      await writeFile(beat.sidecarPath, JSON.stringify(sidecar, null, 2))
      beat.sidecarSync = { status: 'synced', error: null }
      // The fourth export is intentionally legacy: bytes identify content, but
      // no creation receipt exists to grant ownership of a replacement.
      if (index < 2) beat.ownershipEvidence = {
        audio: await physicalIdentity(beat.filePath),
        sidecar: { id: sidecar.id, file: await physicalIdentity(beat.sidecarPath) }
      }
    }
  }

  const template = await readFile(beats[0].filePath)
  for (let index = 0; index < manyCount; index++) {
    const id = `recovery-many-${String(index).padStart(2, '0')}`
    const fileName = `Recovery candidate ${String(index).padStart(2, '0')} with a deliberately long descriptive audio filename.wav`
    const filePath = path.join(externalDir, fileName)
    const bytes = Buffer.from(template)
    bytes.writeInt16LE(1000 + index, 44)
    await writeFile(filePath, bytes)
    const beat = { ...structuredClone(beats[2]), id, title: `Recovery candidate ${String(index).padStart(2, '0')} — long title for a producer project`,
      filePath, fileName, addedAt: beats[0].addedAt - 10 - index,
      fingerprint: recoveryHash(bytes), thumbnail: artwork(index) }
    beat.analysis = analysis(beat)
    beats.push(beat)
  }

  const annotations = Object.fromEntries(beats.map((beat, index) => [beat.id, {
    favorite: index % 2 === 0, tags: ['Recovery shortlist', `Source ${beat.sourceKind}`], notes: `Keep the saved note for ${beat.id}.`
  }]))
  const organization = { schemaVersion: 1, annotations, collections: [
    { id: 'recovery-shortlist', type: 'manual', name: 'Recovery shortlist', beatIds: [beats[2].id, beats[0].id, beats[1].id] },
    { id: 'recovery-missing', type: 'smart', name: 'Missing recovery tracks', rules: { version: 1, fileState: 'missing' } }
  ], view: { activeCollectionId: null, layout: 'list', sort: 'newest' } }
  await writeFile(path.join(root, 'library.json'), JSON.stringify(beats, null, 2))
  await writeFile(path.join(root, 'organization.json'), JSON.stringify(organization, null, 2))
  return { beats, organization, externalDir }
}

/** Rename retains a real file's ownership identity; a copied file does not. */
export async function moveRecoveryTrack(beat, folder, { sidecar = true } = {}) {
  await mkdir(folder, { recursive: true })
  const audioPath = path.join(folder, path.basename(beat.filePath))
  await rename(beat.filePath, audioPath)
  let sidecarPath = null
  if (sidecar && beat.sidecarPath) {
    sidecarPath = path.join(folder, path.basename(beat.sidecarPath))
    await rename(beat.sidecarPath, sidecarPath)
  }
  return { beatId: beat.id, audioPath, sidecarPath }
}

export async function copyRecoveryCandidate(sourcePath, folder, name = path.basename(sourcePath)) {
  await mkdir(folder, { recursive: true })
  const filePath = path.join(folder, name)
  await copyFile(sourcePath, filePath)
  return filePath
}

export async function recoveryMediaSnapshot(filePaths) {
  return Promise.all(filePaths.filter(Boolean).map(async filePath => ({
    filePath, fingerprint: recoveryHash(await readFile(filePath)), identity: await physicalIdentity(filePath)
  })))
}

/** All saved track evidence besides the intentionally recovered path/state. */
export function savedTrackEvidence(beat) {
  const { filePath, fileName, missing, fileAccessError, sidecarPath, sidecarSync,
    fileOwnership, ownershipEvidence, recoveryInfo, ...evidence } = beat
  return evidence
}
