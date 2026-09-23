import type { AudioAnalysis } from '@shared/analysis'
import { ANALYSIS_ENGINE } from '@shared/analysis'
import { JsonStore } from '../lib/jsonStore'
import { analysisCacheFile } from '../services/paths'

/**
 * Analysis result cache.
 *
 * Keyed by the identity of the analysed bytes plus the engine version, so a
 * different file — or the same file after an engine upgrade — never returns a
 * stale estimate. This is deliberately separate from the library record's
 * integrity `fingerprint`: that one gates destructive file operations, this one
 * only decides whether analysis can be skipped.
 */

interface CacheEntry {
  inputId: string
  engine: string
  analysis: AudioAnalysis
}

/** Bounded so the cache cannot grow without limit. */
const MAX_ENTRIES = 300

function normalize(raw: unknown): CacheEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is CacheEntry => {
    if (typeof entry !== 'object' || entry === null) return false
    const candidate = entry as Partial<CacheEntry>
    return typeof candidate.inputId === 'string' && typeof candidate.engine === 'string' && !!candidate.analysis
  })
}

class AnalysisCache {
  private store = new JsonStore<CacheEntry[]>(analysisCacheFile(), [], normalize)

  get(inputId: string): AudioAnalysis | null {
    const hit = this.store.read().find((entry) => entry.inputId === inputId && entry.engine === ANALYSIS_ENGINE)
    return hit ? hit.analysis : null
  }

  set(inputId: string, analysis: AudioAnalysis): void {
    const entries = this.store
      .read()
      .filter((entry) => !(entry.inputId === inputId && entry.engine === ANALYSIS_ENGINE))

    entries.push({ inputId, engine: ANALYSIS_ENGINE, analysis })

    // Drop the oldest analyses once the cap is reached.
    entries.sort((a, b) => b.analysis.analyzedAt - a.analysis.analyzedAt)
    this.store.write(entries.slice(0, MAX_ENTRIES))
  }

  delete(inputId: string): void {
    this.store.write(this.store.read().filter((entry) => entry.inputId !== inputId))
  }

  clear(): void {
    this.store.write([])
  }

  size(): number {
    return this.store.read().length
  }
}

export const analysisCache = new AnalysisCache()
