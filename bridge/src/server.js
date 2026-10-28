// The DSH Remote bridge: a LAN/internet-facing listener in front of the DSH
// Web Host plus a loopback-only admin page.
//
// Phone connections arrive in one of two shapes on the same port:
//  * Tunnel: the iOS app opens TLS (pinned certificate), writes one line
//    `DSHR/1 <deviceId> <token>\r\n`, then streams raw HTTP/WebSocket bytes
//    from its local WKWebView. No extra round trip: requests follow the line
//    immediately.
//  * Browser: plain HTTPS from any browser, authenticated by a device cookie
//    minted on the /__dsh_remote/login page with a pairing code.
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { join } from 'node:path'
import { loadOrCreateCertificate } from './cert.js'
import { DdnsUpdater } from './ddns.js'
import { MdnsAdvertiser } from './mdns.js'
import { PairingCodes } from './pairing.js'
import { qrSvg } from './qr.js'
import { publicSettings, StateStore } from './state.js'
import { UpnpMapper } from './upnp.js'
import { adminPageHtml, adminLockedHtml, loginPageHtml } from './pages.js'
import {
  BRIDGE_VERSION, clientAddress, FailureLimiter, HttpError, isLoopbackAddress, lanAddresses,
  parseCookies, PROTOCOL_VERSION, readJson, safeEqual, sendHtml, sendJson, sendText,
} from './util.js'

const PREAMBLE_MAGIC = Buffer.from('DSHR/1 ')
const DEVICE_COOKIE = 'dshr_device'
const ADMIN_COOKIE = 'dshr_admin'
const PREFIX = '/__dsh_remote/'

/**
 * Read an optional tunnel preamble without consuming HTTP bytes.
 * @returns {Promise<{ kind: 'http' } | { kind: 'tunnel', line: string } | { kind: 'invalid' }>}
 */
export function readPreamble(socket, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0)
    let done = false
    const finish = (result, rest) => {
      if (done) return
      done = true
      socket.off('readable', onReadable)
      socket.off('end', onEnd)
      socket.off('error', onEnd)
      clearTimeout(timer)
      if (rest && rest.length > 0) socket.unshift(rest)
      resolve(result)
    }
    const onEnd = () => finish({ kind: 'invalid' })
    const onReadable = () => {
      let chunk
      while (!done && (chunk = socket.read()) !== null) {
        buffered = Buffer.concat([buffered, chunk])
        const n = Math.min(buffered.length, PREAMBLE_MAGIC.length)
        if (!buffered.subarray(0, n).equals(PREAMBLE_MAGIC.subarray(0, n))) {
          finish({ kind: 'http' }, buffered)
          return
        }
        if (buffered.length < PREAMBLE_MAGIC.length) continue
        const newline = buffered.indexOf(0x0a)
        if (newline === -1) {
          if (buffered.length > 1024) finish({ kind: 'invalid' })
          continue
        }
        const line = buffered.subarray(0, newline).toString('utf8').replace(/\r$/, '')
        finish({ kind: 'tunnel', line }, buffered.subarray(newline + 1))
      }
    }
    const timer = setTimeout(() => finish({ kind: 'invalid' }), timeoutMs)
    timer.unref?.()
    socket.on('readable', onReadable)
    socket.once('end', onEnd)
    socket.once('error', onEnd)
    onReadable()
  })
}

