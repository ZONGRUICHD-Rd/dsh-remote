import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { certificateFingerprint, createSelfSignedCertificate, loadOrCreateCertificate } from '../src/cert.js'
import { aliyunSignedUrl, DdnsUpdater, PROVIDERS } from '../src/ddns.js'
import * as plugin from '../src/index.js'
import { buildResponse, MdnsAdvertiser, parseQuery, SERVICE_TYPE } from '../src/mdns.js'
import { PairingCodes } from '../src/pairing.js'
import { encodeQr, qrSvg } from '../src/qr.js'
import { readPreamble } from '../src/server.js'
import { defaultSettings, mergeSettings, publicSettings, SECRET_PLACEHOLDER } from '../src/state.js'
import { findControlUrl } from '../src/upnp.js'
import { quietLogger, startMockDsh } from './helpers.js'

describe('certificate', () => {
  test('self-signed certificate verifies and fingerprints stably', () => {
    const { certPem, keyPem } = createSelfSignedCertificate({ commonName: 'pc', ipAddresses: ['192.168.1.2'] })
    const cert = new X509Certificate(certPem)
    assert.ok(cert.verify(cert.publicKey))
    assert.match(cert.subjectAltName, /IP Address:192\.168\.1\.2/)
    assert.match(keyPem, /BEGIN PRIVATE KEY/)
    assert.match(certificateFingerprint(certPem), /^[0-9a-f]{64}$/)
  })

  test('certificate is persisted and reused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshr-cert-'))
    const first = await loadOrCreateCertificate(dir, 'pc')
    const second = await loadOrCreateCertificate(dir, 'pc')
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(first.fingerprint, second.fingerprint)
  })
})

/** Read the 15 format bits from the first copy around the top-left finder. */
function readFormat(modules) {
  const bits = []
  for (let i = 0; i <= 5; i++) bits.push(modules[i][8])
  bits.push(modules[7][8], modules[8][8], modules[8][7])
  for (let i = 9; i < 15; i++) bits.push(modules[8][14 - i])
  return bits.reduce((acc, bit, i) => acc | ((bit ? 1 : 0) << i), 0)
}

function bchFormat(data) {
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

describe('qr', () => {
  for (const [text, level] of [['hello', 'M'], ['dshremote://pair?v=1&n=PC&id=0f8c&h=192.168.1.10,10.0.0.5&p=39090&c=123456&tls=1&fp=' + 'ab'.repeat(32), 'L'], ['x'.repeat(400), 'L']]) {
    test(`structure is valid for ${text.length} bytes at ${level}`, () => {
      const { size, version, mask, modules } = encodeQr(text, level)
      assert.equal(size, version * 4 + 17)
      // Finder pattern corners and centers.
      for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
        assert.equal(modules[y][x], true)
        assert.equal(modules[y + 3][x + 3], true)
        assert.equal(modules[y + 1][x + 1], false)
      }
      // Timing patterns alternate.
      for (let i = 8; i < size - 8; i++) {
        assert.equal(modules[6][i], i % 2 === 0)
        assert.equal(modules[i][6], i % 2 === 0)
      }
      // Format information is a valid BCH codeword with the chosen level and mask.
      const levelBits = { L: 1, M: 0, Q: 3, H: 2 }[level]
      assert.equal(readFormat(modules), bchFormat((levelBits << 3) | mask))
      assert.equal(modules[size - 8][8], true, 'dark module')
    })
  }
  test('svg renders', () => {
    assert.match(qrSvg('abc'), /^<svg[^>]+viewBox="0 0 29 29"/)
  })
})

describe('mdns', () => {
  test('answers PTR/SRV/TXT/A for the service', () => {
    const adv = new MdnsAdvertiser({ name: 'My PC', port: 39090, txt: { v: '1', id: 'abc' }, logger: quietLogger })
    const query = buildResponse({ answers: [], questions: [{ name: SERVICE_TYPE, type: 12 }] })
    // Turn the built packet into a query (clear the response flag).
    query.writeUInt16BE(0, 2)
    const parsed = parseQuery(query)
    assert.equal(parsed.isResponse, false)
    assert.equal(parsed.questions[0].name, SERVICE_TYPE)
    const { answers, additionals } = adv.answersFor(parsed.questions)
    assert.equal(answers.length, 1)
    assert.ok(additionals.length >= 2)
    const packet = buildResponse({ answers, additionals })
    assert.ok(packet.includes(Buffer.from('_dshremote')))
    assert.ok(packet.includes(Buffer.from('id=abc')))
    assert.ok(packet.includes(Buffer.from('My PC')))
    assert.equal(adv.answersFor([{ name: 'other.local', type: 1 }]).answers.length, 0)
  })
})

