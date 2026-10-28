// Durable bridge state: paired devices (hashed tokens), the admin token, and
// runtime-editable settings. Stored as one JSON file written atomically.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { HttpError, safeEqual, sha256Hex } from './util.js'

export const SECRET_PLACEHOLDER = '__dsh_remote_secret_unchanged__'

/** DDNS provider option fields that hold credentials and are never echoed back. */
const SECRET_FIELDS = new Set(['token', 'apiToken', 'password', 'accessKeySecret', 'secretKey'])

export const DDNS_PROVIDERS = ['none', 'duckdns', 'cloudflare', 'dnspod', 'aliyun', 'dyndns2', 'webhook']

export function defaultSettings(config = {}) {
  return {
    name: config.name || hostname(),
    port: config.port ?? 39090,
    tls: config.tls ?? true,
    mdns: config.mdns ?? true,
    upnp: {
      enabled: false,
      externalPort: null,
      leaseSeconds: 3600,
    },
    ddns: {
      enabled: false,
      provider: 'none',
      // Public hostname phones use outside the LAN (e.g. myhome.duckdns.org).
      hostname: '',
      // Public port; null means the UPnP external port or the bridge port.
      publicPort: null,
      intervalSeconds: 300,
      ipv6: false,
      options: {},
    },
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asPort(value, field) {
  if (value === null || value === '' || value === undefined) return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new HttpError(400, `${field} must be a port number (1-65535)`)
  return n
}

/**
 * Merge a settings patch from the admin page or the app into current
 * settings, validating every field. Secret placeholders keep stored values.
 */
export function mergeSettings(current, patch) {
  if (!isPlainObject(patch)) throw new HttpError(400, 'settings must be an object')
  const next = structuredClone(current)
  if ('name' in patch) {
    const name = String(patch.name ?? '').trim()
    if (name.length === 0 || name.length > 63) throw new HttpError(400, 'name must be 1-63 characters')
    next.name = name
  }
  if ('port' in patch) next.port = asPort(patch.port, 'port') ?? current.port
  if ('tls' in patch) next.tls = Boolean(patch.tls)
  if ('mdns' in patch) next.mdns = Boolean(patch.mdns)
  if (isPlainObject(patch.upnp)) {
    if ('enabled' in patch.upnp) next.upnp.enabled = Boolean(patch.upnp.enabled)
    if ('externalPort' in patch.upnp) next.upnp.externalPort = asPort(patch.upnp.externalPort, 'upnp.externalPort')
    if ('leaseSeconds' in patch.upnp) {
      const lease = Number(patch.upnp.leaseSeconds)
      if (!Number.isInteger(lease) || lease < 0 || lease > 7 * 24 * 3600) throw new HttpError(400, 'upnp.leaseSeconds must be 0-604800')
      next.upnp.leaseSeconds = lease
    }
  }
  if (isPlainObject(patch.ddns)) {
    const d = patch.ddns
    if ('enabled' in d) next.ddns.enabled = Boolean(d.enabled)
    if ('provider' in d) {
      if (!DDNS_PROVIDERS.includes(d.provider)) throw new HttpError(400, `ddns.provider must be one of ${DDNS_PROVIDERS.join(', ')}`)
      if (d.provider !== current.ddns.provider) next.ddns.options = {}
      next.ddns.provider = d.provider
    }
    if ('hostname' in d) {
      const host = String(d.hostname ?? '').trim().toLowerCase()
      if (host && !/^[a-z0-9.-]{1,253}$/.test(host) && !/^[0-9a-f:]+$/.test(host)) throw new HttpError(400, 'ddns.hostname is not a valid host name')
      next.ddns.hostname = host
    }
    if ('publicPort' in d) next.ddns.publicPort = asPort(d.publicPort, 'ddns.publicPort')
    if ('intervalSeconds' in d) {
      const interval = Number(d.intervalSeconds)
      if (!Number.isInteger(interval) || interval < 60 || interval > 86400) throw new HttpError(400, 'ddns.intervalSeconds must be 60-86400')
      next.ddns.intervalSeconds = interval
    }
    if ('ipv6' in d) next.ddns.ipv6 = Boolean(d.ipv6)
    if (isPlainObject(d.options)) {
      const previous = d.provider === undefined || d.provider === current.ddns.provider ? current.ddns.options : {}
      const options = {}
      for (const [key, value] of Object.entries(d.options)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key)) throw new HttpError(400, `invalid ddns option ${key}`)
        if (value === SECRET_PLACEHOLDER) {
          if (previous[key] !== undefined) options[key] = previous[key]
          continue
        }
        if (typeof value === 'boolean') options[key] = value
        else options[key] = String(value ?? '').trim().slice(0, 2048)
      }
      next.ddns.options = options
    }
  }
  return next
}

