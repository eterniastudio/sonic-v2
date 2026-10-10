import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
const files = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(name)
    else files.push(name.replaceAll('\\', '/'))
  }
}
for (const directory of ['src', 'scripts', 'tests']) await walk(directory)
files.push('package.json', 'package-lock.json', 'pnpm-lock.yaml', '.npmrc', 'electron.vite.config.ts', 'electron-builder.yml', 'playwright.config.ts', 'tsconfig.json', 'tsconfig.node.json')
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const source = []
for (const file of files.sort()) source.push({ file, sha256: await hashFile(file) })
const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex')
const artifacts = []
const packagedRoot = process.argv[3] || 'release/win-unpacked'
for (const file of ['out/main/index.js', 'out/main/analysisWorker.js',
  path.join(packagedRoot, 'Sonic V2.exe'), path.join(packagedRoot, 'resources', 'app.asar')]) {
  try { artifacts.push({ file, sha256: await hashFile(file) }) } catch { /* not built yet */ }
}
const output = process.argv[2] ?? 'test-results/source-manifest.json'
await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), sourceHash, source, artifacts }, null, 2))
console.log(JSON.stringify({ output, sourceHash, artifacts }, null, 2))
