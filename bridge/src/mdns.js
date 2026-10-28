// Minimal mDNS (RFC 6762) / DNS-SD (RFC 6763) responder advertising
// `_dshremote._tcp.local` so the iOS app finds the PC with NWBrowser, without
// Apple's Bonjour service installed on Windows.
import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'

const MDNS_ADDRESS = '224.0.0.251'
const MDNS_PORT = 5353
const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 }
const CLASS_IN = 1
const CACHE_FLUSH = 0x8000

export const SERVICE_TYPE = '_dshremote._tcp.local'

function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.')
  const buffers = parts.map((label) => {
    const bytes = Buffer.from(label, 'utf8').subarray(0, 63)
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  })
  return Buffer.concat([...buffers, Buffer.from([0])])
}

function readName(buf, offset, depth = 0) {
  const labels = []
  let pos = offset
  let end
  if (depth > 10) throw new Error('mdns: name pointer loop')
  for (;;) {
    if (pos >= buf.length) throw new Error('mdns: truncated name')
    const len = buf[pos]
    if (len === 0) { pos += 1; break }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1]
      const { name } = readName(buf, pointer, depth + 1)
      if (name) labels.push(name)
      pos += 2
      end = pos
      return { name: labels.join('.'), end }
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len))
    pos += 1 + len
  }
  return { name: labels.join('.'), end: pos }
}

/** Parse the question section of a DNS message. */
export function parseQuery(buf) {
  if (buf.length < 12) throw new Error('mdns: short packet')
  const id = buf.readUInt16BE(0)
  const flags = buf.readUInt16BE(2)
  const qdcount = buf.readUInt16BE(4)
  const questions = []
  let pos = 12
  for (let i = 0; i < qdcount; i++) {
    const { name, end } = readName(buf, pos)
    const type = buf.readUInt16BE(end)
    const klass = buf.readUInt16BE(end + 2)
    questions.push({ name: name.toLowerCase(), type, unicast: (klass & 0x8000) !== 0 })
    pos = end + 4
  }
  return { id, isResponse: (flags & 0x8000) !== 0, questions }
}

function record(name, type, ttl, rdata, flush = true) {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(CLASS_IN | (flush ? CACHE_FLUSH : 0), 2)
  header.writeUInt32BE(ttl, 4)
  header.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([encodeName(name), header, rdata])
}

function txtData(entries) {
  const parts = Object.entries(entries).map(([k, v]) => {
    const bytes = Buffer.from(`${k}=${v}`, 'utf8').subarray(0, 255)
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  })
  return parts.length ? Buffer.concat(parts) : Buffer.from([0])
}

/** Build a DNS response packet. */
export function buildResponse({ id = 0, answers, additionals = [], questions = [] }) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x8400, 2) // response, authoritative
  header.writeUInt16BE(questions.length, 4)
  header.writeUInt16BE(answers.length, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(additionals.length, 10)
  const qs = questions.map(q => Buffer.concat([encodeName(q.name), Buffer.from([q.type >> 8, q.type & 0xff, 0, 1])]))
  return Buffer.concat([header, ...qs, ...answers, ...additionals])
}

function sanitizeLabel(text) {
  const label = String(text).replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return label || 'dsh'
}

function ipv4Addresses() {
  const out = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const e of entries ?? []) {
      if (!e.internal && (e.family === 'IPv4' || e.family === 4) && !e.address.startsWith('169.254.')) out.push(e.address)
    }
  }
  return out
}

export class MdnsAdvertiser {
  /**
   * @param {{ name: string, port: number, txt: Record<string,string>, logger: object }} options
   */
  constructor({ name, port, txt, logger }) {
    this.instanceLabel = String(name).replace(/\./g, ' ').slice(0, 60) || 'DSH'
    this.hostName = `${sanitizeLabel(name)}-dshr.local`
    this.port = port
    this.txt = txt
    this.logger = logger
    this.sockets = []
    this.timers = []
  }

  get instanceName() {
    return `${this.instanceLabel}.${SERVICE_TYPE}`
  }

