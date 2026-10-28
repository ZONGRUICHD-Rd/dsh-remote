import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { RemoteBridge } from '../src/server.js'
import { Upstream } from '../src/upstream.js'

export const LAUNCH_TOKEN = 'launch-token-123'
export const quietLogger = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * A stand-in for the DSH Web Host that enforces the same request policy:
 * loopback Host, same-authority Origin, and a cookie minted only by the
 * launch-token exchange on GET /.
 */
export async function startMockDsh() {
  const state = { cookieValue: 'good-1', requests: [], upgrades: [], exchanges: 0 }
  const server = http.createServer((req, res) => {
    const authority = `127.0.0.1:${server.address().port}`
    state.requests.push({ method: req.method, url: req.url, headers: req.headers })
    if (req.headers.host !== authority) { res.writeHead(403); res.end('bad host'); return }
    if (req.headers.origin && req.headers.origin !== `http://${authority}`) { res.writeHead(403); res.end('bad origin'); return }
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end('cross-site'); return }
    const url = new URL(req.url, `http://${authority}`)
    if (url.pathname === '/' && url.searchParams.get('token') === LAUNCH_TOKEN) {
      state.exchanges += 1
      res.writeHead(303, { location: './', 'set-cookie': `dsh-auth-abc=${state.cookieValue}; Max-Age=100; Path=/; HttpOnly; SameSite=Strict` })
      res.end()
      return
    }
    if (req.headers.cookie !== `dsh-auth-abc=${state.cookieValue}`) { res.writeHead(401); res.end('unauthorized'); return }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'leak=1' })
      res.end('<!doctype html><title>DSH</title><div id="root"></div>')
      return
    }
    if (url.pathname === '/api/echo') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers }))
      })
      return
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => { res.write('data: two\n\n'); res.end() }, 50)
      return
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: `http://${authority}/somewhere` })
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  const upgraded = new Set()
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    const authority = `127.0.0.1:${server.address().port}`
    state.upgrades.push({ url: req.url, headers: req.headers })
    if (req.headers.host !== authority || req.headers.cookie !== `dsh-auth-abc=${state.cookieValue}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)
    socket.on('data', d => socket.write(d)) // raw echo after the handshake
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { server, state, origin, close: () => new Promise(r => { for (const s of upgraded) s.destroy(); server.closeAllConnections(); server.close(r) }) }
}

export async function startBridge(mock, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
  const upstream = new Upstream({
    getOrigin: () => mock.origin,
    authenticatedUrl: (origin) => { const u = new URL(origin); u.searchParams.set('token', LAUNCH_TOKEN); return u.href },
    logger: quietLogger,
  })
  const config = { port: 0, adminPort: 0, bindHost: '127.0.0.1', tls: true, mdns: false, name: 'Test PC', stateDir, ...overrides }
  const bridge = new RemoteBridge({ config, stateDir, upstream, logger: quietLogger })
  await bridge.start()
  return { bridge, upstream, stateDir, close: async () => { await bridge.stop(); upstream.close() } }
}

/** Pinned TLS connection to the bridge, like the iOS app's tunnel. */
export function connectPinned(port, fingerprint) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    }, () => {
      const cert = socket.getPeerX509Certificate()
      const fp = createHash('sha256').update(cert.raw).digest('hex')
      if (fp !== fingerprint) { socket.destroy(); reject(new Error('fingerprint mismatch')); return }
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/** Send raw bytes and collect the reply until the socket closes or `until` matches. */
export function exchange(socket, payload, { until, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0)
    const timer = setTimeout(() => { cleanup(); resolve(data.toString('utf8')) }, timeoutMs)
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk])
      if (until && until(data.toString('utf8'))) { cleanup(); resolve(data.toString('utf8')) }
    }
    const onEnd = () => { cleanup(); resolve(data.toString('utf8')) }
    const onError = (e) => { cleanup(); reject(e) }
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('end', onEnd); socket.off('close', onEnd); socket.off('error', onError) }
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('close', onEnd)
    socket.on('error', onError)
    if (payload) socket.write(payload)
  })
}

/** HTTPS request to the bridge (certificate verification disabled; tests pin separately). */
export function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = (http.request)({
      createConnection: () => tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }),
      method, path, headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

export function adminRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}
