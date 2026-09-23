import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(import.meta.url)
const root = path.resolve('test-results', `smoke-${Date.now()}`)
await mkdir(root, { recursive: true })
await writeFile(path.join(root, 'settings.json'), JSON.stringify({ downloadDir: path.join(root, 'exports'), rescanIntervalMs: 0, autoStart: false }))
const env = { ...process.env, SONIC_SMOKE_REPORT: path.join(root, 'report.json') }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), ['.', `--user-data-dir=${root}`, '--smoke'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output += b; process.stdout.write(b) })
const code = await new Promise(resolve => child.on('exit', resolve))
await writeFile(path.join(root, 'output.log'), output)
console.log(`Report: ${path.join(root, 'report.json')}`)
process.exitCode = code ?? 1
