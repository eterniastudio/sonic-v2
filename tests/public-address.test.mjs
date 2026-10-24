// The main-process guard that keeps direct-file, other-site and cover downloads
// off the user's own machine and LAN, after DNS resolution.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
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
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', '192.0.2.1', 'not-an-ip']) {
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

function connectThrough(proxyUrl, authority, authorise = true) {
  const proxy = new URL(proxyUrl)
  const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorise ? `Proxy-Authorization: Basic ${auth}\r\n` : ''}\r\n`)
    })
    let data = ''
    socket.on('data', chunk => { data += chunk; if (data.includes('\r\n')) { socket.destroy(); resolve(data.split('\r\n')[0]) } })
    socket.on('error', reject)
  })
}

test('the yt-dlp proxy refuses private targets and unauthenticated clients', async () => {
  const { modules, directory } = await load()
  const target = http.createServer((_, res) => res.end('secret'))
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  try {
    const proxyUrl = await modules.guardedProxyUrl()
    assert.equal(await modules.guardedProxyUrl(), proxyUrl, 'one proxy per launch')
    const port = target.address().port
    assert.match(await connectThrough(proxyUrl, `127.0.0.1:${port}`), /^HTTP\/1\.1 403/)
    assert.match(await connectThrough(proxyUrl, `[::1]:${port}`), /^HTTP\/1\.1 403/)
    assert.match(await connectThrough(proxyUrl, `localhost:${port}`), /^HTTP\/1\.1 502/)
    assert.match(await connectThrough(proxyUrl, `127.0.0.1:${port}`, false), /^HTTP\/1\.1 407/)
    assert.deepEqual(await modules.guardedYtDlpArgs('youtube'), [])
    assert.deepEqual(await modules.guardedYtDlpArgs('generic'), ['--proxy', proxyUrl, '--downloader', 'native'])
  } finally {
    target.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a refused proxy tunnel reads as a private-address error', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sonic-provider-errors-'))
  try {
    const outfile = path.join(directory, 'providers.mjs')
    await build({ entryPoints: [path.join(root, 'src/shared/providers.ts')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' })
    const { describeProviderError } = await import(pathToFileURL(outfile).href)
    const stderr = "ERROR: [generic] a: Unable to download webpage: ('Unable to connect to proxy', OSError('Tunnel connection failed: 502 Bad Gateway'))"
    assert.match(describeProviderError(stderr, 'generic'), /private network address/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
