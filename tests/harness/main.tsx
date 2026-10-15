import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { MetadataCorrection } from '../../src/renderer/src/features/library/PreviewTransport'
import { useApp } from '../../src/renderer/src/store/app'
import type { LibraryBeat } from '../../src/shared/domain'
import { parseKeyString } from '../../src/shared/music'
import { Dropdown, DropdownItem } from '../../src/renderer/src/components/ui/Dropdown'
import { Modal, ConfirmDialog } from '../../src/renderer/src/components/ui/Modal'
import { DownloadHarness, QueueHarness } from './DownloadHarness'
import { PaletteHarness } from './PaletteHarness'
import '../../src/renderer/src/styles/index.css'
function Harness() {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [value, setValue] = useState(0)
  const [count, setCount] = useState(0)
  const picker = <Dropdown width="trigger" trigger={({ toggle }) => <button className="w-48 border p-3" onClick={toggle}>Pick {value}</button>}>{close => Array.from({ length: 18 }, (_, i) => <DropdownItem key={i} selected={i === value} onSelect={() => { setValue(i); setCount(n => n + 1); close() }}>Option {i}</DropdownItem>)}</Dropdown>
  return <main className="bg-bg text-fg h-screen p-4"><button onClick={() => setOpen(true)}>Open dialog</button><button onClick={() => setConfirm(true)}>Confirm operation</button><output aria-label="Selections">{count}</output><div className="absolute bottom-2 right-2 h-14 w-52 overflow-hidden">{picker}</div><Modal open={open} onClose={() => setOpen(false)} title="Nested overlay" description="Choose an option before closing this dialog.">{picker}<button>Last control</button></Modal><ConfirmDialog open={confirm} title="Pending operation" confirmLabel="Apply" onCancel={() => setConfirm(false)} onConfirm={async () => { setCount(n => n + 1); await new Promise(resolve => setTimeout(resolve, 150)); throw new Error('Deliberate write failure') }} /></main>
}
function EditorHarness() {
  const [beat, setBeat] = useState<LibraryBeat>({
    id: 'editor-fixture', title: 'Editor fixture', producer: null,
    bpm: 120, altBpm: null, key: 'A minor', camelot: '8A', detune: null,
    presetId: 'mp3-320', format: 'wav', filePath: 'editor-fixture.wav', fileName: 'editor-fixture.wav',
    fileOwnership: 'sonic-export', sidecarPath: null, sizeBytes: 0, durationSec: 0,
    bitrateKbps: null, sampleRate: null, channels: null, sourceUrl: null, sourceKind: 'unknown',
    addedAt: 0, fingerprint: '', missing: false, analysisStatus: 'not-analyzed', analysis: null,
    overrides: ['bpm', 'key'], sources: { title: {}, description: {}, filename: {} },
    embedded: {}, verification: null
  })
  useEffect(() => {
    const controls = {
      calls: [] as unknown[],
      mode: 'success',
      release: () => {},
      revise: (patch: Partial<LibraryBeat>) => setBeat(current => ({ ...current, ...patch }))
    }
    ;(window as unknown as { editor: typeof controls }).editor = controls
    useApp.setState({ updateBeatMetadata: async (_id, patch, reset) => {
      controls.calls.push({ patch, reset })
      if (controls.mode === 'barrier') await new Promise<void>(resolve => { controls.release = resolve })
      if (controls.mode === 'failure') throw new Error('Library write failed; changes remain unsaved')
      setBeat(current => {
        const next = { ...current, ...patch, overrides: Array.from(new Set([...current.overrides, ...Object.keys(patch)])) } as LibraryBeat
        if (patch.key !== undefined) next.camelot = parseKeyString(patch.key)?.camelot ?? null
        if (reset?.includes('bpm')) { next.bpm = 100; next.overrides = next.overrides.filter(field => field !== 'bpm') }
        if (reset?.includes('key')) { next.key = 'C major'; next.camelot = '8B'; next.overrides = next.overrides.filter(field => field !== 'key') }
        return next
      })
      if (controls.mode === 'partial') throw new Error('Library correction saved, but sidecar synchronization failed')
    } })
  }, [])
  return <main className="bg-bg text-fg h-screen p-4"><MetadataCorrection beat={beat} /><output aria-label="Current record">{JSON.stringify(beat)}</output></main>
}
createRoot(document.getElementById('root')!).render(location.hash === '#editor' ? <EditorHarness /> : location.hash === '#download' ? <DownloadHarness /> : location.hash === '#queue' ? <QueueHarness /> : location.hash === '#palette' ? <PaletteHarness /> : <Harness />)
