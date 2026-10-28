import { createHash, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'

export const BRIDGE_VERSION = '0.1.0'
export const PROTOCOL_VERSION = 1

/** Wrap Cordis' logger (or console) behind one small interface. */
export function createLogger(ctx) {
  try {
    if (ctx && typeof ctx.logger === 'function') {
      const logger = ctx.logger('dsh-remote')
      if (logger && typeof logger.info === 'function') return logger
    }
  } catch {
    // Fall back to console below.
  }
  const prefix = '[dsh-remote]'
  return {
    debug: (...args) => { if (process.env.DSH_REMOTE_DEBUG) console.debug(prefix, ...args) },
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  }
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Non-internal IPv4 (and optionally global IPv6) addresses, private LAN
 * ranges first so QR codes lead with the address a phone can reach.
 */
export function lanAddresses({ ipv6 = false } = {}) {
  const result = []
  for (const [ifname, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family === 'IPv4' || entry.family === 4) {
        if (entry.address.startsWith('169.254.')) continue
        result.push({ address: entry.address, family: 4, ifname })
      } else if (ipv6 && !entry.address.toLowerCase().startsWith('fe80')) {
        result.push({ address: entry.address, family: 6, ifname })
      }
    }
  }
  const rank = (a) => {
    if (a.family === 6) return 5
    if (a.address.startsWith('192.168.')) return 0
    if (a.address.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) return 2
    // Virtual adapters (Hyper-V, WSL, VPN, Docker) rank last among IPv4.
    if (/vethernet|wsl|docker|vmware|virtualbox|vbox|tailscale|zerotier|utun|tun|tap/i.test(a.ifname)) return 4
    return 3
  }
  return result.sort((a, b) => rank(a) - rank(b))
}

export function isLoopbackAddress(address) {
  if (!address) return false
  const a = address.replace(/^::ffff:/i, '')
  return a === '::1' || a.startsWith('127.')
}

export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export function sendText(res, status, text, headers = {}) {
  const payload = Buffer.from(text)
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export function sendHtml(res, status, html, headers = {}) {
  const payload = Buffer.from(html)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(payload)
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Read a small JSON request body. */
export async function readJson(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

export function parseCookies(header) {
  const cookies = {}
  if (typeof header !== 'string') return cookies
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return cookies
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
}

/** Fixed-window per-key failure limiter for pairing and token checks. */
export class FailureLimiter {
  constructor({ max, windowMs }) {
    this.max = max
    this.windowMs = windowMs
    this.entries = new Map()
  }

  blocked(key) {
    const entry = this.entries.get(key)
    if (!entry) return false
    if (Date.now() - entry.start > this.windowMs) {
      this.entries.delete(key)
      return false
    }
    return entry.count >= this.max
  }

  fail(key) {
    const now = Date.now()
    const entry = this.entries.get(key)
    if (!entry || now - entry.start > this.windowMs) this.entries.set(key, { start: now, count: 1 })
    else entry.count += 1
    if (this.entries.size > 10_000) this.entries.clear()
  }

  reset(key) {
    this.entries.delete(key)
  }
}

export function clientAddress(socket) {
  return (socket?.remoteAddress ?? '').replace(/^::ffff:/i, '')
}
