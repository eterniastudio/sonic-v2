import { BrowserWindow } from 'electron'
import type { IpcEventChannel, IpcEvents } from '@shared/ipc'

/** Pushes an event to every live renderer. */
export function broadcast<K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(channel, payload)
  }
}
