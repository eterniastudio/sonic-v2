import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Gauge,
  HardDrive,
  LayoutGrid,
  List,
  Music4,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Wand2,
  X
} from 'lucide-react'
import type { LibraryBeat } from '@shared/domain'
import { formatBpm, formatBytes, formatDuration } from '@shared/format'
import { coverArtFor } from '@shared/url'
import { cn } from '@/lib/cn'
import { useApp } from '@/store/app'
import { AmbientBackground } from '@/components/aceternity/AmbientBackground'
import { AnimatedTooltip } from '@/components/aceternity/AnimatedTooltip'
import { BentoCard, BentoGrid } from '@/components/aceternity/BentoGrid'
import { FlipText } from '@/components/obsidian/FlipText'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { overlayRoot } from '@/components/motion/overlay'
import { ipc } from '@/lib/ipc'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'
import { NumberPop } from '@/components/ui/NumberPop'
import { toast } from '@/components/ui/Toaster'
import { BeatCard } from './BeatCard'
import { PreviewTransport } from './PreviewTransport'
import { createLibraryIndex, searchLibrary, type FileFilter, type LibrarySort, type ReviewFilter } from './librarySearch'

const SORTS: { key: LibrarySort; label: string }[] = [
  { key: 'relevance', label: 'Relevance' },
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'bpm-asc', label: 'Tempo: low → high' },
  { key: 'bpm-desc', label: 'Tempo: high → low' },
  { key: 'title', label: 'Title A → Z' },
  { key: 'producer', label: 'Producer A → Z' }
]

const TEMPO_BANDS: { id: string; label: string }[] = [
  { id: 'slow', label: '< 90' },
  { id: 'mid', label: '90–120' },
  { id: 'trap', label: '120–150' },
  { id: 'fast', label: '150+' }
]

