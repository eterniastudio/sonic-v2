import { createRoot } from 'react-dom/client'
import { useCallback, useState, type MouseEvent, type KeyboardEvent } from 'react'
import type { LibraryBeat } from '../../src/shared/domain'
import { LibraryBeatRow } from '../../src/renderer/src/features/library/LibraryBeatRow'

let reads: string[] = []
const registered = new Map<string, HTMLDivElement>()
const record = (id: string, title = `Track ${id}`): LibraryBeat => {
  const beat = { id, title, producer: 'Producer', bpm: 140, camelot: '8A', sourceUrl: null,
    sourceKind: 'local', missing: false, format: 'wav' } as LibraryBeat
  Object.defineProperty(beat, 'durationSec', { enumerable: true, get: () => { reads.push(id); return 30 } })
  return beat
}
const initial = Array.from({ length: 100 }, (_, id) => record(String(id)))
const registerCard = (id: string, node: HTMLDivElement | null): void => {
  if (node) registered.set(id, node)
  else registered.delete(id)
}

function Harness() {
  const [beats, setBeats] = useState(initial)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [shortlist, setShortlist] = useState(new Set<string>())
  const [playback, setPlayback] = useState<string | null>(null)
  const [inspectedTitle, setInspectedTitle] = useState('')
  const [layout, setLayout] = useState<'grid' | 'list'>('list')
  const select = useCallback((_event: MouseEvent | KeyboardEvent, beat: LibraryBeat) => {
    setSelectedId(current => current === beat.id ? null : beat.id)
    setInspectedTitle(beat.title)
  }, [])
  const toggle = useCallback((id: string) => setShortlist(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])
  const play = useCallback((id: string) => setPlayback(id), [])
  const context = useCallback((_event: MouseEvent, beat: LibraryBeat) => setInspectedTitle(beat.title), [])
  Object.assign(window, { libraryPerformance: {
    reset: () => { reads = [] },
    renderedIds: () => [...new Set(reads)].sort(),
    registered: () => [...registered.keys()],
    layout: setLayout,
    revise: (id: string) => setBeats(previous => previous.map(beat => beat.id === id ? record(id, `Revised track ${id}`) : beat))
  } })
  return <main>
    <output aria-label="Inspected title">{inspectedTitle}</output>
    {beats.map(beat => <LibraryBeatRow key={beat.id} beat={beat} layout={layout}
      selected={selectedId === beat.id} batchSelected={shortlist.has(beat.id)}
      playbackState={playback === beat.id ? 'playing' : undefined}
      onSelect={select} onToggleSelection={toggle} onPlay={play} onContextMenu={context} registerCard={registerCard} />)}
  </main>
}

createRoot(document.getElementById('root')!).render(<Harness />)