  /** Records answering `questions`; all records when `questions` is undefined. */
  answersFor(questions, ttl = 120) {
    const addresses = ipv4Addresses()
    const ptr = () => record(SERVICE_TYPE, TYPE.PTR, ttl * 37, encodeName(this.instanceName), false)
    const srv = () => {
      const data = Buffer.alloc(6)
      data.writeUInt16BE(0, 0)
      data.writeUInt16BE(0, 2)
      data.writeUInt16BE(this.port, 4)
      return record(this.instanceName, TYPE.SRV, ttl, Buffer.concat([data, encodeName(this.hostName)]))
    }
    const txt = () => record(this.instanceName, TYPE.TXT, ttl * 37, txtData(this.txt))
    const a = () => addresses.map(ip => record(this.hostName, TYPE.A, ttl, Buffer.from(ip.split('.').map(Number))))
    const enumerate = () => record('_services._dns-sd._udp.local', TYPE.PTR, ttl * 37, encodeName(SERVICE_TYPE), false)

    if (!questions) return { answers: [ptr(), srv(), txt(), ...a()], additionals: [] }
    const answers = []
    const additionals = []
    const instance = this.instanceName.toLowerCase()
    for (const q of questions) {
      const any = q.type === TYPE.ANY
      if (q.name === SERVICE_TYPE && (q.type === TYPE.PTR || any)) {
        answers.push(ptr())
        additionals.push(srv(), txt(), ...a())
      } else if (q.name === instance) {
        if (q.type === TYPE.SRV || any) { answers.push(srv()); additionals.push(...a()) }
        if (q.type === TYPE.TXT || any) answers.push(txt())
      } else if (q.name === this.hostName.toLowerCase() && (q.type === TYPE.A || any)) {
        answers.push(...a())
      } else if (q.name === '_services._dns-sd._udp.local' && (q.type === TYPE.PTR || any)) {
        answers.push(enumerate())
      }
    }
    return { answers, additionals }
  }

  start() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', (error) => {
      this.logger.warn(`mDNS disabled: ${error.message}`)
      try { socket.close() } catch { /* already closed */ }
    })
    socket.on('message', (msg, rinfo) => this.#onMessage(socket, msg, rinfo))
    socket.bind(MDNS_PORT, () => {
      try {
        socket.setMulticastTTL(255)
        socket.setMulticastLoopback(true)
      } catch { /* optional */ }
      for (const ip of ipv4Addresses()) {
        try { socket.addMembership(MDNS_ADDRESS, ip) } catch { /* interface may not support multicast */ }
      }
      this.#announce(socket)
    })
    this.sockets.push(socket)
  }

  #send(socket, packet, port = MDNS_PORT, address = MDNS_ADDRESS) {
    try {
      socket.send(packet, port, address)
    } catch (error) {
      this.logger.debug?.(`mDNS send failed: ${error.message}`)
    }
  }

  #announce(socket) {
    const packet = buildResponse(this.answersFor(undefined))
    this.#send(socket, packet)
    const again = setTimeout(() => this.#send(socket, packet), 1000)
    const periodic = setInterval(() => this.#send(socket, buildResponse(this.answersFor(undefined))), 60_000)
    again.unref?.()
    periodic.unref?.()
    this.timers.push(again, periodic)
  }

  #onMessage(socket, msg, rinfo) {
    let query
    try {
      query = parseQuery(msg)
    } catch {
      return
    }
    if (query.isResponse || query.questions.length === 0) return
    const { answers, additionals } = this.answersFor(query.questions)
    if (answers.length === 0) return
    if (rinfo.port !== MDNS_PORT) {
      // Legacy unicast query (RFC 6762 §6.7): echo id and questions back.
      this.#send(socket, buildResponse({ id: query.id, answers, additionals, questions: query.questions }), rinfo.port, rinfo.address)
      return
    }
    this.#send(socket, buildResponse({ answers, additionals }))
    if (query.questions.some(q => q.unicast)) {
      this.#send(socket, buildResponse({ answers, additionals }), rinfo.port, rinfo.address)
    }
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    for (const socket of this.sockets) {
      try {
        // Goodbye packet: TTL 0 withdraws cached records (RFC 6762 §10.1).
        socket.send(buildResponse(this.answersFor(undefined, 0)), MDNS_PORT, MDNS_ADDRESS, () => {
          try { socket.close() } catch { /* already closed */ }
        })
      } catch {
        try { socket.close() } catch { /* already closed */ }
      }
    }
    this.sockets = []
  }
}
