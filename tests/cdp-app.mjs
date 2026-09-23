import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Same renderer assertions, direct runtime launch: no Node Inspector or Electron loader. */
export async function launchCdpApp({ executablePath, args, env }) {
  const child = spawn(executablePath || require('electron'), ['--remote-debugging-port=0', ...args], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data.toString() })
  const endpoint = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP startup exceeded 20 seconds: ${stderr}`)), 20000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`App exited during CDP startup: ${code}; ${stderr}`)) })
    child.stderr.on('data', data => {
      stderr += data.toString()
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
  })
  let browser
  try { browser = await chromium.connectOverCDP(await endpoint) }
  catch (error) {
    // Preserve the live spawn for the common harness's creation-qualified cleanup.
    // It must capture/settle descendants; killing only the main process is insufficient.
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      launchedApp: {
        transport: 'cdp', mainPid: child.pid, initialStdout: stdout, initialStderr: stderr,
        process: () => child, firstWindow: async () => { throw new Error('CDP startup failed') }
      }
    })
  }
  const context = browser.contexts()[0]
  return {
    transport: 'cdp', mainPid: child.pid,
    initialStdout: stdout, initialStderr: stderr,
    process: () => child,
    context: () => context,
    firstWindow: async () => context.pages()[0] || context.waitForEvent('page'),
    disconnect: async () => { if (browser.isConnected()) await browser.close() }
  }
}
