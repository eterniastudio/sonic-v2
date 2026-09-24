import MiniSearch from 'minisearch'
import type { LibraryBeat } from '@shared/domain'
import type { OrganizationSnapshot, SmartCollectionRule } from '@shared/organization'
import { parseKeyString } from '@shared/music'

export type LibrarySort = 'manual' | 'relevance' | 'newest' | 'oldest' | 'bpm-asc' | 'bpm-desc' | 'title' | 'producer'
export type FileFilter = 'all' | 'present' | 'missing'
export type ReviewFilter = 'all' | 'incomplete' | 'disagreement'

export interface LibrarySearchOptions {
  query: string
  sort: LibrarySort
  bands: ReadonlySet<string>
  formats: ReadonlySet<string>
  fileFilter: FileFilter
  reviewFilter: ReviewFilter
  bpm: string
  bpmTolerance: number
  includeHalfDouble: boolean
  key: string
}

const TEMPO_BANDS = [
  { id: 'slow', min: 0, max: 90 },
  { id: 'mid', min: 90, max: 120 },
  { id: 'trap', min: 120, max: 150 },
  { id: 'fast', min: 150, max: Number.POSITIVE_INFINITY }
]

export function createLibraryIndex(library: LibraryBeat[]): MiniSearch<LibraryBeat> {
  const index = new MiniSearch<LibraryBeat>({
    fields: ['title', 'producer', 'sourceChannel', 'fileName', 'key', 'camelot', 'format'],
    searchOptions: {
      boost: { title: 2, producer: 1.6 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: 'AND'
    }
  })
  index.addAll(library)
  return index
}

export function searchLibrary(
  library: LibraryBeat[],
  index: MiniSearch<LibraryBeat>,
  options: LibrarySearchOptions
): LibraryBeat[] {
  const query = options.query.trim()
  const rank = query
    ? new Map(index.search(query).map((hit, position) => [String(hit.id), position]))
    : null
  const bpmText = options.bpm.trim()
  const targetBpm = bpmText === '' ? null : Number(bpmText)
  if (bpmText !== '' && (targetBpm == null || !Number.isFinite(targetBpm) || targetBpm <= 0)) return []
  const keyText = options.key.trim()
  const wantedKey = keyText ? parseKeyString(keyText) : null
  if (keyText && !wantedKey) return []

  const rows = library.filter((beat) => {
    if (rank && !rank.has(beat.id)) return false
    if (options.bands.size > 0 && (beat.bpm == null || !TEMPO_BANDS.some(
      (band) => options.bands.has(band.id) && beat.bpm! >= band.min && beat.bpm! < band.max
    ))) return false
    if (options.formats.size > 0 && !options.formats.has(beat.format)) return false
    if (options.fileFilter === 'present' && beat.missing) return false
    if (options.fileFilter === 'missing' && !beat.missing) return false
    if (options.reviewFilter === 'incomplete' && beat.analysisStatus === 'estimated') return false
    if (options.reviewFilter === 'disagreement' && !beat.verification?.fields.some(
      (field) => (field.field === 'bpm' || field.field === 'key') && field.verdict === 'mismatch'
    )) return false
    if (targetBpm != null) {
      if (beat.bpm == null) return false
      const candidates = options.includeHalfDouble
        ? [targetBpm, targetBpm / 2, targetBpm * 2]
        : [targetBpm]
      if (!candidates.some((candidate) => Math.abs(beat.bpm! - candidate) <= options.bpmTolerance)) return false
    }
    if (wantedKey) {
      const actual = parseKeyString(beat.key ?? beat.camelot)
      if (!actual || (wantedKey.camelot
        ? actual.camelot !== wantedKey.camelot
        : actual.key !== wantedKey.key)) return false
    }
    return true
  })

  const sorted = [...rows]
  switch (options.sort) {
    case 'manual': break
    case 'relevance':
      if (rank) sorted.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
      else sorted.sort((a, b) => b.addedAt - a.addedAt)
      break
    case 'oldest': sorted.sort((a, b) => a.addedAt - b.addedAt); break
    case 'bpm-asc': sorted.sort((a, b) => (a.bpm ?? Infinity) - (b.bpm ?? Infinity)); break
    case 'bpm-desc': sorted.sort((a, b) => (b.bpm ?? -1) - (a.bpm ?? -1)); break
    case 'title': sorted.sort((a, b) => a.title.localeCompare(b.title)); break
    case 'producer': sorted.sort((a, b) => (a.producer ?? '').localeCompare(b.producer ?? '')); break
    default: sorted.sort((a, b) => b.addedAt - a.addedAt)
  }
  return sorted
}

/** Smart views use the same search and review predicates as the library filters. */
export function searchSmartCollection(
  library: LibraryBeat[], index: MiniSearch<LibraryBeat>, rules: SmartCollectionRule,
  annotations: OrganizationSnapshot['annotations'], sort: LibrarySort
): LibraryBeat[] {
  const searched = searchLibrary(library, index, {
    query: rules.query ?? '', sort, bands: new Set(), formats: new Set(),
    fileFilter: rules.fileState ?? 'all', reviewFilter: rules.reviewState ?? 'all',
    bpm: '', bpmTolerance: 0, includeHalfDouble: false, key: rules.key ?? ''
  })
  return searched.filter(beat => {
    const annotation = Object.prototype.hasOwnProperty.call(annotations, beat.id) ? annotations[beat.id] : undefined
    if (rules.favorite != null && Boolean(annotation?.favorite) !== rules.favorite) return false
    if (rules.tags?.length && !rules.tags.every(tag => annotation?.tags.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase()))) return false
    if (rules.bpmMin != null && (beat.bpm == null || beat.bpm < rules.bpmMin)) return false
    if (rules.bpmMax != null && (beat.bpm == null || beat.bpm > rules.bpmMax)) return false
    if (rules.sourceKind && beat.sourceKind !== rules.sourceKind) return false
    if (rules.fileOwnership && beat.fileOwnership !== rules.fileOwnership) return false
    return true
  })
}