describe('ddns', () => {
  const fakeFetch = (handler) => {
    const calls = []
    const impl = async (url, init = {}) => {
      calls.push({ url: String(url), init })
      const { status = 200, body } = await handler(String(url), init)
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    }
    return { impl, calls }
  }

  test('duckdns', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: 'OK' }))
    await PROVIDERS.duckdns({ ip: '1.2.3.4', type: 'A', options: { domains: 'home.duckdns.org', token: 't' }, fetchImpl: impl })
    assert.match(calls[0].url, /domains=home&token=t&ip=1\.2\.3\.4/)
    const bad = fakeFetch(() => ({ body: 'KO' }))
    await assert.rejects(PROVIDERS.duckdns({ ip: '1.2.3.4', type: 'A', options: { domains: 'h', token: 't' }, fetchImpl: bad.impl }), /KO/)
  })

  test('cloudflare updates an existing record', async () => {
    const { impl, calls } = fakeFetch((url, init) => {
      if (url.includes('/zones?name=')) return { body: { success: true, result: [{ id: 'z1' }] } }
      if (url.includes('/dns_records?')) return { body: { success: true, result: [{ id: 'r1', content: '9.9.9.9' }] } }
      if (init.method === 'PUT') return { body: { success: true, result: {} } }
      return { status: 404, body: { success: false, errors: [{ message: 'nope' }] } }
    })
    const msg = await PROVIDERS.cloudflare({ ip: '1.2.3.4', type: 'A', options: { apiToken: 'tok', zone: 'example.com', record: 'home.example.com' }, fetchImpl: impl })
    assert.equal(msg, 'Cloudflare record updated')
    assert.equal(calls[2].init.method, 'PUT')
    assert.equal(calls[2].init.headers.authorization, 'Bearer tok')
    assert.deepEqual(JSON.parse(calls[2].init.body), { type: 'A', name: 'home.example.com', content: '1.2.3.4', ttl: 60, proxied: false })
  })

  test('dnspod creates a missing record', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith('Record.List')) return { body: { status: { code: '1' }, records: [] } }
      return { body: { status: { code: '1' } } }
    })
    assert.equal(await PROVIDERS.dnspod({ ip: '1.2.3.4', type: 'A', options: { tokenId: '1', token: 'x', domain: 'example.com', subDomain: 'home' }, fetchImpl: impl }), 'DNSPod record created')
    const form = new URLSearchParams(calls[1].init.body)
    assert.equal(form.get('login_token'), '1,x')
    assert.equal(form.get('value'), '1.2.3.4')
  })

  test('aliyun signs requests deterministically', () => {
    const url = new URL(aliyunSignedUrl({ Action: 'DescribeSubDomainRecords', SubDomain: 'home.example.com' }, 'id', 'secret', { now: new Date('2026-01-01T00:00:00Z'), nonce: 'n' }))
    assert.equal(url.searchParams.get('Timestamp'), '2026-01-01T00:00:00Z')
    assert.equal(url.searchParams.get('SignatureMethod'), 'HMAC-SHA1')
    assert.match(url.searchParams.get('Signature'), /^[A-Za-z0-9+/]+=*$/)
  })

  test('dyndns2 sends basic auth', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: 'good 1.2.3.4' }))
    await PROVIDERS.dyndns2({ ip: '1.2.3.4', options: { server: 'dynupdate.no-ip.com', username: 'u', password: 'p', hostname: 'h.ddns.net' }, fetchImpl: impl })
    assert.match(calls[0].url, /^https:\/\/dynupdate\.no-ip\.com\/nic\/update\?hostname=h\.ddns\.net&myip=1\.2\.3\.4/)
    assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`)
  })

  test('updater pushes only on change and reports errors', async () => {
    let ip = '1.1.1.1'
    let pushes = 0
    const { impl } = fakeFetch((url) => {
      if (url.includes('ipify') || url.includes('ipw') || url.includes('icanhazip') || url.includes('ipip')) return { body: ip }
      pushes += 1
      return { body: 'OK' }
    })
    const settings = { ddns: { enabled: true, provider: 'duckdns', hostname: 'h', ipv6: false, intervalSeconds: 300, options: { domains: 'h', token: 't' } } }
    const updater = new DdnsUpdater({ getSettings: () => settings, logger: quietLogger, fetchImpl: impl })
    assert.equal((await updater.update()).state, 'ok')
    await updater.update()
    assert.equal(pushes, 1)
    ip = '2.2.2.2'
    await updater.update()
    assert.equal(pushes, 2)
    settings.ddns.options = { domains: 'h' }
    ip = '3.3.3.3'
    const status = await updater.update()
    assert.equal(status.state, 'error')
    assert.match(status.lastError, /token/)
  })
})

describe('settings', () => {
  test('merge validates and keeps secrets behind placeholders', () => {
    const base = defaultSettings({ name: 'pc' })
    const next = mergeSettings(base, { ddns: { provider: 'cloudflare', options: { apiToken: 'abc', zone: 'z' } } })
    const view = publicSettings(next)
    assert.equal(view.ddns.options.apiToken, SECRET_PLACEHOLDER)
    assert.equal(mergeSettings(next, { ddns: { options: view.ddns.options } }).ddns.options.apiToken, 'abc')
    assert.throws(() => mergeSettings(base, { port: 0 }), /port/)
    assert.throws(() => mergeSettings(base, { ddns: { provider: 'nope' } }), /provider/)
    assert.throws(() => mergeSettings(base, { name: '' }), /name/)
  })

  test('pairing codes are single use and exhaust after misses', () => {
    const codes = new PairingCodes({ maxAttempts: 2 })
    const { code } = codes.get()
    assert.equal(codes.consume('nope'), false)
    assert.equal(codes.consume(code), true)
    assert.equal(codes.consume(code), false)
    const next = codes.get().code
    codes.consume('a')
    codes.consume('b')
    assert.equal(codes.consume(next), false)
  })
})

describe('upnp', () => {
  test('finds the WAN control URL', () => {
    const xml = `<root><URLBase>http://192.168.1.1:5000/</URLBase><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>`
    assert.deepEqual(findControlUrl(xml, 'http://192.168.1.1:5000/rootDesc.xml'), {
      controlUrl: 'http://192.168.1.1:5000/ctl/IPConn',
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    })
  })
})

