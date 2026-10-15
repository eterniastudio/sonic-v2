import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import type { LibraryBeat } from '../../src/shared/domain'
import { CommandPalette } from '../../src/renderer/src/components/shell/CommandPalette'
import { PlaybackProvider } from '../../src/renderer/src/features/playback/playbackSession'
import { useApp } from '../../src/renderer/src/store/app'

export function PaletteHarness() {
  const [ready, setReady] = useState(false)
  const focused = useApp(state => state.libraryFocusId)
  useEffect(() => {
    window.sonic = { invoke: async () => ({ schemaVersion: 1, lastTrackId: null, volume: 1, positions: [] }) } as unknown as Window['sonic']
    const controls = {
      titleReads: 0,
      close: () => flushSync(() => useApp.getState().setCommandOpen(false)),
      progress: () => useApp.setState(state => ({ queue: { ...state.queue, jobs: state.queue.jobs.map(job => ({ ...job, progress: job.progress + 0.01 })) } })),
      clearLibrary: () => useApp.setState({ library: [] })
    }
    const library = Array.from({ length: 1000 }, (_, index) => ({
      id: `palette-${index}`, get title() { controls.titleReads += 1; return `Catalog beat ${String(index).padStart(4, '0')}` },
      producer: null, sourceChannel: null, fileName: `beat-${index}.wav`, format: 'wav',
      bpm: 140, key: 'A minor', camelot: '8A', missing: false, filePath: `beat-${index}.wav`
    } as LibraryBeat))
    useApp.setState(state => ({ library, commandOpen: false, libraryFocusId: null, settings: { ...state.settings, reduceMotion: 'off' },
      queue: { ...state.queue, jobs: [{ id: 'progress-job', stage: 'downloading', progress: 0 } as typeof state.queue.jobs[number]] } }))
    ;(window as unknown as { palette: typeof controls }).palette = controls
    setReady(true)
  }, [])
  return <main className="bg-bg text-fg h-screen p-4"><button onClick={() => useApp.getState().setCommandOpen(true)}>Open commands</button>
    <output aria-label="Focused beat">{focused}</output>
    {ready ? <PlaybackProvider><CommandPalette /></PlaybackProvider> : null}
  </main>
}
