// The main-process guard that keeps direct-file, other-site and cover downloads
// off the user's own machine and LAN, after DNS resolution.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')

async function load() {
  const directory = await mkdtemp(path.join(tmpdir(), 'sonic-public-address-'))
  const outfile = path.join(directory, 'public-address.mjs')
  await build({ entryPoints: [path.join(root, 'src/main/lib/publicAddress.ts')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' })
  return { modules: await import(pathToFileURL(outfile).href), directory }
}

test('private, loopback, link-local and mapped addresses are refused', async () => {
  const { modules, directory } = await load()
  try {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', 'not-an-ip']) {
      assert.equal(modules.isPrivateAddress(address), true, address)
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(modules.isPrivateAddress(address), false, address)
    }
    await assert.rejects(modules.assertPublicUrl('https://127.0.0.1/a.mp3'), /private network/)
    await assert.rejects(modules.assertPublicUrl('https://[::1]/a.mp3'), /private network/)
    await assert.rejects(modules.assertPublicUrl('https://localhost/a.mp3'), /private network/)
    await modules.assertPublicUrl('https://8.8.8.8/a.mp3')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
