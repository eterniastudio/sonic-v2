import { randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { BlockList, connect, isIP, type LookupFunction, type Socket } from 'node:net'

/**
 * Address ranges a pasted link must never reach: the user's own machine, the
 * LAN, link-local and carrier-grade NAT space, documentation and benchmark
 * ranges, and the IPv6 equivalents, including translation and tunnelling
 * prefixes that embed an IPv4 address. `isPublicHost` in shared/providers is
 * only a paste-time check on the name; this module checks the address that is
 * actually connected to.
 */
// Separate lists: a BlockList also matches IPv4 addresses against IPv6 rules.
const blocked = new BlockList()
const blocked6 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
] as const) blocked6.addSubnet(network, prefix, 'ipv6')

const PRIVATE_MESSAGE = 'This link points to a local or private network address, which Sonic does not download from.'

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family !== 6) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return blocked.check(mapped[1], 'ipv4')
  return blocked6.check(address, 'ipv6')
}

function privateError(): Error {
  return Object.assign(new Error(PRIVATE_MESSAGE), { code: 'ESONICPRIVATE' })
}

/** Throws unless every address the URL's host resolves to is public. A fast pre-check for clear errors only. */
export async function assertPublicUrl(input: string): Promise<void> {
  const host = new URL(input).hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(entry => isPrivateAddress(entry.address))) throw privateError()
}

/**
 * A socket `lookup` that refuses hosts with any private address. The socket
 * connects to the address this returns, so the check and the connection use
 * the same resolution and a rebinding DNS answer cannot slip in between.
 * Sockets skip `lookup` for IP literals; callers check those with
 * `refuseLiteral` first.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    const done = callback as (...args: unknown[]) => void
    if (error) return done(error)
    if (addresses.length === 0 || addresses.some(entry => isPrivateAddress(entry.address))) return done(privateError())
    if (options.all) return done(null, addresses)
    done(null, addresses[0].address, addresses[0].family)
  })
}

/** Refuses a private IP-literal host up front, since sockets never call `lookup` for one. */
export function refuseLiteral(host: string): void {
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare) && isPrivateAddress(bare)) throw privateError()
}

function splitHostPort(authority: string, fallbackPort: number): { host: string; port: number } {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority)
  if (!match) throw new Error('Bad proxy target.')
  return { host: match[1].replace(/^\[|\]$/g, ''), port: match[2] ? Number(match[2]) : fallbackPort }
}

/**
 * A loopback-only HTTP proxy for yt-dlp runs on direct-file and other-site
 * links. yt-dlp follows redirects and fetches media URLs it finds on the page,
 * so a pre-flight check on the pasted link is not enough: this checks every
 * connection yt-dlp makes, at connect time. A per-launch credential keeps
 * other local programs from using it.
 */
let proxy: Promise<string> | null = null

export function guardedProxyUrl(): Promise<string> {
  proxy ??= startProxy().catch(error => { proxy = null; throw error })
  return proxy
}

function startProxy(): Promise<string> {
  const user = 'sonic'
  const secret = randomBytes(18).toString('hex')
  const expected = `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`
  const authorised = (req: IncomingMessage): boolean => req.headers['proxy-authorization'] === expected

  const server = createServer((req, res) => {
    // Plain-http requests arrive in absolute form.
    try {
      if (!authorised(req)) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="sonic"' }).end(); return }
      const target = new URL(req.url ?? '')
      if (target.protocol !== 'http:') throw new Error('Unsupported proxy scheme.')
      refuseLiteral(target.hostname)
      const headers = { ...req.headers }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const upstream = httpRequest({
        host: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
        lookup: publicLookup
      }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      })
      upstream.on('error', error => {
        if (!res.headersSent) res.writeHead((error as { code?: string }).code === 'ESONICPRIVATE' ? 403 : 502)
        res.end()
      })
      req.pipe(upstream)
    } catch {
      res.writeHead(403).end()
    }
  })

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const refuse = (status: string): void => { client.end(`HTTP/1.1 ${status}\r\n\r\n`) }
    client.on('error', () => client.destroy())
    if (!authorised(req)) return refuse('407 Proxy Authentication Required')
    let target: { host: string; port: number }
    try {
      target = splitHostPort(req.url ?? '', 443)
      refuseLiteral(target.host)
    } catch { return refuse('403 Forbidden') }
    const upstream = connect({ host: target.host, port: target.port, lookup: publicLookup }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', error => {
      if (!client.writable) return client.destroy()
      refuse((error as { code?: string }).code === 'ESONICPRIVATE' ? '403 Forbidden' : '502 Bad Gateway')
    })
    client.on('close', () => upstream.destroy())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Proxy failed to start.'))
      resolve(`http://${user}:${secret}@127.0.0.1:${address.port}`)
    })
  })
}

/**
 * Extra yt-dlp arguments for a link outside the named sites: every request
 * goes through the guarded proxy, and downloads stay in yt-dlp's own
 * networking, since an external downloader such as ffmpeg would bypass it.
 */
export async function guardedYtDlpArgs(provider: string | null): Promise<string[]> {
  if (provider !== 'direct' && provider !== 'generic') return []
  return ['--proxy', await guardedProxyUrl(), '--downloader', 'native']
}
