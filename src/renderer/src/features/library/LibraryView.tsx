import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownUp,
  LayoutGrid,
  List,
  Music4,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react'
import type { MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { LibraryBeat, PresetId } from '@shared/domain'
import { needsAnalysisRefresh } from '@shared/analysis'
import { FAVORITES_COLLECTION_ID, type OrganizationCommand, type OrganizationSnapshot } from '@shared/organization'
import type { BatchSession } from '@shared/batch'
import { PRESETS } from '@shared/presets'
import { cn } from '@/lib/cn'
import { useReducedMotion } from '@/lib/theme'
import { useApp } from '@/store/app'
import { reconcileWorkspace, useLibraryWorkspace, useWorkspaceField } from '@/store/libraryWorkspace'
import { Badge } from '@/components/ui/Badge'
import { Button, IconButton } from '@/components/ui/Button'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { overlayRoot } from '@/components/motion/overlay'
import { ipc } from '@/lib/ipc'
import { Dropdown, DropdownItem, DropdownLabel } from '@/components/ui/Dropdown'
import { Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/Toaster'
import { LibraryBeatRow } from './LibraryBeatRow'
import { PreviewTransport } from './PreviewTransport'
import { ImportAudio } from './ImportAudio'
import { RecoveryDialog } from './RecoveryDialog'
import { createLibraryIndex, searchLibrary, searchSmartCollection, type LibraryIndex, type LibrarySort } from './librarySearch'
import { CollectionWorkspace } from './CollectionWorkspace'
import { AnnotationEditor } from './AnnotationEditor'
import { usePlaybackActions, usePlaybackIdentity } from '@/features/playback/playbackSession'

const SORTS: { key: LibrarySort; label: string }[] = [
  { key: 'manual', label: 'Collection order' },
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

/** Searchable archive of imported audio and Sonic-created exports. */
export function LibraryView(): ReactNode {
  const reducedMotion = useReducedMotion()
  const { playOne, playQueue } = usePlaybackActions()
  const { beatId: playbackBeatId, status: playbackStatus } = usePlaybackIdentity()
  const library = useApp((state) => state.library)
  const rescanLibrary = useApp((state) => state.rescanLibrary)
  const removeBeat = useApp((state) => state.removeBeat)
  const updateBeatMetadata = useApp((state) => state.updateBeatMetadata)
  const reexportBeat = useApp((state) => state.reexportBeat)
  const defaultPresetId = useApp((state) => state.settings.defaultPresetId)
  const analyzeMissing = useApp((state) => state.analyzeMissing)
  const focusId = useApp((state) => state.libraryFocusId)
  const setLibraryFocus = useApp((state) => state.setLibraryFocus)

  const [query, setQuery] = useWorkspaceField('query')
  const [layout, setLayout] = useWorkspaceField('layout')
  const [sort, setSort] = useWorkspaceField('sort')
  const [bands, setBands] = useWorkspaceField('bands')
  const [formats, setFormats] = useWorkspaceField('formats')
  const [fileFilter, setFileFilter] = useWorkspaceField('fileFilter')
  const [reviewFilter, setReviewFilter] = useWorkspaceField('reviewFilter')
  const [bpmFilter, setBpmFilter] = useWorkspaceField('bpmFilter')
  const [bpmTolerance, setBpmTolerance] = useWorkspaceField('bpmTolerance')
  const [includeHalfDouble, setIncludeHalfDouble] = useWorkspaceField('includeHalfDouble')
  const [keyFilter, setKeyFilter] = useWorkspaceField('keyFilter')
  const [selectedId, setSelectedId] = useWorkspaceField('selectedId')
  const [selectedIds, setSelectedIds] = useWorkspaceField('selectedIds')
  const [, setSelectionAnchor] = useWorkspaceField('selectionAnchor')
  const [organization, setOrganization] = useState<OrganizationSnapshot | null>(null)
  const [organizationError, setOrganizationError] = useState(false)
  const [organizationAttempt, setOrganizationAttempt] = useState(0)
  const [batch, setBatch] = useState<BatchSession | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LibraryBeat | null>(null)
  const [alsoDeleteFiles, setAlsoDeleteFiles] = useState(true)
  const [showFilters, setShowFilters] = useWorkspaceField('showFilters')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<LibraryBeat | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [exportTarget, setExportTarget] = useState<LibraryBeat | null>(null)
  const [exportPresetId, setExportPresetId] = useState<PresetId>('wav-44100-24')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const [recoveryPlanId, setRecoveryPlanId] = useState<string | null>(null)
  const [pickingRecovery, setPickingRecovery] = useState(false)
  const recoveryPicker = useRef(false)
  const locateFile = async (beatId: string): Promise<void> => {
    if (recoveryPicker.current) return
    recoveryPicker.current = true; setPickingRecovery(true)
    try { const result = await ipc.invoke('recovery:chooseFile', beatId); if (result.planId) setRecoveryPlanId(result.planId) }
    catch (error) { toast({ kind: 'error', title: 'Could not locate audio', description: String(error) }) }
    finally { recoveryPicker.current = false; setPickingRecovery(false) }
  }

  useEffect(() => {
    let live = true
    setOrganizationError(false)
    void ipc.invoke('organization:snapshot').then(snapshot => {
      if (!live) return
      setOrganization(snapshot)
      setLayout(snapshot.view.layout)
      setSort(snapshot.view.sort)
    }).catch(error => {
      if (!live) return
      setOrganizationError(true)
      toast({ kind: 'error', title: 'Collections unavailable', description: String(error) })
    })
    const off = ipc.on('organization:changed', snapshot => { if (live) setOrganization(snapshot) })
    return () => { live = false; off() }
  }, [organizationAttempt, setLayout, setSort])
  useEffect(() => {
    if (!organization) return
    setLayout(organization.view.layout)
    setSort(organization.view.sort)
  }, [organization?.view.layout, organization?.view.sort])
  useEffect(() => {
    const id = window.sessionStorage.getItem('sonic:library-batch-session')
    if (!id) return
    void ipc.invoke('batch:status', id).then(result => {
      if (result) setBatch(result)
      else window.sessionStorage.removeItem('sonic:library-batch-session')
    }).catch(() => window.sessionStorage.removeItem('sonic:library-batch-session'))
  }, [])
  useEffect(() => {
    if (batch) window.sessionStorage.setItem('sonic:library-batch-session', batch.id)
    else window.sessionStorage.removeItem('sonic:library-batch-session')
  }, [batch?.id])

  const executeOrganization = async (command: OrganizationCommand): Promise<OrganizationSnapshot> => {
    const next = await ipc.invoke('organization:command', command)
    setOrganization(next)
    return next
  }

  const activeCollection = organization?.collections.find(item => item.id === organization.view.activeCollectionId) ?? null
  const activeScope = organization?.view.activeCollectionId ?? 'all'
  const changeScope = async (id: string | null): Promise<void> => {
    if (!organization || organization.view.activeCollectionId === id) return
    const nextSort = organization.collections.some(item => item.id === id && item.type === 'manual')
      ? 'manual' : sort === 'manual' ? 'newest' : sort
    await executeOrganization({ type: 'set-view', activeCollectionId: id, layout, sort: nextSort })
    setSort(nextSort)
    setSelectedIds(new Set())
    setSelectionAnchor(null)
  }

  const changeLayout = (next: 'grid' | 'list'): void => {
    if (!organization) return
    void executeOrganization({ type: 'set-view', activeCollectionId: organization.view.activeCollectionId, layout: next, sort })
      .then(() => setLayout(next))
      .catch(error => toast({ kind: 'error', title: 'Layout was not saved', description: String(error) }))
  }

  const changeSort = (next: LibrarySort): void => {
    if (!organization) return
    void executeOrganization({ type: 'set-view', activeCollectionId: organization.view.activeCollectionId, layout, sort: next })
      .then(() => setSort(next))
      .catch(error => toast({ kind: 'error', title: 'Sort was not saved', description: String(error) }))
  }

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

  const openMenu = useCallback((event: React.MouseEvent, beat: LibraryBeat): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!useLibraryWorkspace.getState().selectedIds.has(beat.id)) { setSelectedIds(new Set([beat.id])); setSelectionAnchor(beat.id) }
    setMenu({ id: beat.id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 216)) })
  }, [setSelectedIds, setSelectionAnchor])

  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const registerCard = useCallback((id: string, node: HTMLDivElement | null): void => {
    if (node) cardRefs.current.set(id, node)
    else cardRefs.current.delete(id)
  }, [])

  const indexCache = useRef<LibraryIndex | undefined>(undefined)
  const index = useMemo(() => {
    const next = createLibraryIndex(library, indexCache.current)
    indexCache.current = next
    return next
  }, [library])

  const availableFormats = useMemo(
    () => [...new Set(library.map((beat) => beat.format))].sort(),
    [library]
  )

  const visible = useMemo(() => {
    let scope = library
    if (activeCollection?.type === 'manual') {
      const byId = new Map(library.map(beat => [beat.id, beat]))
      scope = activeCollection.beatIds.flatMap(id => byId.get(id) ? [byId.get(id)!] : [])
    } else if (activeCollection?.type === 'smart' && organization) {
      scope = searchSmartCollection(library, index, activeCollection.rules, organization.annotations, sort)
    } else if (activeScope === FAVORITES_COLLECTION_ID) {
      scope = library.filter(beat => organization && Object.prototype.hasOwnProperty.call(organization.annotations, beat.id) && organization.annotations[beat.id].favorite)
    }
    const rows = searchLibrary(scope, index, {
      query, sort, bands, formats, fileFilter, reviewFilter, bpm: bpmFilter,
      bpmTolerance, includeHalfDouble, key: keyFilter
    })
    if (activeCollection?.type !== 'manual' || sort !== 'manual') return rows
    const positions = new Map(activeCollection.beatIds.map((id, position) => [id, position]))
    return rows.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity))
  }, [library, index, organization, activeScope, activeCollection, query, sort, bands, formats, fileFilter, reviewFilter, bpmFilter, bpmTolerance, includeHalfDouble, keyFilter])

  const auditionLabel = activeCollection?.name ?? (activeScope === FAVORITES_COLLECTION_ID ? 'Favorites' : 'All audio')
  const visibleRef = useRef(visible)
  useLayoutEffect(() => { visibleRef.current = visible }, [visible])
  const playDisplayed = (): void => {
    const ids = visible.map(beat => beat.id)
    if (ids.length) playQueue(ids, ids[0], auditionLabel)
  }
  const playSelected = (): void => {
    const ids = visible.filter(beat => selectedIds.has(beat.id)).map(beat => beat.id)
    if (ids.length) playQueue(ids, ids[0], `${auditionLabel} shortlist`)
  }

  const selectionScope = `${activeScope}\u0000${activeCollection?.type === 'smart' ? JSON.stringify(activeCollection.rules) : ''}\u0000${query}\u0000${[...bands].sort()}\u0000${[...formats].sort()}\u0000${fileFilter}\u0000${reviewFilter}\u0000${bpmFilter}\u0000${bpmTolerance}\u0000${includeHalfDouble}\u0000${keyFilter}`
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoredScroll = useRef(false)
  useLayoutEffect(() => {
    if (!organization) return
    const previousScope = useLibraryWorkspace.getState().selectionScope
    reconcileWorkspace(selectionScope, visible.map(beat => beat.id), library.map(beat => beat.id))
    const node = scrollRef.current
    if (node && (!restoredScroll.current || previousScope !== selectionScope)) {
      node.scrollTop = useLibraryWorkspace.getState().scrollTop
      restoredScroll.current = true
    }
  }, [organization, selectionScope, visible, library])
  useLayoutEffect(() => {
    const node = scrollRef.current
    return () => {
      if (node && restoredScroll.current) useLibraryWorkspace.setState({ scrollTop: node.scrollTop })
    }
  }, [])

  const toggleSelectedId = useCallback((id: string): void => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSelectionAnchor(id)
  }, [setSelectedIds, setSelectionAnchor])

  const selectCard = useCallback((event: ReactMouseEvent | ReactKeyboardEvent, beat: LibraryBeat): void => {
    const { selectedId, selectionAnchor } = useLibraryWorkspace.getState()
    if (event.shiftKey) {
      const ids = visibleRef.current.map(item => item.id)
      const anchor = ids.indexOf(selectionAnchor ?? beat.id)
      const end = ids.indexOf(beat.id)
      if (anchor >= 0 && end >= 0) setSelectedIds(previous => new Set([...previous, ...ids.slice(Math.min(anchor, end), Math.max(anchor, end) + 1)]))
      return
    }
    if (event.ctrlKey || event.metaKey) { toggleSelectedId(beat.id); return }
    setSelectedId(selectedId === beat.id ? null : beat.id)
    setSelectionAnchor(beat.id)
  }, [setSelectedIds, setSelectedId, setSelectionAnchor, toggleSelectedId])

  const selected = useMemo(
    () => library.find((beat) => beat.id === selectedId) ?? null,
    [library, selectedId]
  )

  const revealingScope = useRef(false)
  // A global search result must become visible even when a retained collection
  // or filter excludes it. Consume the request only after its row is mounted.
  useEffect(() => {
    if (!focusId || !organization) return
    if (!library.some(beat => beat.id === focusId)) { setLibraryFocus(null); return }
    const node = cardRefs.current.get(focusId)
    if (node) {
      setSelectedId(focusId)
      node.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'instant' : 'smooth' })
      node.querySelector<HTMLButtonElement>('button[aria-label^="Preview "]')?.focus({ preventScroll: true })
      setLibraryFocus(null)
      return
    }
    const workspace = useLibraryWorkspace.getState()
    if (workspace.query || workspace.bands.size || workspace.formats.size || workspace.fileFilter !== 'all' || workspace.reviewFilter !== 'all' || workspace.bpmFilter || workspace.keyFilter) {
      useLibraryWorkspace.setState({ query: '', bands: new Set(), formats: new Set(), fileFilter: 'all',
        reviewFilter: 'all', bpmFilter: '', keyFilter: '', selectedIds: new Set(), selectionAnchor: null })
    }
    if (organization.view.activeCollectionId !== null && !revealingScope.current) {
      revealingScope.current = true
      void changeScope(null).catch(error => {
        if (useApp.getState().libraryFocusId === focusId) setLibraryFocus(null)
        toast({ kind: 'error', title: 'Could not reveal this beat', description: String(error) })
      }).finally(() => { revealingScope.current = false })
    }
  }, [focusId, setLibraryFocus, setSelectedId, organization, reducedMotion, visible, library])

  const totals = useMemo(
    () => ({
      missing: library.filter((beat) => beat.missing).length
    }),
    [library]
  )

  const toggle = (set: Set<string>, value: string, apply: (next: Set<string>) => void): void => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    apply(next)
  }

  const activeFilterCount = bands.size + formats.size + (fileFilter === 'all' ? 0 : 1) +
    (reviewFilter === 'all' ? 0 : 1) + (bpmFilter.trim() ? 1 : 0) + (keyFilter.trim() ? 1 : 0)

  const needsAnalysis = useMemo(() => library.filter(beat => !beat.missing && !beat.fileAccessError && needsAnalysisRefresh(beat)).length, [library])
  const recoverable = visible.filter(beat => (beat.missing || beat.fileAccessError) && (selectedIds.size === 0 || selectedIds.has(beat.id)))
  const findMissingFiles = async (): Promise<void> => {
    if (recoveryPicker.current || !recoverable.length) return
    recoveryPicker.current = true; setPickingRecovery(true)
    try { const result = await ipc.invoke('recovery:chooseFolder', recoverable.map(beat => beat.id)); if (result.planId) setRecoveryPlanId(result.planId) }
    catch (error) { toast({ kind: 'error', title: 'Could not scan for audio', description: String(error) }) }
    finally { recoveryPicker.current = false; setPickingRecovery(false) }
  }

  return (
    <div className="workspace-page flex h-full min-h-0 flex-col gap-3">
      <header className="page-header flex shrink-0 items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="page-title">Library<span className="ml-2.5 align-middle text-[12px] font-normal tracking-normal text-fg-subtle nums">{library.length}</span></h1>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {needsAnalysis > 0 ? <Button variant="ghost" size="md" aria-label="Analyze now" leading={<Sparkles />}
            title={`${needsAnalysis} tracks with missing or outdated BPM and key analysis`} onClick={() => {
              void analyzeMissing().then(queued => toast({ kind: 'info', title: `Analyzing ${queued} track${queued === 1 ? '' : 's'}`,
                description: 'Working from the files on disk — nothing is re-downloaded.' }))
            }}>Analyze <span className="ml-1 text-fg-subtle nums">{needsAnalysis}</span></Button> : null}
          <ImportAudio />
        </div>
      </header>

      <div className="flex min-h-0 shrink-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="min-w-[160px] max-w-[340px] flex-1">
            <Input
              value={query}
              onChange={(event) => {
                if (!query.trim() && event.target.value.trim()) changeSort('relevance')
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
            variant={showFilters ? 'quiet' : 'ghost'}
            size="md"
            leading={<SlidersHorizontal />}
            aria-expanded={showFilters}
            onClick={() => setShowFilters((value) => !value)}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>

          <Dropdown
            align="end"
            trigger={({ toggle: open }) => (
              <Button variant="ghost" size="md" leading={<ArrowDownUp />} onClick={open}>
                {SORTS.find((entry) => entry.key === sort)?.label ?? 'Sort'}
              </Button>
            )}
          >
            {(close) => (
              <>
                <DropdownLabel>Sort by</DropdownLabel>
                {SORTS.filter(entry => entry.key !== 'manual' || activeCollection?.type === 'manual').map((entry) => (
                  <DropdownItem
                    key={entry.key}
                    selected={entry.key === sort}
                    onSelect={() => {
                      changeSort(entry.key)
                      close()
                    }}
                  >
                    {entry.label}
                  </DropdownItem>
                ))}
              </>
            )}
          </Dropdown>

          <span className="flex-1" />
          {recoverable.length > 0 ? <Button variant="ghost" size="sm" disabled={pickingRecovery} onClick={() => void findMissingFiles()}>Find missing files…</Button> : null}
          <Segmented
            value={layout}
            onChange={changeLayout}
            ariaLabel="Layout"
            size="sm"
            options={[
              { value: 'grid', label: '', icon: <LayoutGrid /> },
              { value: 'list', label: '', icon: <List /> }
            ]}
          />

          <IconButton
            label="Rescan the library"
            variant="ghost"
            onClick={() => {
              void rescanLibrary()
              toast({ kind: 'info', title: 'Rescanning the library' })
            }}
          >
            <RefreshCw />
          </IconButton>
        </div>

        {showFilters ? (
          <div className="flex max-h-[148px] flex-wrap items-center gap-x-5 gap-y-3 overflow-y-auto border-y border-line py-3">
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
                  aria-pressed={bands.has(band.id)}
                  className={cn(
                    'rounded-[6px] border px-2 py-1 text-[11px] transition-colors duration-[var(--duration-quick)]',
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
                  aria-pressed={formats.has(format)}
                  className={cn(
                    'rounded-[6px] border px-2 py-1 text-[11px] uppercase transition-colors duration-[var(--duration-quick)]',
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
                  className={cn('rounded-[6px] border px-2 py-1 text-[11px] capitalize transition-colors',
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
                  className={cn('rounded-[6px] border px-2 py-1 text-[11px] capitalize transition-colors',
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

      {organization ? <CollectionWorkspace organization={organization} activeId={organization.view.activeCollectionId}
        library={library} visible={visible} selectedIds={selectedIds}
        clearSelection={() => { setSelectedIds(new Set()); setSelectionAnchor(null) }}
        selectAll={() => { setSelectedIds(new Set(visible.map(beat => beat.id))); setSelectionAnchor(visible[0]?.id ?? null) }}
        onPlayDisplayed={playDisplayed}
        onPlaySelected={playSelected}
        onScope={changeScope} command={executeOrganization} batch={batch} setBatch={setBatch}
        defaultPresetId={defaultPresetId} manualSort={sort === 'manual'} /> : null}

      <div className="flex min-h-0 flex-1 gap-4">
      <div ref={scrollRef} data-library-scroll className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-0.5"
        onScroll={event => {
          if (restoredScroll.current) useLibraryWorkspace.setState({ scrollTop: event.currentTarget.scrollTop })
        }}>
        {!organization ? (
          <div className="p-3 text-fg-subtle">
            {organizationError ? <>
              <p>Library workspace could not be loaded.</p>
              <Button variant="secondary" onClick={() => setOrganizationAttempt(value => value + 1)}>Retry</Button>
            </> : 'Loading Library workspace…'}
          </div>
        ) : library.length === 0 ? (
          <div className="studio-panel grid h-full min-h-[230px] place-items-center px-6 py-8">
            <div className="max-w-[360px] text-center">
              <Music4 className="mx-auto mb-4 size-6 text-fg-subtle" strokeWidth={1.4} />
              <h2 className="text-[15px] font-medium text-fg">Your library is empty</h2>
              <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">Import audio from your computer, or add a link in Downloads.</p>
              <p className="mt-5 text-[11px] text-fg-subtle">WAV · FLAC · MP3 · M4A · OGG</p>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="studio-panel grid h-full min-h-[180px] place-items-center px-8 text-center text-[13px] text-fg-muted">
            {activeCollection?.type === 'manual' && activeCollection.beatIds.length === 0
              ? 'This collection is empty. Select beats and use Add to collection.'
              : activeScope === FAVORITES_COLLECTION_ID && !library.some(beat => organization && Object.prototype.hasOwnProperty.call(organization.annotations, beat.id) && organization.annotations[beat.id].favorite)
                ? 'No favorites yet. Open a beat and mark it as a favorite.'
                : activeCollection?.type === 'smart'
                  ? 'No beats currently match this smart collection’s rules.'
                  : 'No beats match those filters.'}
          </div>
        ) : layout === 'grid' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2 pb-1">
            {visible.map((beat) => (
                <LibraryBeatRow
                  key={beat.id}
                  beat={beat}
                  layout="grid"
                  playbackState={playbackBeatId === beat.id ? playbackStatus : undefined}
                  selected={selectedId === beat.id}
                  batchSelected={selectedIds.has(beat.id)}
                  onToggleSelection={toggleSelectedId}
                  onSelect={selectCard}
                  onPlay={playOne}
                  onContextMenu={openMenu}
                  registerCard={registerCard}
                />
            ))}
          </div>
        ) : (
          <div className="@container overflow-hidden">
            <div aria-hidden="true" className="mb-1 flex h-8 items-center gap-3 border-b border-line px-2 text-[11px] text-fg-subtle">
              <span className="w-[64px] shrink-0" />
              <span className="min-w-0 flex-1">Track</span>
              <span className="hidden w-14 shrink-0 text-right @min-[440px]:block">BPM</span>
              <span className="hidden w-14 shrink-0 text-right @min-[480px]:block">Key</span>
              <span className="w-11 shrink-0 text-right">Time</span>
              <span className="hidden w-12 shrink-0 text-right @min-[620px]:block">Format</span>
            </div>
            {visible.map((beat) => (
                <LibraryBeatRow
                  key={beat.id}
                  beat={beat}
                  layout="list"
                  playbackState={playbackBeatId === beat.id ? playbackStatus : undefined}
                  selected={selectedId === beat.id}
                  batchSelected={selectedIds.has(beat.id)}
                  onToggleSelection={toggleSelectedId}
                  onSelect={selectCard}
                  onPlay={playOne}
                  onContextMenu={openMenu}
                  registerCard={registerCard}
                />
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <aside aria-label="Beat inspector" className="min-h-0 w-[300px] max-w-[39%] shrink-0 overflow-y-auto rounded-[10px] bg-surface">
          <PreviewTransport
          key={`preview-${selected.id}`}
          beat={selected}
          onLocateFile={() => void locateFile(selected.id)}
          onClose={() => setSelectedId(null)}
          onRequestDelete={() => {
            setAlsoDeleteFiles(selected.fileOwnership === 'sonic-export')
            setDeleteTarget(selected)
          }}
          onRequestExport={() => {
            setExportTarget(selected)
            setExportPresetId(defaultPresetId === 'original' ? 'wav-44100-24' : defaultPresetId)
            setExportError('')
          }}
        />
        {organization ? <AnnotationEditor key={`annotations-${selected.id}`} beat={selected} annotation={Object.prototype.hasOwnProperty.call(organization.annotations, selected.id) ? organization.annotations[selected.id] : undefined} command={executeOrganization} /> : null}
        </aside>
      ) : null}
      </div>

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
              {item('Play this beat', () => playOne(beat.id), beat.missing)}
              {beat.missing || beat.fileAccessError ? item('Locate file…', () => locateFile(beat.id), pickingRecovery) : null}
              {(beat.sourceKind === 'youtube' || beat.sourceKind === 'soundcloud') && beat.sourceUrl ? <>
                {item(beat.sourceKind === 'soundcloud' ? 'Open on SoundCloud' : 'Open on YouTube', async () => { if (!await ipc.invoke('library:openSource', beat.id)) throw new Error('No valid source link is saved for this beat.') })}
                {item('Refresh channel name', async () => { const refreshed = await ipc.invoke('library:refreshSource', beat.id); useApp.getState().setLibrarySnapshot(refreshed) })}
              </> : null}
              {item(beat.fileOwnership === 'external' ? 'Rename in library…' : 'Rename beat and file…', () => { setRenameTarget(beat); setRenameTitle(beat.title); setRenameError('') })}
              {beat.fileOwnership === 'external' ? item('Export prepared copy…', () => {
                setExportTarget(beat); setExportPresetId(defaultPresetId === 'original' ? 'wav-44100-24' : defaultPresetId); setExportError('')
              }, beat.missing) : null}
              {item('Show file in folder', async () => { if (!await ipc.invoke('library:revealFile', beat.id)) throw new Error('File is unavailable.') }, beat.missing)}
              <div role="separator" className="my-1 border-t border-line" />
              {item(beat.fileOwnership === 'external' ? 'Remove from library…' : 'Delete beat…', () => {
                setAlsoDeleteFiles(beat.fileOwnership === 'sonic-export'); setDeleteTarget(beat)
              })}
            </>
          })()}
        </div>, overlayRoot()) : null}

      <Modal open={renameTarget != null} onClose={() => !renaming && setRenameTarget(null)}
        title={renameTarget?.fileOwnership === 'external' ? 'Rename in library' : 'Rename beat and file'} size="sm" blocking={renaming}
        description={renameTarget?.fileOwnership === 'external'
          ? 'This changes only Sonic’s library record. The original filename and audio tags stay untouched.'
          : 'The audio filename and sidecar will follow the saved BPM and key. Audio tags are updated when you re-export.'}
        footer={<>
          <Button variant="secondary" onClick={() => setRenameTarget(null)} disabled={renaming}>Cancel</Button>
          <Button onClick={() => {
            if (!renameTarget || renaming) return
            const title = renameTitle.trim()
            if (!title) { setRenameError('Enter a beat title.'); return }
            setRenaming(true); setRenameError('')
            void updateBeatMetadata(renameTarget.id, { title })
              .then(() => { setRenameTarget(null); toast({ kind: 'success', title: renameTarget.fileOwnership === 'external' ? 'Library name saved' : 'Beat and file renamed' }) })
              .catch(error => setRenameError(String(error)))
              .finally(() => setRenaming(false))
          }} disabled={renaming}>Save name</Button>
        </>}>
        <Input value={renameTitle} onChange={event => setRenameTitle(event.target.value)} placeholder="Beat title" />
        {renameError ? <p role="alert" className="mt-2 text-[12px] text-danger">{renameError}</p> : null}
      </Modal>

      <Modal open={exportTarget != null} onClose={() => !exporting && setExportTarget(null)}
        title="Export prepared copy" size="sm" blocking={exporting}
        description="Sonic creates a new file with your current library metadata. The imported original stays untouched."
        footer={<>
          <Button variant="secondary" onClick={() => setExportTarget(null)} disabled={exporting}>Cancel</Button>
          <Button disabled={exporting || exportTarget?.missing} onClick={() => {
            if (!exportTarget || exporting) return
            setExporting(true); setExportError('')
            void reexportBeat(exportTarget.id, exportPresetId)
              .then(result => {
                if (!result.ok) throw new Error(result.error || 'Export failed.')
                setExportTarget(null)
                toast({ kind: 'success', title: 'Prepared copy exported' })
              })
              .catch(failure => setExportError(failure instanceof Error ? failure.message : String(failure)))
              .finally(() => setExporting(false))
          }}>{exporting ? 'Exporting…' : 'Export copy'}</Button>
        </>}>
        <label className="block text-[12px] font-medium text-fg-muted" htmlFor="local-export-preset">Audio format</label>
        <select id="local-export-preset" value={exportPresetId}
          onChange={event => setExportPresetId(event.target.value as PresetId)}
          className="mt-1.5 h-9 w-full rounded-[9px] border border-line bg-surface-2 px-2.5 text-[13px] text-fg">
          {PRESETS.filter(preset => preset.id !== 'original').map(preset =>
            <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
        {exportError ? <p role="alert" className="mt-2 text-[12px] text-danger">{exportError}</p> : null}
      </Modal>

      <ConfirmDialog
        open={deleteTarget != null}
        title={`${deleteTarget?.fileOwnership === 'external' ? 'Remove from library' : 'Remove'} “${deleteTarget?.title ?? 'beat'}”?`}
        description={
          deleteTarget?.fileOwnership === 'external'
            ? 'Only the library record is removed. The imported original remains in its folder, unchanged.'
            : alsoDeleteFiles
            ? 'The audio file and its sidecar will be removed from disk. This cannot be undone.'
            : 'Only the library record is removed. The audio stays on disk.'
        }
        confirmLabel={deleteTarget?.fileOwnership === 'external' ? 'Remove from library' : alsoDeleteFiles ? 'Delete files' : 'Remove record'}
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return
          const id = deleteTarget.id
          await removeBeat(id, deleteTarget.fileOwnership === 'sonic-export' && alsoDeleteFiles,
            { filePath: deleteTarget.filePath, fingerprint: deleteTarget.fingerprint })
          setSelectedId(current => current === id ? null : current)
          setDeleteTarget(null)
        }}
      >
        {deleteTarget?.fileOwnership !== 'external' ? <div className="flex items-center gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
          <Switch checked={alsoDeleteFiles} onChange={setAlsoDeleteFiles} label="Also delete the files" />
          <span className="text-[12.5px] text-fg-muted">Also delete the audio and sidecar</span>
        </div> : null}
        {deleteTarget ? (
          <p className="mt-2 font-mono text-[10.5px] break-all text-fg-subtle">{deleteTarget.fileName}</p>
        ) : null}
      </ConfirmDialog>
      {recoveryPlanId ? <RecoveryDialog planId={recoveryPlanId} onClose={() => setRecoveryPlanId(null)} /> : null}
    </div>
  )
}
