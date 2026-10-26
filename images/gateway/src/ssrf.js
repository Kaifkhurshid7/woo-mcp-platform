import dns from 'node:dns/promises';
import net from 'node:net';

// SSRF guard for admin-supplied upstream URLs.
//
// Upstream servers legitimately live on cluster-internal addresses (ClusterIP Services resolve to
// private ranges), so private ranges are allowed by default. What is always refused: loopback (the
// gateway itself, unless ALLOW_LOOPBACK_UPSTREAMS=true for local development), link-local (cloud metadata at 169.254.169.254 and friends), unspecified and
// multicast addresses, and well-known metadata hostnames. Set ALLOW_PRIVATE_UPSTREAMS=false in
// deployments where upstreams are only ever public HTTPS endpoints.

const ALWAYS_BLOCKED_V4 = [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const PRIVATE_V4 = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
];
const ALWAYS_BLOCKED_V6 = [
  ['::', 128],
  ['fe80::', 10],
  ['ff00::', 8],
  ['fd00:ec2::', 32], // AWS IMDS over IPv6
];
const PRIVATE_V6 = [['fc00::', 7]];
const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);

function list(v4, v6) {
  const bl = new net.BlockList();
  for (const [a, p] of v4) bl.addSubnet(a, p, 'ipv4');
  for (const [a, p] of v6) bl.addSubnet(a, p, 'ipv6');
  return bl;
}
const always = list(ALWAYS_BLOCKED_V4, ALWAYS_BLOCKED_V6);
const loopback = list([['127.0.0.0', 8]], [['::1', 128]]);
const priv = list(PRIVATE_V4, PRIVATE_V6);

function checkAddress(addr, allowPrivate, allowLoopback) {
  let ip = addr;
  let family = net.isIP(ip);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) {
    ip = mapped[1];
    family = 4;
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (!allowLoopback && loopback.check(ip, type)) return `address ${addr} is loopback (the gateway itself)`;
  if (always.check(ip, type)) return `address ${addr} is loopback, link-local, metadata or otherwise reserved`;
  if (!allowPrivate && priv.check(ip, type)) return `address ${addr} is in a private range and ALLOW_PRIVATE_UPSTREAMS is false`;
  return null;
}

export class UnsafeUrlError extends Error {}

/** Throws UnsafeUrlError if the URL must not be used as an upstream. Returns the parsed URL. */
export async function assertSafeUpstreamUrl(urlStr, { allowPrivate = true, allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new UnsafeUrlError('Not a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UnsafeUrlError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new UnsafeUrlError('Credentials must not be embedded in the URL; use the credential field');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (METADATA_HOSTS.has(host)) throw new UnsafeUrlError('Metadata hostnames are not allowed');

  if (net.isIP(host)) {
    const bad = checkAddress(host, allowPrivate, allowLoopback);
    if (bad) throw new UnsafeUrlError(bad);
    return url;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    // Unresolvable hosts are not a safety problem; the health check will report them as unreachable.
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return url;
    throw new UnsafeUrlError(`DNS lookup failed: ${e.message}`);
  }
  for (const a of addrs) {
    const bad = checkAddress(a.address, allowPrivate, allowLoopback);
    if (bad) throw new UnsafeUrlError(`${host} resolves to a blocked address: ${bad}`);
  }
  return url;
}