function cookieHeader(name, value, { secure, maxAge, sameSite = 'Lax' }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

function isLoopbackHostHeader(host) {
  if (typeof host !== 'string') return false
  try {
    const { hostname } = new URL(`http://${host}`)
    return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
  } catch {
    return false
  }
}

export class RemoteBridge {
  /**
   * @param {object} options
   * @param {object} options.config - plugin config (initial defaults)
   * @param {string} options.stateDir - directory for state.json and TLS material
   * @param {import('./upstream.js').Upstream} options.upstream
   * @param {object} options.logger
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ config, stateDir, upstream, logger, fetchImpl = fetch }) {
    this.config = config
    this.stateDir = stateDir
    this.upstream = upstream
    this.logger = logger
    this.store = new StateStore(join(stateDir, 'state.json'), config, logger)
    this.pairing = new PairingCodes()
    this.pairLimiter = new FailureLimiter({ max: 10, windowMs: 10 * 60 * 1000 })
    this.authLimiter = new FailureLimiter({ max: 30, windowMs: 5 * 60 * 1000 })
    this.tunnelDevices = new WeakMap()
    this.listener = undefined
    this.adminServer = undefined
    this.mdns = undefined
    this.upnp = new UpnpMapper({ logger, fetchImpl })
    this.ddns = new DdnsUpdater({
      getSettings: () => this.store.settings,
      logger,
      fetchImpl,
      getUpnpExternalIp: () => (this.store.settings.upnp.enabled ? this.upnp.externalIp() : Promise.resolve(undefined)),
    })
    this.certificate = undefined
    this.listenError = undefined
    this.startedAt = Date.now()
    this.sockets = new Set()

    this.httpServer = http.createServer({ keepAliveTimeout: 65_000, headersTimeout: 30_000, requestTimeout: 0 })
    this.httpServer.on('request', (req, res) => this.#onRequest(req, res))
    this.httpServer.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head))
    this.httpServer.on('clientError', (_error, socket) => socket.destroy())
  }

  get settings() { return this.store.settings }
  get port() { return this.listener?.address()?.port ?? this.settings.port }
  get adminPort() { return this.adminServer?.address()?.port }
  get adminUrl() {
    return this.adminPort ? `http://127.0.0.1:${this.adminPort}/?token=${encodeURIComponent(this.store.adminToken)}` : undefined
  }

  async start() {
    await this.store.load()
    this.certificate = await loadOrCreateCertificate(join(this.stateDir, 'tls'), `${this.settings.name} DSH Remote`)
    if (this.certificate.created) this.logger.info(`generated TLS certificate ${this.certificate.fingerprint}`)
    await this.#startListener()
    await this.#startAdmin()
    this.#startMdns()
    await this.#startUpnp()
    this.ddns.start()
    this.logger.info(`admin page: ${this.adminUrl ?? '(unavailable)'}`)
  }

  async stop() {
    this.ddns.stop()
    this.mdns?.stop()
    this.mdns = undefined
    await this.upnp.stop()
    await this.#closeListener()
    const admin = this.adminServer
    this.adminServer = undefined
    if (admin) {
      const closed = new Promise(resolve => admin.close(() => resolve()))
      admin.closeAllConnections?.()
      await closed
    }
    this.httpServer.closeAllConnections?.()
    await this.store.flush()
  }

  // ── listeners ────────────────────────────────────────────────────────────

  async #startListener() {
    const { port, tls: useTls } = this.settings
    const onSocket = socket => this.#onSocket(socket)
    const server = useTls
      ? tls.createServer({
        key: this.certificate.keyPem,
        cert: this.certificate.certPem,
        ALPNProtocols: ['http/1.1'],
        minVersion: 'TLSv1.2',
      }, onSocket)
      : net.createServer(onSocket)
    if (useTls) server.on('tlsClientError', () => {})
    const host = this.config.bindHost ?? '0.0.0.0'
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ port, host }, () => { server.off('error', reject); resolve() })
      })
      server.on('error', error => this.logger.warn(`listener error: ${error.message}`))
      this.listener = server
      this.listenError = undefined
      this.logger.info(`listening on ${host}:${this.port} (${useTls ? 'TLS' : 'plain TCP'})`)
    } catch (error) {
      this.listenError = error.message
      this.logger.error(`cannot listen on ${host}:${port}: ${error.message}`)
    }
  }

  async #closeListener() {
    const server = this.listener
    this.listener = undefined
    if (!server) return
    const closed = new Promise(resolve => server.close(() => resolve()))
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await closed
  }

  async #startAdmin() {
    const adminPort = this.config.adminPort ?? 39091
    const server = http.createServer((req, res) => this.#onAdminRequest(req, res))
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ port: adminPort, host: '127.0.0.1' }, () => { server.off('error', reject); resolve() })
      })
      this.adminServer = server
    } catch (error) {
      this.logger.warn(`admin page unavailable on 127.0.0.1:${adminPort}: ${error.message}`)
    }
  }

  #startMdns() {
    this.mdns?.stop()
    this.mdns = undefined
    if (!this.settings.mdns || !this.listener) return
    try {
      this.mdns = new MdnsAdvertiser({
        name: this.settings.name,
        port: this.port,
        txt: {
          v: String(PROTOCOL_VERSION),
          id: this.store.hostId,
          tls: this.settings.tls ? '1' : '0',
          fp: this.settings.tls ? this.certificate.fingerprint.slice(0, 16) : '',
        },
        logger: this.logger,
      })
      this.mdns.start()
    } catch (error) {
      this.logger.warn(`mDNS failed: ${error.message}`)
    }
  }

  async #startUpnp() {
    await this.upnp.stop()
    const { upnp } = this.settings
    if (!upnp.enabled || !this.listener) return
    const lan = lanAddresses().find(a => a.family === 4)
    if (!lan) return
    // Run in the background: SSDP discovery must never delay startup.
    this.upnp.start({
      externalPort: upnp.externalPort ?? this.port,
      internalPort: this.port,
      internalClient: lan.address,
      leaseSeconds: upnp.leaseSeconds,
    }).catch(() => {})
  }

  async applySettings(patch) {
    const before = this.settings
    const after = await this.store.updateSettings(patch)
    if (before.port !== after.port || before.tls !== after.tls) {
      await this.#closeListener()
      await this.#startListener()
    }
    if (before.name !== after.name || before.mdns !== after.mdns || before.port !== after.port || before.tls !== after.tls) this.#startMdns()
    if (JSON.stringify(before.upnp) !== JSON.stringify(after.upnp) || before.port !== after.port) await this.#startUpnp()
    if (JSON.stringify(before.ddns) !== JSON.stringify(after.ddns)) {
      this.ddns.reset()
      this.ddns.start()
    }
    return after
  }

  // ── connection admission ─────────────────────────────────────────────────

  #onSocket(socket) {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30_000)
    socket.on('error', () => {})
    readPreamble(socket).then((result) => {
      if (result.kind === 'invalid') {
        socket.destroy()
        return
      }
      if (result.kind === 'tunnel') {
        const address = clientAddress(socket)
        if (this.authLimiter.blocked(address)) {
          socket.destroy()
          return
        }
        const [deviceId, token] = result.line.slice(PREAMBLE_MAGIC.length).trim().split(/\s+/)
        const device = this.store.authenticate(deviceId, token, address)
        if (!device) {
          this.authLimiter.fail(address)
          // Answer with a real HTTP 401 so the app can tell "revoked" from "unreachable".
          socket.end('HTTP/1.1 401 Unauthorized\r\nx-dsh-remote-error: device-revoked\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
          return
        }
        this.tunnelDevices.set(socket, device)
      }
      this.httpServer.emit('connection', socket)
    })
  }

  /** Device behind a request: tunnel socket, device cookie, or bearer token. */
  #deviceFor(req) {
    const tunnel = this.tunnelDevices.get(req.socket)
    if (tunnel) return this.store.devices.includes(tunnel) ? tunnel : undefined
    const address = clientAddress(req.socket)
    let credential = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
    const auth = req.headers.authorization
    if (!credential && typeof auth === 'string' && auth.startsWith('Bearer ')) credential = auth.slice(7).trim()
    if (!credential) return undefined
    const dot = credential.indexOf('.')
    if (dot === -1 || this.authLimiter.blocked(address)) return undefined
    const device = this.store.authenticate(credential.slice(0, dot), credential.slice(dot + 1), address)
    if (!device) this.authLimiter.fail(address)
    return device
  }

  // ── main listener HTTP ───────────────────────────────────────────────────

  #onRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://bridge.invalid')
    const device = this.#deviceFor(req)
    if (url.pathname.startsWith(PREFIX)) {
      this.#bridgeRoute(req, res, url, device).catch(error => this.#fail(res, error))
      return
    }
    if (!device) {
      const accept = String(req.headers.accept ?? '')
      if (req.method === 'GET' && accept.includes('text/html')) {
        res.writeHead(303, { location: `${PREFIX}login?next=${encodeURIComponent(url.pathname + url.search)}`, 'cache-control': 'no-store' })
        res.end()
      } else {
        sendJson(res, 401, { error: 'unauthorized' })
      }
      return
    }
    this.upstream.handle(req, res)
  }

  #onUpgrade(req, socket, head) {
    socket.on('error', () => {})
    const url = new URL(req.url ?? '/', 'http://bridge.invalid')
    const device = this.#deviceFor(req)
    if (!device || url.pathname.startsWith(PREFIX)) {
      socket.end(`HTTP/1.1 ${device ? '404 Not Found' : '401 Unauthorized'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
      return
    }
    this.upstream.upgrade(req, socket, head)
  }

  #fail(res, error) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (error instanceof HttpError) sendJson(res, error.status, { error: error.message })
    else {
      this.logger.warn(`request failed: ${error?.stack ?? error}`)
      sendJson(res, 500, { error: 'internal error' })
    }
  }

  async #bridgeRoute(req, res, url, device) {
    const path = url.pathname.slice(PREFIX.length)
    const secure = this.settings.tls
    if (path === 'info' && req.method === 'GET') {
      sendJson(res, 200, this.#info())
      return
    }
    if (path === 'pair' && req.method === 'POST') {
      const body = await readJson(req)
      const result = await this.#pair(req, body.code, body.deviceName)
      sendJson(res, 200, result)
      return
    }
    if (path === 'login') {
      if (req.method === 'GET') {
        sendHtml(res, 200, loginPageHtml({ name: this.settings.name, next: url.searchParams.get('next') ?? '/', error: undefined }))
        return
      }
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        const next = sanitizeNext(form.get('next'))
        try {
          const ua = String(req.headers['user-agent'] ?? '')
          const result = await this.#pair(req, form.get('code') ?? '', `Browser ${/iPhone|iPad/.test(ua) ? '(iOS)' : /Android/.test(ua) ? '(Android)' : ''}`.trim())
          res.writeHead(303, {
            location: next,
            'set-cookie': cookieHeader(DEVICE_COOKIE, `${result.deviceId}.${result.token}`, { secure, maxAge: 365 * 24 * 3600 }),
            'cache-control': 'no-store',
          })
          res.end()
        } catch (error) {
          sendHtml(res, error.status ?? 400, loginPageHtml({ name: this.settings.name, next, error: error.message }))
        }
        return
      }
    }
    if (path === 'logout') {
      res.writeHead(303, { location: `${PREFIX}login`, 'set-cookie': cookieHeader(DEVICE_COOKIE, '', { secure, maxAge: 0 }) })
      res.end()
      return
    }
    if (path.startsWith('api/')) {
      if (!device) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      await this.#api(req, res, path.slice(4), { device })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  }

  #info() {
    return {
      app: 'dsh-remote',
      protocol: PROTOCOL_VERSION,
      version: BRIDGE_VERSION,
      name: this.settings.name,
      hostId: this.store.hostId,
      tls: this.settings.tls,
      fingerprint: this.settings.tls ? this.certificate.fingerprint : undefined,
    }
  }

  async #pair(req, code, deviceName) {
    const address = clientAddress(req.socket)
    if (this.pairLimiter.blocked(address)) throw new HttpError(429, 'too many attempts, try again later')
    if (!this.pairing.consume(String(code ?? ''))) {
      this.pairLimiter.fail(address)
      throw new HttpError(403, 'invalid or expired pairing code')
    }
    this.pairLimiter.reset(address)
    const { device, token } = await this.store.addDevice(deviceName, address)
    this.logger.info(`paired device "${device.name}" from ${address}`)
    return {
      ...this.#info(),
      deviceId: device.id,
      token,
      port: this.port,
      lan: lanAddresses().map(a => a.address),
      remote: this.#publicEndpoint(),
    }
  }

  #publicEndpoint() {
    const { ddns, upnp } = this.settings
    const host = ddns.hostname || undefined
    const port = ddns.publicPort ?? (upnp.enabled ? upnp.externalPort ?? this.port : this.port)
    return { host, port, ip: this.ddns.status.publicIPv4 }
  }

  pairingInfo() {
    const { code, expiresAt } = this.pairing.get()
    const lan = lanAddresses().filter(a => a.family === 4).map(a => a.address)
    const remote = this.#publicEndpoint()
    const params = new URLSearchParams({
      v: String(PROTOCOL_VERSION),
      n: this.settings.name,
      id: this.store.hostId,
      h: lan.slice(0, 3).join(','),
      p: String(this.port),
      c: code,
      tls: this.settings.tls ? '1' : '0',
    })
    if (this.settings.tls) params.set('fp', this.certificate.fingerprint)
    if (remote.host) {
      params.set('r', remote.host)
      params.set('rp', String(remote.port))
    }
    const payload = `dshremote://pair?${params.toString()}`
    return { code, expiresAt, payload, qrSvg: qrSvg(payload, { level: 'L', scale: 5 }), lan, port: this.port, fingerprint: this.settings.tls ? this.certificate.fingerprint : undefined, remote }
  }

  status() {
    return {
      ...this.#info(),
      port: this.port,
      listening: Boolean(this.listener),
      listenError: this.listenError,
      lan: lanAddresses().map(a => ({ address: a.address, interface: a.ifname })),
      mdns: Boolean(this.mdns),
      upnp: this.upnp.status,
      ddns: { ...this.ddns.status },
      remote: this.#publicEndpoint(),
      devices: this.store.devices.length,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      adminPort: this.adminPort,
    }
  }

  async #api(req, res, path, { device, admin = false }) {
    const method = req.method
    if (path === 'ping' && method === 'GET') {
      sendJson(res, 200, { t: Date.now() })
      return
    }
    if (path === 'status' && method === 'GET') {
      sendJson(res, 200, { ...this.status(), upstream: await this.upstream.probe(), you: device ? { id: device.id, name: device.name } : undefined })
      return
    }
    if (path === 'settings') {
      if (method === 'GET') {
        sendJson(res, 200, publicSettings(this.settings))
        return
      }
      if (method === 'PUT' || method === 'PATCH') {
        const settings = await this.applySettings(await readJson(req))
        sendJson(res, 200, { settings: publicSettings(settings), status: this.status() })
        return
      }
    }
    if (path === 'ddns/update' && method === 'POST') {
      this.ddns.reset()
      sendJson(res, 200, await this.ddns.update({ force: true }))
      return
    }
    if (path === 'pairing' && method === 'GET') {
      sendJson(res, 200, this.pairingInfo())
      return
    }
    if (path === 'pairing/regenerate' && method === 'POST') {
      this.pairing.regenerate()
      sendJson(res, 200, this.pairingInfo())
      return
    }
    if (path === 'devices' && method === 'GET') {
      sendJson(res, 200, this.store.devices.map(d => ({
        id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, lastAddress: d.lastAddress, current: d.id === device?.id,
      })))
      return
    }
    const deviceMatch = /^devices\/([0-9a-f-]{36})$/.exec(path)
    if (deviceMatch && method === 'DELETE') {
      const removed = await this.store.removeDevice(deviceMatch[1])
      if (removed) this.#dropDeviceSockets(deviceMatch[1])
      sendJson(res, removed ? 200 : 404, { removed })
      return
    }
    if (path === 'admin-url' && method === 'GET' && admin) {
      sendJson(res, 200, { url: this.adminUrl })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  }

  #dropDeviceSockets(deviceId) {
    for (const socket of this.sockets) {
      if (this.tunnelDevices.get(socket)?.id === deviceId) socket.destroy()
    }
  }

  // ── loopback admin page ──────────────────────────────────────────────────

  #onAdminRequest(req, res) {
    const run = async () => {
      if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHostHeader(req.headers.host)) {
        sendText(res, 403, 'forbidden')
        return
      }
      const url = new URL(req.url ?? '/', 'http://admin.invalid')
      const token = url.searchParams.get('token')
      if (url.pathname === '/' && token) {
        if (!safeEqual(token, this.store.adminToken)) {
          sendHtml(res, 401, adminLockedHtml())
          return
        }
        res.writeHead(303, {
          location: '/',
          'set-cookie': cookieHeader(ADMIN_COOKIE, token, { secure: false, maxAge: 365 * 24 * 3600, sameSite: 'Strict' }),
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
      const authed = safeEqual(parseCookies(req.headers.cookie)[ADMIN_COOKIE] ?? '', this.store.adminToken)
      if (url.pathname === '/') {
        sendHtml(res, authed ? 200 : 401, authed ? adminPageHtml() : adminLockedHtml())
        return
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authed) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        if (req.method !== 'GET') {
          const origin = req.headers.origin
          if (origin !== undefined && origin !== `http://${req.headers.host}`) {
            sendJson(res, 403, { error: 'cross-origin request refused' })
            return
          }
        }
        await this.#api(req, res, url.pathname.slice(5), { admin: true })
        return
      }
      sendText(res, 404, 'not found')
    }
    run().catch(error => this.#fail(res, error))
  }
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sanitizeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith(PREFIX)) return '/'
  return next
}
