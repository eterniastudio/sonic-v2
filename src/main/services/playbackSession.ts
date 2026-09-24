import { JsonStore } from '../lib/jsonStore'
import { lstat } from 'node:fs/promises'
import { playbackSessionFile } from './paths'
import { libraryService } from './library'
import { sha256File } from '../lib/fsx'
import type { PlaybackCheckpoint, PlaybackIdentity, PlaybackPosition, PlaybackSessionSnapshot } from '@shared/playback'

const MAX_POSITIONS = 128
const MAX_POSITION_SEC = 86_400
const DEFAULTS: PlaybackSessionSnapshot = { schemaVersion: 1, lastTrackId: null, volume: 1, positions: [] }
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
const position = (value: unknown): value is PlaybackPosition => record(value) && id(value.beatId) &&
  fingerprint(value.fingerprint) && typeof value.positionSec === 'number' && Number.isFinite(value.positionSec) &&
  value.positionSec >= 0 && value.positionSec <= MAX_POSITION_SEC && typeof value.completed === 'boolean' &&
  typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0

export function validatePlaybackCheckpoint(value: unknown): value is PlaybackCheckpoint {
  if (!record(value)) return false
  if (value.type === 'active') return Object.keys(value).length === 2 && (value.beatId === null || id(value.beatId))
  if (value.type === 'volume') return Object.keys(value).length === 2 && typeof value.volume === 'number' &&
    Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 1
  if (value.type === 'position') return Object.keys(value).length === 5 && id(value.beatId) &&
    fingerprint(value.fingerprint) && typeof value.positionSec === 'number' && Number.isFinite(value.positionSec) &&
    value.positionSec >= 0 && value.positionSec <= MAX_POSITION_SEC && typeof value.completed === 'boolean'
  return false
}

function normalizeStored(raw: unknown): PlaybackSessionSnapshot {
  if (!record(raw) || raw.schemaVersion !== 1 || (raw.lastTrackId !== null && !id(raw.lastTrackId)) ||
    typeof raw.volume !== 'number' || !Number.isFinite(raw.volume) || raw.volume < 0 || raw.volume > 1 ||
    !Array.isArray(raw.positions) || raw.positions.length > MAX_POSITIONS || !raw.positions.every(position)) {
    throw new Error('Invalid playback session file.')
  }
  const seen = new Set<string>()
  for (const entry of raw.positions) {
    if (seen.has(entry.beatId)) throw new Error('Duplicate playback position.')
    seen.add(entry.beatId)
  }
  return { schemaVersion: 1, lastTrackId: raw.lastTrackId as string | null, volume: raw.volume,
    positions: (raw.positions as PlaybackPosition[]).map(entry => ({ ...entry })) }
}

class PlaybackSessionService {
  private readonly store = new JsonStore<PlaybackSessionSnapshot>(playbackSessionFile(), DEFAULTS, normalizeStored)

  snapshot(): PlaybackSessionSnapshot { return structuredClone(this.store.read()) }

  async identity(beatId: string): Promise<PlaybackIdentity> {
    const beat = libraryService.get(beatId)
    if (!beat) throw new Error('This track is no longer in the library.')
    const before = await lstat(beat.filePath)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Audio is unavailable or no longer a regular file.')
    // A bounded read avoids leaving shutdown waiting indefinitely on a stalled volume.
    const digest = await sha256File(beat.filePath, AbortSignal.timeout(15_000))
    const after = await lstat(beat.filePath)
    if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev ||
      libraryService.get(beatId)?.filePath !== beat.filePath) {
      throw new Error('The audio file changed while Sonic checked it. Try playing it again.')
    }
    return { beatId, fingerprint: digest, sizeBytes: after.size, modifiedAt: after.mtimeMs }
  }

  checkpoint(command: PlaybackCheckpoint): PlaybackSessionSnapshot {
    if (!validatePlaybackCheckpoint(command)) throw new Error('Invalid playback checkpoint.')
    return this.store.update(current => {
      if (command.type === 'active') current.lastTrackId = command.beatId
      else if (command.type === 'volume') current.volume = command.volume
      else {
        const next: PlaybackPosition = { beatId: command.beatId, fingerprint: command.fingerprint,
          positionSec: command.positionSec, completed: command.completed, updatedAt: Date.now() }
        current.positions = [next, ...current.positions.filter(entry => entry.beatId !== command.beatId)]
          .slice(0, MAX_POSITIONS)
      }
      return current
    })
  }
}

export const playbackSessionService = new PlaybackSessionService()
