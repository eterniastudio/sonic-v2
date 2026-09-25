import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useIpcEvent, useHotkey } from '@/lib/hooks'
import { useThemeSync } from '@/lib/theme'
import { useApp } from '@/store/app'
import { AmbientBackground } from '@/components/aceternity/AmbientBackground'
import { JellyLoader } from '@/components/obsidian/JellyLoader'
import { CommandPalette } from '@/components/shell/CommandPalette'
import { Sidebar } from '@/components/shell/Sidebar'
import { TitleBar } from '@/components/shell/TitleBar'
import { StorageFeedback } from '@/components/shell/StorageFeedback'
import { Toaster, toast } from '@/components/ui/Toaster'
import { Logo } from '@/components/shell/Logo'
import { DownloadView } from '@/features/download/DownloadView'
import { LibraryView } from '@/features/library/LibraryView'
import { PlaybackDock } from '@/features/playback/PlaybackDock'
import { PlaybackProvider } from '@/features/playback/playbackSession'
import { SettingsView } from '@/features/settings/SettingsView'

/** First-paint splash while the main process answers the bootstrap calls. */
function BootSplash(): ReactNode {
  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-bg">
      <AmbientBackground variant="full" />
      <div className="relative flex flex-col items-center gap-5">
        <Logo size={44} />
        <JellyLoader size={38} />
        <div className="text-center">
          <div className="text-[15px] font-semibold tracking-tight text-fg">Sonic V2</div>
          <p className="mt-0.5 text-[12px] text-fg-muted">Warming up the studio…</p>
        </div>
      </div>
    </div>
  )
}

/**
 * Subscribes to every main-process push channel exactly once. Downstream
 * components read from the store rather than re-subscribing.
 */
function useMainProcessBridge(): void {
  useIpcEvent('queue:changed', (queue) => useApp.setState({ queue }))
  useIpcEvent('library:changed', (library) => useApp.setState({ library }))
  useIpcEvent('settings:changed', (settings) => useApp.setState({ settings }))
  useIpcEvent('engine:status', (engine) => useApp.setState({ engine }))
  useIpcEvent('engine:progress', (engineProgress) => useApp.setState({ engineProgress }))
  useIpcEvent('analysis:progress', (analysisProgress) => {
    useApp.setState({ analysisProgress })
    // A completed analysis updates the library record on the main side; the
    // `library:changed` push carries the result, so nothing else is needed here.
  })
  useIpcEvent('app:notice', (notice) => {
    toast({ kind: notice.kind, title: notice.message })
  })
}

export function App(): ReactNode {
  useThemeSync()
  useMainProcessBridge()

  const booted = useApp((state) => state.booted)
  const bootstrap = useApp((state) => state.bootstrap)
  const view = useApp((state) => state.view)
  const commandOpen = useApp((state) => state.commandOpen)
  const setCommandOpen = useApp((state) => state.setCommandOpen)
  const started = useRef(false)

  // A ref guard keeps the IPC round-trip single-shot under StrictMode.
  useEffect(() => {
    if (started.current) return
    started.current = true
    void bootstrap()
  }, [bootstrap])

  useHotkey({ key: 'k', mod: true }, (event) => {
    event.preventDefault()
    setCommandOpen(!useApp.getState().commandOpen)
  })

  if (!booted) return <BootSplash />

  return (
    <PlaybackProvider>
    <div className="relative flex h-full flex-col overflow-hidden bg-bg text-fg">
      <TitleBar />
      <StorageFeedback />

      <div className="relative flex min-h-0 flex-1">
        <Sidebar />

        <main className="relative min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 6, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(3px)' }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="h-full"
            >
              {view === 'download' ? <DownloadView /> : null}
              {view === 'library' ? <LibraryView /> : null}
              {view === 'settings' ? <SettingsView /> : null}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <PlaybackDock />

      {/* Ctrl+K is handled globally; this keeps the palette mounted for exits. */}
      <CommandPalette />
      {commandOpen ? null : null}
      <Toaster />
    </div>
    </PlaybackProvider>
  )
}
