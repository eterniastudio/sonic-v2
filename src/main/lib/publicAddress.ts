import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/**
 * Address ranges a pasted link must never reach: the user's own machine, the
 * LAN, link-local and carrier-grade NAT space, and their IPv6 equivalents.
 * `isPublicHost` in shared/providers is only a paste-time check on the name;
 * this resolves the name, so a public-looking host pointing inward is refused.
 */
const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(network, prefix, 'ipv6')

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family !== 6) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return blocked.check(mapped[1], 'ipv4')
  return blocked.check(address, 'ipv6')
}

/** Throws unless every address the URL's host resolves to is public. */
export async function assertPublicUrl(input: string): Promise<void> {
  const url = new URL(input)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('This link points to a local or private network address, which Sonic does not download from.')
  }
}