/** Searchable, filterable archive of everything Sonic has exported. */
export function LibraryView(): ReactNode {
  const library = useApp((state) => state.library)
  const rescanLibrary = useApp((state) => state.rescanLibrary)
  const removeBeat = useApp((state) => state.removeBeat)
  const updateBeatMetadata = useApp((state) => state.updateBeatMetadata)
  const analyzeMissing = useApp((state) => state.analyzeMissing)
  const focusId = useApp((state) => state.libraryFocusId)
  const setLibraryFocus = useApp((state) => state.setLibraryFocus)

  const [query, setQuery] = useState('')
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [sort, setSort] = useState<LibrarySort>('newest')
  const [bands, setBands] = useState<Set<string>>(new Set())
  const [formats, setFormats] = useState<Set<string>>(new Set())
  const [fileFilter, setFileFilter] = useState<FileFilter>('all')
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all')
  const [bpmFilter, setBpmFilter] = useState('')
  const [bpmTolerance, setBpmTolerance] = useState(3)
  const [includeHalfDouble, setIncludeHalfDouble] = useState(false)
  const [keyFilter, setKeyFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LibraryBeat | null>(null)
  const [alsoDeleteFiles, setAlsoDeleteFiles] = useState(true)
  const [showFilters, setShowFilters] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<LibraryBeat | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const dismiss = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', keydown)
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', keydown) }
  }, [menu])

  const openMenu = (event: React.MouseEvent, beat: LibraryBeat): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ id: beat.id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 216)) })
  }

  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  const index = useMemo(() => createLibraryIndex(library), [library])

  const availableFormats = useMemo(
    () => [...new Set(library.map((beat) => beat.format))].sort(),
    [library]
  )

  const visible = useMemo(() => searchLibrary(library, index, {
    query, sort, bands, formats, fileFilter, reviewFilter, bpm: bpmFilter,
    bpmTolerance, includeHalfDouble, key: keyFilter
  }), [library, index, query, sort, bands, formats, fileFilter, reviewFilter, bpmFilter, bpmTolerance, includeHalfDouble, keyFilter])

  const selected = useMemo(
    () => library.find((beat) => beat.id === selectedId) ?? null,
    [library, selectedId]
  )

  // Honour a focus request coming from the command palette.
  useEffect(() => {
    if (!focusId) return
    setSelectedId(focusId)
    setLibraryFocus(null)
    const node = cardRefs.current.get(focusId)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusId, setLibraryFocus])

  const totals = useMemo(
    () => ({
      size: library.reduce((total, beat) => total + beat.sizeBytes, 0),
      missing: library.filter((beat) => beat.missing).length
    }),
    [library]
  )

  const stats = useMemo(() => {
    const withTempo = library.filter((beat) => beat.bpm != null)
    return {
      averageBpm:
        withTempo.length > 0
          ? Math.round(withTempo.reduce((total, beat) => total + (beat.bpm ?? 0), 0) / withTempo.length)
          : null,
      lossless: library.filter((beat) => beat.format === 'flac' || beat.format === 'wav').length,
      formats: new Set(library.map((beat) => beat.format)).size
    }
  }, [library])

  const toggle = (set: Set<string>, value: string, apply: (next: Set<string>) => void): void => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    apply(next)
  }

  const activeFilterCount = bands.size + formats.size + (fileFilter === 'all' ? 0 : 1) +
    (reviewFilter === 'all' ? 0 : 1) + (bpmFilter.trim() ? 1 : 0) + (keyFilter.trim() ? 1 : 0)

  const needsAnalysis = library.filter(
    (beat) => !beat.missing && (beat.analysisStatus === 'not-analyzed' || beat.analysisStatus === 'failed')
  ).length

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex shrink-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[15px] font-semibold tracking-tight text-fg">Beat Library</h1>
            <span className="text-[11.5px] text-fg-subtle nums">
              <NumberPop value={library.length} /> beats · {formatBytes(totals.size)}
            </span>
          </div>

          <span className="flex-1" />

          <div className="w-[260px]">
            <Input
              value={query}
              onChange={(event) => {
                if (!query.trim() && event.target.value.trim()) setSort('relevance')
                setQuery(event.target.value)
              }}
              placeholder="Search title, producer, BPM, key…"
              leading={<Search />}
              trailing={
                query.length > 0 ? (
                  <IconButton label="Clear search" size="icon-xs" onClick={() => setQuery('')}>
                    <X />
                  </IconButton>
                ) : null
              }
            />
          </div>

          <Button
            variant={showFilters ? 'quiet' : 'secondary'}
            size="md"
            leading={<SlidersHorizontal />}
            onClick={() => setShowFilters((value) => !value)}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>

          <Dropdown
            align="end"
            trigger={({ toggle: open }) => (
              <Button variant="secondary" size="md" onClick={open}>
                {SORTS.find((entry) => entry.key === sort)?.label ?? 'Sort'}
              </Button>
            )}
          >
            {(close) => (
              <>
                <DropdownLabel>Sort by</DropdownLabel>
                {SORTS.map((entry) => (
                  <DropdownItem
                    key={entry.key}
                    selected={entry.key === sort}
                    onSelect={() => {
                      setSort(entry.key)
                      close()
                    }}
                  >
                    {entry.label}
                  </DropdownItem>
                ))}
              </>
            )}
          </Dropdown>

          <Segmented
            value={layout}
            onChange={setLayout}
            ariaLabel="Layout"
            size="sm"
            options={[
              { value: 'grid', label: '', icon: <LayoutGrid /> },
              { value: 'list', label: '', icon: <List /> }
            ]}
          />

          <IconButton
            label="Rescan the library"
            variant="secondary"
            onClick={() => {
              void rescanLibrary()
              toast({ kind: 'info', title: 'Rescanning the library' })
            }}
          >
            <RefreshCw />
          </IconButton>
        </div>

        {needsAnalysis > 0 ? (
          <div className="flex flex-wrap items-center gap-2.5 rounded-[12px] border border-line bg-surface px-3.5 py-2.5">
            <Wand2 className="size-4 shrink-0 text-accent" />
            <span className="text-[12.5px] text-fg-muted">
              {needsAnalysis} track{needsAnalysis === 1 ? '' : 's'} have no audio analysis yet.
            </span>
            <span className="flex-1" />
            <Button
              variant="quiet"
              size="sm"
              leading={<Sparkles />}
              onClick={() => {
                void analyzeMissing().then((queued) => {
                  toast({
                    kind: 'info',
                    title: `Analyzing ${queued} track${queued === 1 ? '' : 's'}`,
                    description: 'Working from the files on disk — nothing is re-downloaded.'
                  })
                })
              }}
            >
              Analyze now
            </Button>
          </div>
        ) : null}

        {showFilters ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-[12px] border border-line bg-surface px-3.5 py-3">
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-fg-subtle">
              BPM
              <Input type="number" min="1" max="999" step="any" inputMode="decimal"
                aria-label="Target BPM" value={bpmFilter} onChange={(event) => setBpmFilter(event.target.value)}
                placeholder="e.g. 140" className="w-[90px]" />
              ±
              <Input type="number" min="0" max="20" step="0.5" aria-label="BPM tolerance"
                value={bpmTolerance} onChange={(event) => setBpmTolerance(Math.min(20, Math.max(0, Number(event.target.value) || 0)))}
                className="w-[65px]" />
            </label>
            <div className="flex items-center gap-2">
              <Switch checked={includeHalfDouble} onChange={setIncludeHalfDouble} label="Include half and double time" />
              <span className="text-[11px] text-fg-muted">Half/double time</span>
            </div>
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-fg-subtle">
              Key / Camelot
              <Input aria-label="Key or Camelot" value={keyFilter} onChange={(event) => setKeyFilter(event.target.value)}
                placeholder="e.g. 8A" className="w-[90px]" />
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-fg-subtle">Tempo</span>
              {TEMPO_BANDS.map((band) => (
                <button
                  key={band.id}
                  type="button"
                  onClick={() => toggle(bands, band.id, setBands)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-[var(--duration-quick)]',
                    bands.has(band.id)
                      ? 'border-[var(--sonic-accent-line)] bg-accent-soft text-accent'
                      : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                  )}
                >
                  {band.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-fg-subtle">Format</span>
              {availableFormats.map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => toggle(formats, format, setFormats)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] uppercase transition-colors duration-[var(--duration-quick)]',
                    formats.has(format)
                      ? 'border-[var(--sonic-accent-line)] bg-accent-soft text-accent'
                      : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
                  )}
                >
                  {format}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-fg-subtle">Files</span>
              {(['all', 'present', 'missing'] as const).map((value) => (
                <button key={value} type="button" onClick={() => setFileFilter(value)}
                  aria-pressed={fileFilter === value}
                  className={cn('rounded-full border px-2 py-0.5 text-[11px] capitalize transition-colors',
                    fileFilter === value ? 'border-[var(--sonic-accent-line)] bg-accent-soft text-accent' : 'border-line text-fg-muted hover:border-line-strong hover:text-fg')}>
                  {value}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-fg-subtle">Review</span>
              {(['all', 'incomplete', 'disagreement'] as const).map((value) => (
                <button key={value} type="button" onClick={() => setReviewFilter(value)}
                  aria-pressed={reviewFilter === value}
                  className={cn('rounded-full border px-2 py-0.5 text-[11px] capitalize transition-colors',
                    reviewFilter === value ? 'border-[var(--sonic-accent-line)] bg-accent-soft text-accent' : 'border-line text-fg-muted hover:border-line-strong hover:text-fg')}>
                  {value}
                </button>
              ))}
            </div>

            {totals.missing > 0 ? (
              <Badge tone="warning" size="sm" icon={<TriangleAlert />}>
                {totals.missing} missing
              </Badge>
            ) : null}

            <span className="flex-1" />

            {activeFilterCount > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBands(new Set())
                  setFormats(new Set())
                  setFileFilter('all')
                  setReviewFilter('all')
                  setBpmFilter('')
                  setKeyFilter('')
                  setIncludeHalfDouble(false)
                  setBpmTolerance(3)
                }}
              >
                Reset filters
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {library.length > 0 ? (
        <BentoGrid className="shrink-0">
          <BentoCard
            label="Beats in library"
            value={<NumberPop value={library.length} />}
            hint={`${stats.formats} format${stats.formats === 1 ? '' : 's'} · ${totals.missing} missing`}
            icon={<Music4 />}
            accent
          />
          <BentoCard label="On disk" value={formatBytes(totals.size)} icon={<HardDrive />} />
          <BentoCard
            label="Average tempo"
            value={stats.averageBpm != null ? `${stats.averageBpm}` : '—'}
            hint={stats.averageBpm != null ? 'BPM' : 'no tempo data'}
            icon={<Gauge />}
          />
          <BentoCard
            label="Lossless"
            value={String(stats.lossless)}
            hint={stats.lossless > 0 ? 'FLAC + WAV' : 'none yet'}
            icon={<HardDrive />}
          />
        </BentoGrid>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {library.length === 0 ? (
          <div className="relative grid h-full min-h-[340px] place-items-center overflow-hidden rounded-[14px] border border-line bg-surface">
            <AmbientBackground variant="full" intensity={0.7} />
            <div className="relative max-w-[470px] px-8 text-center">
              <h2 className="text-[20px] font-semibold tracking-tight text-fg">
                Your library is{' '}
                <span className="text-gradient">
                  <FlipText
                    words={['empty', 'waiting', 'ready', 'yours to fill']}
                    intervalMs={2400}
                  />
                </span>
              </h2>
              <p className="mt-3 text-[12.5px] leading-relaxed text-fg-muted">
                Every beat you export lands here with its tempo, key and waveform ready to audition.
                Paste a link in the Download tab to start.
              </p>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="grid h-full min-h-[220px] place-items-center rounded-[14px] border border-line bg-surface text-[12.5px] text-fg-subtle">
            No beats match those filters.
          </div>
        ) : layout === 'grid' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-3 pr-0.5 pb-0.5">
            {visible.map((beat) => (
              <div
                key={beat.id}
                ref={(node) => {
                  if (node) cardRefs.current.set(beat.id, node)
                  else cardRefs.current.delete(beat.id)
                }}
              >
                <BeatCard
                  beat={beat}
                  layout="grid"
                  selected={selectedId === beat.id}
                  onSelect={() => setSelectedId(selectedId === beat.id ? null : beat.id)}
                  onContextMenu={(event) => openMenu(event, beat)}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5 rounded-[14px] border border-line bg-surface p-1.5">
            {visible.map((beat) => {
              const cover = coverArtFor(beat.sourceUrl)
              return (
                <AnimatedTooltip
                  key={beat.id}
                  trigger={
                    <BeatCard
                      beat={beat}
                      layout="list"
                      selected={selectedId === beat.id}
                      onSelect={() => setSelectedId(selectedId === beat.id ? null : beat.id)}
                      onContextMenu={(event) => openMenu(event, beat)}
                    />
                  }
                  content={
                    <div>
                      <div className="relative aspect-video w-full overflow-hidden bg-surface-3">
                        {cover ? (
                          <img src={cover} alt="" className="size-full scale-[1.34] object-cover" />
                        ) : null}
                        <span className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                      </div>
                      <div className="p-3">
                        <div className="text-[12.5px] font-medium text-fg">{beat.title}</div>
                        <div className="mt-0.5 text-[11px] text-fg-muted">
                          {beat.producer || beat.sourceChannel || 'Unknown channel'}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {beat.bpm != null ? <Badge size="sm">{formatBpm(beat.bpm)} BPM</Badge> : null}
                          {beat.camelot ? (
                            <Badge size="sm" tone="accent">
                              {beat.camelot}
                            </Badge>
                          ) : null}
                          {beat.key ? <Badge size="sm">{beat.key}</Badge> : null}
                          <Badge size="sm" tone="outline">
                            {formatDuration(beat.durationSec)}
                          </Badge>
                        </div>
                        <div className="mt-2 truncate font-mono text-[10px] text-fg-subtle">
                          {beat.fileName}
                        </div>
                      </div>
                    </div>
                  }
                />
              )
            })}
          </div>
        )}
      </div>

      {selected ? (
        <PreviewTransport
          beat={selected}
          onClose={() => setSelectedId(null)}
          onRequestDelete={() => {
            setAlsoDeleteFiles(true)
            setDeleteTarget(selected)
          }}
        />
      ) : null}

      {menu && library.some(beat => beat.id === menu.id) ? createPortal(
        <div ref={menuRef} role="menu" aria-label="Beat actions" tabIndex={-1}
          className="fixed z-[420] w-[208px] rounded-[12px] border border-line bg-surface p-1 shadow-pop"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={event => {
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
            }
          }}>
          {(() => {
            const beat = library.find(item => item.id === menu.id)!
            const item = (label: string, action: () => void | Promise<void>, disabled = false): ReactNode => (
              <button type="button" role="menuitem" disabled={disabled} key={label}
                className="flex w-full rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-fg hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:opacity-40"
                onClick={() => { setMenu(null); void Promise.resolve(action()).catch(error => toast({ kind: 'error', title: label, description: String(error) })) }}>
                {label}
              </button>
            )
            return <>
              {item('Open on YouTube', async () => { if (!await ipc.invoke('library:openSource', beat.id)) throw new Error('No valid YouTube link is saved for this beat.') }, !beat.sourceUrl)}
              {item('Refresh channel name', async () => { const refreshed = await ipc.invoke('library:refreshSource', beat.id); useApp.setState({ library: refreshed }) }, !beat.sourceUrl)}
              {item('Rename beat and file…', () => { setRenameTarget(beat); setRenameTitle(beat.title); setRenameError('') }, beat.missing)}
              {item('Show file in folder', async () => { if (!await ipc.invoke('library:revealFile', beat.id)) throw new Error('File is unavailable.') }, beat.missing)}
              <div role="separator" className="my-1 border-t border-line" />
              {item('Delete beat…', () => { setAlsoDeleteFiles(true); setDeleteTarget(beat) })}
            </>
          })()}
        </div>, overlayRoot()) : null}

      <Modal open={renameTarget != null} onClose={() => !renaming && setRenameTarget(null)}
        title="Rename beat and file" size="sm" blocking={renaming}
        description="The audio filename and sidecar will follow the saved BPM and key. Audio tags are updated when you re-export."
        footer={<>
          <Button variant="secondary" onClick={() => setRenameTarget(null)} disabled={renaming}>Cancel</Button>
          <Button onClick={() => {
            if (!renameTarget || renaming) return
            const title = renameTitle.trim()
            if (!title) { setRenameError('Enter a beat title.'); return }
            setRenaming(true); setRenameError('')
            void updateBeatMetadata(renameTarget.id, { title })
              .then(() => { setRenameTarget(null); toast({ kind: 'success', title: 'Beat and file renamed' }) })
              .catch(error => setRenameError(String(error)))
              .finally(() => setRenaming(false))
          }} disabled={renaming}>Save name</Button>
        </>}>
        <Input value={renameTitle} onChange={event => setRenameTitle(event.target.value)} placeholder="Beat title" />
        {renameError ? <p role="alert" className="mt-2 text-[12px] text-danger">{renameError}</p> : null}
      </Modal>

      <ConfirmDialog
        open={deleteTarget != null}
        title={`Remove “${deleteTarget?.title ?? 'beat'}”?`}
        description={
          alsoDeleteFiles
            ? 'The audio file and its sidecar will be removed from disk. This cannot be undone.'
            : 'Only the library record is removed. The audio stays on disk.'
        }
        confirmLabel={alsoDeleteFiles ? 'Delete files' : 'Remove record'}
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return
          const id = deleteTarget.id
          await removeBeat(id, alsoDeleteFiles, { filePath: deleteTarget.filePath, fingerprint: deleteTarget.fingerprint })
          if (selectedId === id) setSelectedId(null)
          setDeleteTarget(null)
        }}
      >
        <div className="flex items-center gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
          <Switch checked={alsoDeleteFiles} onChange={setAlsoDeleteFiles} label="Also delete the files" />
          <span className="text-[12.5px] text-fg-muted">Also delete the audio and sidecar</span>
        </div>
        {deleteTarget ? (
          <p className="mt-2 font-mono text-[10.5px] break-all text-fg-subtle">{deleteTarget.fileName}</p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
