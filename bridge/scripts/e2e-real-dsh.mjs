// End-to-end check against a real `dsh web` with this plugin installed.
// Env: DSH_HOME (required), BRIDGE_PORT (39090), ADMIN_PORT (39091).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { adminRequest, connectPinned, exchange, request } from '../test/helpers.js'

const home = process.env.DSH_HOME
const port = Number(process.env.BRIDGE_PORT ?? 39090)
const adminPort = Number(process.env.ADMIN_PORT ?? 39091)
assert.ok(home, 'DSH_HOME must be set')

async function waitFor(what, fn, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`timed out waiting for ${what}: ${lastError?.message ?? 'no result'}`)
}

const state = await waitFor('bridge state', async () => JSON.parse(await readFile(join(home, 'dsh-remote', 'state.json'), 'utf8')))
const cookie = await waitFor('admin page', async () => {
  const res = await adminRequest(adminPort, { path: `/?token=${state.adminToken}` })
  return res.status === 303 ? res.headers['set-cookie'][0].split(';')[0] : undefined
})
const status = await waitFor('DSH upstream', async () => {
  const s = JSON.parse((await adminRequest(adminPort, { path: '/api/status', headers: { cookie } })).body)
  return s.upstream?.ok ? s : undefined
}, 60_000)
console.log('bridge status:', JSON.stringify({ name: status.name, port: status.port, upstream: status.upstream }))

const pairing = JSON.parse((await adminRequest(adminPort, { path: '/api/pairing', headers: { cookie } })).body)
const paired = await request(port, { method: 'POST', path: '/__dsh_remote/pair', body: { code: pairing.code, deviceName: 'CI' } })
assert.equal(paired.status, 200, paired.body)
const device = JSON.parse(paired.body)
const preamble = `DSHR/1 ${device.deviceId} ${device.token}\r\n`

// 1. The real DSH index through the tunnel.
let socket = await connectPinned(port, pairing.fingerprint)
const index = await exchange(socket, `${preamble}GET / HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nAccept: text/html\r\nConnection: close\r\n\r\n`, { timeoutMs: 15_000 })
console.log(index.slice(0, 600))
assert.match(index, /^HTTP\/1\.1 200/, 'DSH index must load through the bridge')
assert.match(index, /<html|<!doctype/i)

// 2. A module script the page references (client bundles, plugin bundles).
const scripts = [...index.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+\.(?:js|css))"/g)]
  .map(m => m[1])
  .filter(src => !/^[a-z]+:/i.test(src))
  .map(src => new URL(src, 'http://x/').pathname)
if (scripts.length === 0) console.log('index tail:', index.slice(-1500))
assert.ok(scripts.length > 0, 'the DSH index must reference client bundles')
console.log('scripts:', scripts.slice(0, 5))
{
  socket = await connectPinned(port, pairing.fingerprint)
  const asset = await exchange(socket, `${preamble}GET ${scripts[0]} HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nConnection: close\r\n\r\n`, { timeoutMs: 15_000, until: s => /^HTTP\/1\.1 \d{3}/.test(s) && s.includes('\r\n\r\n') })
  assert.match(asset, /^HTTP\/1\.1 200/, `asset ${scripts[0]} must load`)
}

// 3. The Remote API WebSocket (live sessions, streaming thinking/tool events).
socket = await connectPinned(port, pairing.fingerprint)
const ws = await exchange(socket, `${preamble}GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nOrigin: http://127.0.0.1:41000\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`, { timeoutMs: 15_000, until: s => s.includes('\r\n\r\n') })
console.log(ws.split('\r\n')[0])
assert.match(ws, /^HTTP\/1\.1 101/, 'Remote API WebSocket must upgrade through the bridge')
socket.destroy()

// 4. Unauthenticated access is refused.
const anonymous = await request(port, { path: '/', headers: { accept: 'text/html' } })
assert.equal(anonymous.status, 303)

console.log('E2E OK: DSH UI, assets and live API stream reachable through DSH Remote bridge')
process.exit(0)
