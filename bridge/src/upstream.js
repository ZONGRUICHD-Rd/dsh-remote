// Proxy authenticated phone traffic to the DSH Web Host on loopback.
//
// DSH's /api route only admits requests whose Host is loopback and whose
// browser cookie was minted from the process launch token. The bridge runs
// inside the DSH process, so it reads that token via
// `ctx.connection.authenticatedUrl()`, exchanges it for the cookie once, and
// presents the request to DSH as if it came from a local browser tab. The
// phone never sees the DSH cookie or token.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection',
])

/** Request headers the bridge owns or that would leak phone-side identity to DSH. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'cookie', 'authorization', 'host', 'origin', 'referer',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
])

export class Upstream {
  /**
   * @param {object} options
   * @param {() => string} options.getOrigin - DSH listener origin, e.g. http://127.0.0.1:53211
   * @param {(origin: string) => string} options.authenticatedUrl - origin + launch token
   * @param {object} options.logger
   */
  constructor({ getOrigin, authenticatedUrl, logger }) {
    this.getOrigin = getOrigin
    this.authenticatedUrl = authenticatedUrl
    this.logger = logger
    this.cookie = undefined
    this.cookieOrigin = undefined
    this.pending = undefined
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256, keepAliveMsecs: 15_000 })
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256, rejectUnauthorized: false })
  }

  origin() {
    return new URL(this.getOrigin())
  }

  /** Exchange the launch token for the DSH browser cookie (deduplicated). */
  async ensureCookie(force = false) {
    const origin = this.getOrigin()
    if (!force && this.cookie && this.cookieOrigin === origin) return this.cookie
    if (this.pending) return this.pending
    this.pending = this.#acquire(origin).finally(() => { this.pending = undefined })
    return this.pending
  }

  async #acquire(origin) {
    const target = new URL(this.authenticatedUrl(origin))
    const transport = target.protocol === 'https:' ? https : http
    const setCookies = await new Promise((resolve, reject) => {
      const req = transport.request(target, {
        method: 'GET',
        agent: false,
        rejectUnauthorized: false,
        headers: { accept: 'text/html', host: target.host },
        timeout: 10_000,
      }, (res) => {
        res.resume()
        if (res.statusCode !== 302 && res.statusCode !== 303) {
          reject(new Error(`DSH launch-token exchange answered ${res.statusCode}`))
          return
        }
        resolve(res.headers['set-cookie'] ?? [])
      })
      req.on('timeout', () => req.destroy(new Error('DSH launch-token exchange timed out')))
      req.on('error', reject)
      req.end()
    })
    const pair = setCookies.map(c => c.split(';')[0].trim()).find(c => c.startsWith('dsh-auth-')) ?? setCookies.map(c => c.split(';')[0].trim())[0]
    if (!pair) throw new Error('DSH launch-token exchange returned no cookie')
    this.cookie = pair
    this.cookieOrigin = origin
    this.logger.debug?.('acquired DSH browser session cookie')
    return pair
  }

  /** Build the header set DSH sees for one proxied request. */
  #upstreamHeaders(req, origin, cookie, { upgrade = false } = {}) {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (STRIPPED_REQUEST_HEADERS.has(name)) continue
      if (!upgrade && HOP_BY_HOP.has(name)) continue
      if (name.startsWith('x-dsh-remote-')) continue
      headers[name] = value
    }
    headers.host = origin.host
    if (req.headers.origin) headers.origin = origin.origin
    if (req.headers.referer) {
      try {
        const ref = new URL(req.headers.referer)
        headers.referer = `${origin.origin}${ref.pathname}${ref.search}`
      } catch {
        // Drop an unparsable referer.
      }
    }
    if (req.headers['sec-fetch-mode']) {
      headers['sec-fetch-site'] = 'same-origin'
      headers['sec-fetch-mode'] = req.headers['sec-fetch-mode']
      if (req.headers['sec-fetch-dest']) headers['sec-fetch-dest'] = req.headers['sec-fetch-dest']
    }
    headers.cookie = cookie
    return headers
  }

  #rewriteResponseHeaders(headers, origin) {
    const out = {}
    for (const [name, value] of Object.entries(headers)) {
      if (HOP_BY_HOP.has(name) || name === 'set-cookie') continue
      out[name] = value
    }
    if (typeof out.location === 'string' && out.location.startsWith(origin.origin)) {
      out.location = out.location.slice(origin.origin.length) || '/'
    }
    return out
  }

  /** Forward one HTTP request; retries once with a fresh cookie on 401 for bodyless methods. */
  async handle(req, res) {
    let origin
    let cookie
    try {
      origin = this.origin()
      cookie = await this.ensureCookie()
    } catch (error) {
      this.logger.warn(`DSH host unavailable: ${error.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2' })
        res.end('DSH host is not ready yet')
      }
      return
    }
    const bodyless = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
    const attempt = (cookieValue, retry) => {
      const transport = origin.protocol === 'https:' ? https : http
      const upstreamReq = transport.request({
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port,
        method: req.method,
        path: req.url,
        headers: this.#upstreamHeaders(req, origin, cookieValue),
        agent: origin.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
        rejectUnauthorized: false,
      })
      upstreamReq.on('socket', s => s.setNoDelay?.(true))
      upstreamReq.on('response', (upstreamRes) => {
        if (upstreamRes.statusCode === 401 && retry && bodyless) {
          upstreamRes.resume()
          this.ensureCookie(true).then(fresh => attempt(fresh, false), (error) => {
            this.logger.warn(`DSH re-authentication failed: ${error.message}`)
            if (!res.headersSent) { res.writeHead(502); res.end('DSH re-authentication failed') }
          })
          return
        }
        if (upstreamRes.statusCode === 401) this.cookie = undefined
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, this.#rewriteResponseHeaders(upstreamRes.headers, origin))
        // Stream immediately: SSE and chunked RPC responses must not buffer.
        res.flushHeaders?.()
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => res.destroy())
      })
      upstreamReq.on('error', (error) => {
        this.logger.debug?.(`upstream request failed: ${error.message}`)
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('DSH host connection failed')
        } else {
          res.destroy()
        }
      })
      res.on('close', () => { if (!res.writableFinished) upstreamReq.destroy() })
      if (bodyless) upstreamReq.end()
      else req.pipe(upstreamReq)
    }
    attempt(cookie, true)
  }

  /** Forward a WebSocket upgrade as a raw byte pipe after rewriting the handshake. */
  async upgrade(req, socket, head) {
    let origin
    let cookie
    try {
      origin = this.origin()
      cookie = await this.ensureCookie()
    } catch (error) {
      this.logger.warn(`DSH host unavailable for WebSocket: ${error.message}`)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    const headers = this.#upstreamHeaders(req, origin, cookie, { upgrade: true })
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`)
    }
    const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80))
    const upstream = origin.protocol === 'https:'
      ? tls.connect({ host: origin.hostname, port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host: origin.hostname, port })
    upstream.setNoDelay(true)
    socket.setNoDelay?.(true)
    socket.setTimeout?.(0)
    const onConnect = () => {
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    }
    upstream.once(origin.protocol === 'https:' ? 'secureConnect' : 'connect', onConnect)
    const close = () => { upstream.destroy(); socket.destroy() }
    upstream.on('error', close)
    socket.on('error', close)
    upstream.on('close', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  }

  async probe() {
    try {
      await this.ensureCookie()
      return { ok: true, origin: this.getOrigin() }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  close() {
    this.httpAgent.destroy()
    this.httpsAgent.destroy()
  }
}