/** Settings as shown to clients: secrets replaced by a placeholder. */
export function publicSettings(settings) {
  const view = structuredClone(settings)
  for (const key of Object.keys(view.ddns.options)) {
    if (SECRET_FIELDS.has(key) && view.ddns.options[key]) view.ddns.options[key] = SECRET_PLACEHOLDER
  }
  return view
}

export class StateStore {
  constructor(file, config, logger) {
    this.file = file
    this.config = config
    this.logger = logger
    this.data = undefined
    this.writing = Promise.resolve()
    this.dirtyTimer = undefined
  }

  async load() {
    let raw
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn(`state file unreadable, starting fresh: ${error.message}`)
      raw = {}
    }
    const defaults = defaultSettings(this.config)
    let settings = defaults
    if (isPlainObject(raw.settings)) {
      try {
        settings = mergeSettings(defaults, raw.settings)
      } catch (error) {
        this.logger.warn(`stored settings invalid, using defaults: ${error.message}`)
      }
    }
    this.data = {
      version: 1,
      hostId: typeof raw.hostId === 'string' ? raw.hostId : randomUUID(),
      adminToken: typeof raw.adminToken === 'string' && raw.adminToken.length >= 32 ? raw.adminToken : randomBytes(24).toString('base64url'),
      devices: Array.isArray(raw.devices) ? raw.devices.filter(d => d && typeof d.id === 'string' && typeof d.tokenHash === 'string') : [],
      settings,
    }
    await this.save()
    return this
  }

  get settings() { return this.data.settings }
  get hostId() { return this.data.hostId }
  get adminToken() { return this.data.adminToken }
  get devices() { return this.data.devices }

  async updateSettings(patch) {
    this.data.settings = mergeSettings(this.data.settings, patch)
    await this.save()
    return this.data.settings
  }

  async addDevice(name, address) {
    const token = randomBytes(32).toString('base64url')
    const device = {
      id: randomUUID(),
      name: String(name || 'iPhone').slice(0, 64),
      tokenHash: sha256Hex(token),
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastAddress: address ?? '',
    }
    this.data.devices.push(device)
    await this.save()
    return { device, token }
  }

  async removeDevice(id) {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter(d => d.id !== id)
    if (this.data.devices.length === before) return false
    await this.save()
    return true
  }

  /** Verify `<deviceId>.<token>` or separate parts; returns the device or undefined. */
  authenticate(deviceId, token, address) {
    if (typeof deviceId !== 'string' || typeof token !== 'string' || token.length < 16) return undefined
    const device = this.data.devices.find(d => d.id === deviceId)
    if (!device || !safeEqual(device.tokenHash, sha256Hex(token))) return undefined
    const now = Date.now()
    if (now - Date.parse(device.lastSeenAt || 0) > 60_000 || device.lastAddress !== address) {
      device.lastSeenAt = new Date(now).toISOString()
      device.lastAddress = address ?? ''
      this.saveSoon()
    }
    return device
  }

  saveSoon() {
    if (this.dirtyTimer) return
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = undefined
      this.save().catch(error => this.logger.warn(`state save failed: ${error.message}`))
    }, 2000)
    this.dirtyTimer.unref?.()
  }

  save() {
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, this.file)
    })
    return this.writing
  }

  async flush() {
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer)
      this.dirtyTimer = undefined
      await this.save()
    }
    await this.writing.catch(() => {})
  }
}
