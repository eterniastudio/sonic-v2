import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fixtures } from '../tests/fixtures.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve('test-results/local-import')
await mkdir(root, { recursive: true })
const profile = path.join(root, `profile-${Date.now()}-${process.pid}`)
await fixtures(profile, 2)
const bundle = path.join(root, 'local-import.cjs')
await build({ entryPoints: ['tests/local-import-regressions.ts'], outfile: bundle, bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], alias: { '@shared': path.resolve('src/shared') } })
await cp('out/main/analysisWorker.js', path.join(root, 'analysisWorker.js'))
await cp('out/main/chunks', path.join(root, 'chunks'), { recursive: true })
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [bundle, `--user-data-dir=${profile}`], { env, stdio: 'inherit', windowsHide: true })
process.exitCode = (await new Promise(resolve => child.on('exit', resolve))) ?? 1
console.log(`Import test profile: ${profile}`)
