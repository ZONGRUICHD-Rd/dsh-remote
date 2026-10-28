// Best-effort UPnP IGD port mapping so the bridge is reachable from the
// internet without manual router configuration.
import dgram from 'node:dgram'

const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
]
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
]

function xmlEscape(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' })[c])
}

/** Discover gateway description URLs via SSDP M-SEARCH. */
export function discoverGateways(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map()
    socket.on('error', () => { try { socket.close() } catch { /* closed */ } resolve([...found.values()]) })
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8')
      const location = /^location:\s*(.+)$/im.exec(text)?.[1]?.trim()
      if (location && !found.has(location)) found.set(location, { location, address: rinfo.address })
    })
    socket.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const query = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
        socket.send(query, SSDP_PORT, SSDP_ADDRESS)
      }
    })
    setTimeout(() => { try { socket.close() } catch { /* closed */ } resolve([...found.values()]) }, timeoutMs)
  })
}

/** Find a WAN connection service control URL in a device description. */
export function findControlUrl(descriptionXml, location) {
  for (const type of SERVICE_TYPES) {
    const services = descriptionXml.split(/<service>/i).slice(1)
    for (const block of services) {
      const serviceType = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1]
      const control = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1]
      if (serviceType === type && control) {
        const base = /<URLBase>\s*([^<]+?)\s*<\/URLBase>/i.exec(descriptionXml)?.[1] || location
        return { controlUrl: new URL(control, base).href, serviceType: type }
      }
    }
  }
  return undefined
}

async function soap(service, action, args, fetchImpl = fetch) {
  const body = `<?xml version="1.0"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.serviceType}">${
    Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('')
  }</u:${action}></s:Body></s:Envelope>`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetchImpl(service.controlUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service.serviceType}#${action}"` },
      body,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const description = /<errorDescription>([^<]*)<\/errorDescription>/i.exec(text)?.[1]
      const code = /<errorCode>([^<]*)<\/errorCode>/i.exec(text)?.[1]
      throw new Error(`UPnP ${action} failed: ${description ?? `HTTP ${res.status}`}${code ? ` (${code})` : ''}`)
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

export class UpnpMapper {
  constructor({ logger, fetchImpl = fetch }) {
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.service = undefined
    this.mapping = undefined
    this.timer = undefined
    this.status = { state: 'disabled' }
  }

  async #service() {
    if (this.service) return this.service
    for (const gateway of await discoverGateways()) {
      try {
        const res = await this.fetchImpl(gateway.location)
        const found = findControlUrl(await res.text(), gateway.location)
        if (found) {
          this.service = found
          return found
        }
      } catch {
        // Try the next responder.
      }
    }
    throw new Error('no UPnP gateway found (enable UPnP on the router or forward the port manually)')
  }

  async externalIp() {
    const service = await this.#service()
    const text = await soap(service, 'GetExternalIPAddress', {}, this.fetchImpl)
    return /<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/i.exec(text)?.[1] || undefined
  }

  /** Map `externalPort` → `internalClient:internalPort` and keep renewing it. */
  async start({ externalPort, internalPort, internalClient, leaseSeconds }) {
    await this.stop()
    this.mapping = { externalPort, internalPort, internalClient, leaseSeconds }
    await this.#map()
    if (leaseSeconds > 0) {
      const renew = Math.max(60, Math.floor(leaseSeconds / 2)) * 1000
      this.timer = setInterval(() => this.#map().catch(() => {}), renew)
      this.timer.unref?.()
    }
  }

  async #map() {
    const m = this.mapping
    if (!m) return
    try {
      const service = await this.#service()
      await soap(service, 'AddPortMapping', {
        NewRemoteHost: '',
        NewExternalPort: m.externalPort,
        NewProtocol: 'TCP',
        NewInternalPort: m.internalPort,
        NewInternalClient: m.internalClient,
        NewEnabled: 1,
        NewPortMappingDescription: 'DSH Remote',
        NewLeaseDuration: m.leaseSeconds,
      }, this.fetchImpl)
      const ip = await this.externalIp().catch(() => undefined)
      this.status = { state: 'mapped', externalPort: m.externalPort, internalPort: m.internalPort, internalClient: m.internalClient, externalIp: ip, at: new Date().toISOString() }
      this.logger.info(`UPnP: mapped external port ${m.externalPort} → ${m.internalClient}:${m.internalPort}`)
    } catch (error) {
      this.service = undefined
      this.status = { state: 'error', error: error.message }
      this.logger.warn(`UPnP: ${error.message}`)
      throw error
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    const m = this.mapping
    this.mapping = undefined
    this.status = { state: 'disabled' }
    if (!m || !this.service) return
    try {
      await soap(this.service, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.externalPort, NewProtocol: 'TCP' }, this.fetchImpl)
    } catch (error) {
      this.logger.debug?.(`UPnP unmap failed: ${error.message}`)
    }
  }
}
