import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { adminRequest, connectPinned, exchange, request, startBridge, startMockDsh } from './helpers.js'

describe('bridge', () => {
  let mock
  let env
  let fingerprint
  let port
  let device

  before(async () => {
    mock = await startMockDsh()
    env = await startBridge(mock)
    port = env.bridge.port
    fingerprint = env.bridge.certificate.fingerprint
  })
  after(async () => {
    await env.close()
    await mock.close()
  })

  test('public info exposes the pinned fingerprint', async () => {
    const res = await request(port, { path: '/__dsh_remote/info' })
    assert.equal(res.status, 200)
    const info = JSON.parse(res.body)
    assert.equal(info.app, 'dsh-remote')
    assert.equal(info.fingerprint, fingerprint)
    assert.equal(info.name, 'Test PC')
  })

  test('pairing rejects a wrong code and accepts the current one once', async () => {
    const bad = await request(port, { method: 'POST', path: '/__dsh_remote/pair', body: { code: '000000x', deviceName: 'x' } })
    assert.equal(bad.status, 403)
    const { code } = env.bridge.pairingInfo()
    const ok = await request(port, { method: 'POST', path: '/__dsh_remote/pair', body: { code, deviceName: 'Test iPhone' } })
    assert.equal(ok.status, 200)
    device = JSON.parse(ok.body)
    assert.ok(device.deviceId && device.token.length >= 32)
    assert.equal(device.fingerprint, fingerprint)
    const reuse = await request(port, { method: 'POST', path: '/__dsh_remote/pair', body: { code, deviceName: 'again' } })
    assert.equal(reuse.status, 403)
  })

  test('tunnel: preamble and pipelined request reach DSH as a loopback browser', async () => {
    const socket = await connectPinned(port, fingerprint)
    const reply = await exchange(socket,
      `DSHR/1 ${device.deviceId} ${device.token}\r\nGET / HTTP/1.1\r\nHost: 127.0.0.1:47123\r\nAccept: text/html\r\nCookie: phone=1\r\n\r\n`,
      { until: s => s.includes('</div>') })
    socket.destroy()
    assert.match(reply, /^HTTP\/1\.1 200/)
    assert.match(reply, /<title>DSH<\/title>/)
    assert.doesNotMatch(reply, /set-cookie/i, 'upstream cookies never reach the phone')
    const seen = mock.state.requests.at(-1)
    assert.equal(seen.headers.host, new URL(mock.origin).host)
    assert.equal(seen.headers.cookie, `dsh-auth-abc=${mock.state.cookieValue}`)
  })

  test('tunnel: split preamble, keep-alive, POST body and Origin rewrite', async () => {
    const socket = await connectPinned(port, fingerprint)
    socket.write('DSHR/1 ')
    await new Promise(r => setTimeout(r, 30))
    socket.write(`${device.deviceId} ${device.token}\r\n`)
    const body = JSON.stringify({ hello: 'world' })
    const first = await exchange(socket,
      `POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1:47123\r\nOrigin: http://127.0.0.1:47123\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      { until: s => s.includes('"hello') && s.endsWith('0\r\n\r\n') })
    assert.match(first, /^HTTP\/1\.1 200/)
    const echoed = JSON.parse(first.slice(first.indexOf('\r\n\r\n') + 4).replace(/^[0-9a-f]+\r\n/, '').replace(/\r\n0\r\n\r\n$/, '').trim())
    assert.equal(echoed.body, body)
    assert.equal(echoed.headers.origin, mock.origin)
    // Second request on the same tunnel connection.
    const second = await exchange(socket, 'GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:47123\r\n\r\n', { until: s => s.includes('data: two') })
    assert.match(second, /text\/event-stream/)
    assert.match(second, /data: one[\s\S]*data: two/)
    socket.destroy()
  })

  test('tunnel: redirects to the upstream origin become relative', async () => {
    const socket = await connectPinned(port, fingerprint)
    const reply = await exchange(socket, `DSHR/1 ${device.deviceId} ${device.token}\r\nGET /redirect HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
    assert.match(reply, /location: \/somewhere/i)
  })

  test('tunnel: WebSocket upgrade is piped to DSH', async () => {
    const socket = await connectPinned(port, fingerprint)
    const handshake = await exchange(socket,
      `DSHR/1 ${device.deviceId} ${device.token}\r\nGET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:47123\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:47123\r\n\r\n`,
      { until: s => s.includes('\r\n\r\n') })
    assert.match(handshake, /^HTTP\/1\.1 101/)
    assert.match(handshake, /s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/)
    const echo = await exchange(socket, 'ping-bytes', { until: s => s.includes('ping-bytes') })
    assert.equal(echo, 'ping-bytes')
    assert.equal(mock.state.upgrades.at(-1).headers.origin, mock.origin)
    socket.destroy()
  })

  test('tunnel with a bad token answers 401 and closes', async () => {
    const socket = await connectPinned(port, fingerprint)
    const reply = await exchange(socket, `DSHR/1 ${device.deviceId} wrong-token-wrong-token\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n`)
    assert.match(reply, /^HTTP\/1\.1 401/)
    assert.match(reply, /device-revoked/)
  })

  test('unauthenticated browsers are sent to the login page; API answers 401', async () => {
    const page = await request(port, { path: '/', headers: { accept: 'text/html' } })
    assert.equal(page.status, 303)
    assert.match(page.headers.location, /^\/__dsh_remote\/login\?next=/)
    const api = await request(port, { path: '/api/echo' })
    assert.equal(api.status, 401)
    const ws = await request(port, { path: '/api/remote.mux', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'x', 'sec-websocket-version': '13' } }).catch(e => e)
    assert.ok(ws instanceof Error || ws.status === 401)
  })

  test('browser login with a pairing code sets a device cookie', async () => {
    const { code } = env.bridge.pairingInfo()
    const login = await request(port, {
      method: 'POST',
      path: '/__dsh_remote/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${code}&next=%2Fapi%2Fecho`,
    })
    assert.equal(login.status, 303)
    assert.equal(login.headers.location, '/api/echo')
    const cookie = login.headers['set-cookie'][0].split(';')[0]
    assert.match(login.headers['set-cookie'][0], /HttpOnly/)
    assert.match(login.headers['set-cookie'][0], /Secure/)
    const res = await request(port, { path: '/api/echo', headers: { cookie } })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).headers.cookie, `dsh-auth-abc=${mock.state.cookieValue}`)
  })

  test('bearer API: status, settings with secret masking, devices', async () => {
    const auth = { authorization: `Bearer ${device.deviceId}.${device.token}` }
    const status = await request(port, { path: '/__dsh_remote/api/status', headers: auth })
    assert.equal(status.status, 200)
    assert.equal(JSON.parse(status.body).upstream.ok, true)
    const put = await request(port, {
      method: 'PUT',
      path: '/__dsh_remote/api/settings',
      headers: { ...auth, 'content-type': 'application/json' },
      body: { ddns: { enabled: false, provider: 'duckdns', hostname: 'myhome.duckdns.org', options: { domains: 'myhome', token: 'secret-token' } } },
    })
    assert.equal(put.status, 200)
    const settings = JSON.parse((await request(port, { path: '/__dsh_remote/api/settings', headers: auth })).body)
    assert.equal(settings.ddns.hostname, 'myhome.duckdns.org')
    assert.equal(settings.ddns.options.token, '__dsh_remote_secret_unchanged__')
    assert.equal(env.bridge.settings.ddns.options.token, 'secret-token')
    // Re-saving the placeholder keeps the stored secret.
    await request(port, { method: 'PUT', path: '/__dsh_remote/api/settings', headers: auth, body: { ddns: { options: settings.ddns.options } } })
    assert.equal(env.bridge.settings.ddns.options.token, 'secret-token')
    const bad = await request(port, { method: 'PUT', path: '/__dsh_remote/api/settings', headers: auth, body: { port: 70000 } })
    assert.equal(bad.status, 400)
    const devices = JSON.parse((await request(port, { path: '/__dsh_remote/api/devices', headers: auth })).body)
    assert.ok(devices.some(d => d.id === device.deviceId && d.current))
  })

  test('DSH cookie rotation is recovered transparently', async () => {
    const before = mock.state.exchanges
    mock.state.cookieValue = 'good-2'
    const socket = await connectPinned(port, fingerprint)
    const reply = await exchange(socket, `DSHR/1 ${device.deviceId} ${device.token}\r\nGET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
    assert.match(reply, /^HTTP\/1\.1 200/)
    assert.equal(mock.state.exchanges, before + 1)
  })

  test('admin page: loopback Host + token cookie, CSRF origin check', async () => {
    const adminPort = env.bridge.adminPort
    const locked = await adminRequest(adminPort, { path: '/' })
    assert.equal(locked.status, 401)
    const rebinding = await adminRequest(adminPort, { path: '/api/status', headers: { host: 'evil.example:80' } })
    assert.equal(rebinding.status, 403)
    const token = new URL(env.bridge.adminUrl).searchParams.get('token')
    const enter = await adminRequest(adminPort, { path: `/?token=${token}` })
    assert.equal(enter.status, 303)
    const cookie = enter.headers['set-cookie'][0].split(';')[0]
    const page = await adminRequest(adminPort, { path: '/', headers: { cookie } })
    assert.equal(page.status, 200)
    assert.match(page.body, /DSH Remote/)
    const pairing = JSON.parse((await adminRequest(adminPort, { path: '/api/pairing', headers: { cookie } })).body)
    assert.match(pairing.payload, /^dshremote:\/\/pair\?/)
    assert.match(pairing.qrSvg, /^<svg/)
    const csrf = await adminRequest(adminPort, { method: 'POST', path: '/api/pairing/regenerate', headers: { cookie, origin: 'http://evil.example' } })
    assert.equal(csrf.status, 403)
    const regen = await adminRequest(adminPort, { method: 'POST', path: '/api/pairing/regenerate', headers: { cookie, origin: `http://127.0.0.1:${adminPort}` } })
    assert.equal(regen.status, 200)
  })

  test('revoking a device closes its tunnels and rejects new ones', async () => {
    const { code } = env.bridge.pairingInfo()
    const second = JSON.parse((await request(port, { method: 'POST', path: '/__dsh_remote/pair', body: { code, deviceName: 'Old phone' } })).body)
    const socket = await connectPinned(port, fingerprint)
    await exchange(socket, `DSHR/1 ${second.deviceId} ${second.token}\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n`, { until: s => s.includes('</div>') })
    const closed = new Promise(resolve => socket.once('close', resolve))
    const auth = { authorization: `Bearer ${device.deviceId}.${device.token}` }
    const del = await request(port, { method: 'DELETE', path: `/__dsh_remote/api/devices/${second.deviceId}`, headers: auth })
    assert.equal(del.status, 200)
    await closed
    const again = await connectPinned(port, fingerprint)
    const reply = await exchange(again, `DSHR/1 ${second.deviceId} ${second.token}\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n`)
    assert.match(reply, /^HTTP\/1\.1 401/)
  })
})

describe('bridge without TLS', () => {
  test('plain TCP tunnel works when TLS is disabled', async () => {
    const mock = await startMockDsh()
    const env = await startBridge(mock, { tls: false })
    try {
      const { code } = env.bridge.pairingInfo()
      const net = await import('node:net')
      const pairSocket = net.connect(env.bridge.port, '127.0.0.1')
      const body = JSON.stringify({ code, deviceName: 'plain' })
      const pairReply = await exchange(pairSocket, `POST /__dsh_remote/pair HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
      const device = JSON.parse(pairReply.slice(pairReply.indexOf('\r\n\r\n') + 4))
      const socket = net.connect(env.bridge.port, '127.0.0.1')
      const reply = await exchange(socket, `DSHR/1 ${device.deviceId} ${device.token}\r\nGET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
      assert.match(reply, /^HTTP\/1\.1 200/)
    } finally {
      await env.close()
      await mock.close()
    }
  })
})
