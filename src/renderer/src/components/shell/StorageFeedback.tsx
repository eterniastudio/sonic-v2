import { useEffect, useState } from 'react'
import type { StorageStatus } from '@shared/ipc'
import { ipc } from '@/lib/ipc'
import { useIpcEvent } from '@/lib/hooks'
import { useApp } from '@/store/app'

/** Persistent feedback survives toast expiry and is reconstructed from committed library state. */
export function StorageFeedback(): React.JSX.Element | null {
  const [stores, setStores] = useState<StorageStatus[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const library = useApp(state => state.library)
  useIpcEvent('storage:changed', setStores)
  useEffect(() => { void ipc.invoke('storage:status').then(setStores).catch(e => setError(String(e))) }, [])
  const failures = stores.filter(store => store.error)
  const sidecars = library.filter(beat => beat.sidecarSync?.status === 'error' || beat.sidecarSync?.status === 'pending')
  if (!failures.length && !sidecars.length && !error) return null
  const retry = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setStores(await ipc.invoke('storage:retry'))
      for (const beat of sidecars) useApp.setState({ library: await ipc.invoke('library:retrySidecar', beat.id) })
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <div role="alert" className="z-10 flex items-center gap-3 border-b border-warning/30 bg-bg-raised px-4 py-2 text-xs text-fg">
    <span className="flex-1">{failures.length ? `${failures.length} store(s) have unsaved changes. Keep Sonic open and retry saving.` : `${sidecars.length} sidecar(s) need synchronization. Library changes are saved; audio tags are unchanged.`}{error ? ` ${error}` : ''}</span>
    <button type="button" disabled={busy} onClick={() => void retry()} className="rounded border border-border px-3 py-1">{busy ? 'Retrying…' : 'Retry saving'}</button>
  </div>
}