describe('preamble', () => {
  test('plain HTTP bytes are left for the HTTP parser', async () => {
    const server = net.createServer()
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const accepted = new Promise(r => server.once('connection', r))
    const client = net.connect(server.address().port, '127.0.0.1')
    client.write('GET / HTTP/1.1\r\n\r\n')
    const socket = await accepted
    assert.deepEqual(await readPreamble(socket), { kind: 'http' })
    const data = await new Promise(r => socket.once('data', r))
    assert.equal(data.toString(), 'GET / HTTP/1.1\r\n\r\n')
    client.destroy()
    socket.destroy()
    server.close()
  })
})

describe('plugin entry', () => {
  test('config schema validates and fills defaults', () => {
    const { validate } = plugin.Config['~standard']
    assert.deepEqual(validate(undefined).value.port, 39090)
    assert.ok(validate({ port: 'x' }).issues)
    assert.ok(validate({ unknown: 1 }).issues)
    assert.equal(validate({ tls: false }).value.tls, false)
  })

  test('apply starts the bridge, registers /remote, and stops on dispose', async () => {
    const mock = await startMockDsh()
    const stateDir = await mkdtemp(join(tmpdir(), 'dshr-plugin-'))
    const effects = []
    const commands = []
    const mockPort = Number(new URL(mock.origin).port)
    const ctx = {
      logger: () => quietLogger,
      webServer: { port: mockPort, protocol: 'http:' },
      connection: { authenticatedUrl: o => `${o}/?token=launch-token-123` },
      effect: (fn) => { effects.push(fn()) },
      inject: (names, cb) => cb({ commands: { register: c => commands.push(c) } }),
    }
    plugin.apply(ctx, { port: 0, adminPort: 0, bindHost: '127.0.0.1', mdns: false, stateDir, name: 'Plugin PC' })
    const dispose = await effects[0]
    assert.equal(commands[0].name, 'remote')
    const result = await commands[0].handler({})
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Pairing code: \d{6}/)
    assert.match(result.text, /http:\/\/127\.0\.0\.1:\d+\/\?token=/)
    await dispose()
    await mock.close()
  })
})
