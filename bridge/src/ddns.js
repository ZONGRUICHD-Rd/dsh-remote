// Dynamic DNS: detect the public IP and keep a DNS record pointing at it so
// the phone can reach the bridge from outside the LAN.
import { createHmac, randomUUID } from 'node:crypto'

export const IPV4_LOOKUP_URLS = [
  'https://api.ipify.org',
  'https://4.ipw.cn',
  'https://ipv4.icanhazip.com',
  'https://myip.ipip.net/s',
]
export const IPV6_LOOKUP_URLS = [
  'https://api6.ipify.org',
  'https://6.ipw.cn',
  'https://ipv6.icanhazip.com',
]

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6_RE = /^[0-9a-f:]{2,39}$/i

export function isIPv4(text) { return IPV4_RE.test(text) }
export function isIPv6(text) { return IPV6_RE.test(text) && text.includes(':') }

async function fetchText(url, { fetchImpl = fetch, timeoutMs = 8000, ...init } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal })
    const text = await res.text()
    return { status: res.status, ok: res.ok, text }
  } finally {
    clearTimeout(timer)
  }
}

/** First public IP reported by any lookup service. */
export async function detectPublicIp(family = 4, { fetchImpl = fetch, urls } = {}) {
  const list = urls ?? (family === 6 ? IPV6_LOOKUP_URLS : IPV4_LOOKUP_URLS)
  const check = family === 6 ? isIPv6 : isIPv4
  for (const url of list) {
    try {
      const { ok, text } = await fetchText(url, { fetchImpl, timeoutMs: 5000 })
      const ip = text.trim().split(/\s+/)[0]
      if (ok && check(ip)) return ip
    } catch {
      // Try the next service.
    }
  }
  return undefined
}

function required(options, ...names) {
  for (const name of names) {
    if (!options[name]) throw new Error(`missing option "${name}"`)
  }
}

/** Percent-encoding required by Aliyun's RPC signature (RFC 3986). */
function aliyunEncode(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function aliyunSignedUrl(params, accessKeyId, accessKeySecret, { now = new Date(), nonce = randomUUID() } = {}) {
  const all = {
    Format: 'JSON',
    Version: '2015-01-09',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
    ...params,
  }
  const canonical = Object.keys(all).sort().map(k => `${aliyunEncode(k)}=${aliyunEncode(String(all[k]))}`).join('&')
  const stringToSign = `GET&${aliyunEncode('/')}&${aliyunEncode(canonical)}`
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64')
  return `https://alidns.aliyuncs.com/?${canonical}&Signature=${aliyunEncode(signature)}`
}

/**
 * Provider implementations. Each receives `{ ip, type ('A'|'AAAA'), options,
 * hostname, fetchImpl }` and resolves to a status message or throws.
 */
export const PROVIDERS = {
  async duckdns({ ip, type, options, fetchImpl }) {
    required(options, 'domains', 'token')
    const domains = options.domains.split(',').map(d => d.trim().replace(/\.duckdns\.org$/i, '')).filter(Boolean).join(',')
    const url = new URL('https://www.duckdns.org/update')
    url.searchParams.set('domains', domains)
    url.searchParams.set('token', options.token)
    url.searchParams.set(type === 'AAAA' ? 'ipv6' : 'ip', ip)
    const { text } = await fetchText(url, { fetchImpl })
    if (!text.trim().startsWith('OK')) throw new Error(`DuckDNS answered ${text.trim() || 'empty response'}`)
    return 'DuckDNS updated'
  },

  async cloudflare({ ip, type, options, hostname, fetchImpl }) {
    required(options, 'apiToken', 'zone')
    const record = options.record || hostname
    if (!record) throw new Error('missing option "record"')
    const api = 'https://api.cloudflare.com/client/v4'
    const headers = { authorization: `Bearer ${options.apiToken}`, 'content-type': 'application/json' }
    const call = async (path, init = {}) => {
      const { text } = await fetchText(`${api}${path}`, { fetchImpl, headers, ...init })
      let body
      try { body = JSON.parse(text) } catch { throw new Error(`Cloudflare returned non-JSON: ${text.slice(0, 120)}`) }
      if (!body.success) throw new Error(`Cloudflare: ${(body.errors ?? []).map(e => e.message).join('; ') || 'request failed'}`)
      return body.result
    }
    let zoneId = options.zone
    if (!/^[0-9a-f]{32}$/i.test(zoneId)) {
      const zones = await call(`/zones?name=${encodeURIComponent(zoneId)}`)
      if (!zones?.length) throw new Error(`Cloudflare zone ${zoneId} not found`)
      zoneId = zones[0].id
    }
    const records = await call(`/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(record)}`)
    const payload = JSON.stringify({ type, name: record, content: ip, ttl: 60, proxied: options.proxied === true || options.proxied === 'true' })
    if (records?.length) {
      if (records[0].content === ip) return 'Cloudflare record already current'
      await call(`/zones/${zoneId}/dns_records/${records[0].id}`, { method: 'PUT', body: payload })
      return 'Cloudflare record updated'
    }
    await call(`/zones/${zoneId}/dns_records`, { method: 'POST', body: payload })
    return 'Cloudflare record created'
  },

  async dnspod({ ip, type, options, fetchImpl }) {
    // DNSPod (Tencent Cloud) token API: tokenId + token from console.dnspod.cn.
    required(options, 'tokenId', 'token', 'domain')
    const subDomain = options.subDomain || '@'
    const common = {
      login_token: `${options.tokenId},${options.token}`,
      format: 'json',
      lang: 'en',
      error_on_empty: 'no',
      domain: options.domain,
    }
    const post = async (action, params) => {
      const { text } = await fetchText(`https://dnsapi.cn/${action}`, {
        fetchImpl,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'dsh-remote/0.1 (dsh-remote)' },
        body: new URLSearchParams({ ...common, ...params }).toString(),
      })
      const body = JSON.parse(text)
      if (body?.status?.code !== '1') throw new Error(`DNSPod ${action}: ${body?.status?.message ?? 'failed'}`)
      return body
    }
    const list = await post('Record.List', { sub_domain: subDomain, record_type: type })
    const existing = list.records?.[0]
    if (existing) {
      if (existing.value === ip) return 'DNSPod record already current'
      await post('Record.Modify', { record_id: existing.id, sub_domain: subDomain, record_type: type, record_line_id: existing.line_id ?? '0', value: ip, ttl: '600' })
      return 'DNSPod record updated'
    }
    await post('Record.Create', { sub_domain: subDomain, record_type: type, record_line_id: '0', value: ip, ttl: '600' })
    return 'DNSPod record created'
  },

  async aliyun({ ip, type, options, fetchImpl }) {
    required(options, 'accessKeyId', 'accessKeySecret', 'domain')
    const rr = options.rr || '@'
    const call = async (params) => {
      const { text } = await fetchText(aliyunSignedUrl(params, options.accessKeyId, options.accessKeySecret), { fetchImpl })
      const body = JSON.parse(text)
      if (body.Code) throw new Error(`Aliyun ${params.Action}: ${body.Code} ${body.Message ?? ''}`.trim())
      return body
    }
    const subDomain = rr === '@' ? options.domain : `${rr}.${options.domain}`
    const found = await call({ Action: 'DescribeSubDomainRecords', SubDomain: subDomain, Type: type })
    const existing = found.DomainRecords?.Record?.[0]
    if (existing) {
      if (existing.Value === ip) return 'Aliyun record already current'
      await call({ Action: 'UpdateDomainRecord', RecordId: existing.RecordId, RR: rr, Type: type, Value: ip })
      return 'Aliyun record updated'
    }
    await call({ Action: 'AddDomainRecord', DomainName: options.domain, RR: rr, Type: type, Value: ip })
    return 'Aliyun record created'
  },

  async dyndns2({ ip, options, hostname, fetchImpl }) {
    // No-IP, Dynu, Oray (花生壳), ChangeIP, … all speak the dyndns2 protocol.
    required(options, 'server', 'username', 'password')
    const host = options.hostname || hostname
    if (!host) throw new Error('missing option "hostname"')
    const base = /^https?:\/\//.test(options.server) ? options.server : `https://${options.server}`
    const url = new URL(base)
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/nic/update'
    url.searchParams.set('hostname', host)
    url.searchParams.set('myip', ip)
    const auth = Buffer.from(`${options.username}:${options.password}`).toString('base64')
    const { text } = await fetchText(url, { fetchImpl, headers: { authorization: `Basic ${auth}`, 'user-agent': 'dsh-remote/0.1 dsh-remote@users.noreply.github.com' } })
    const answer = text.trim().split(/\s+/)[0]
    if (answer !== 'good' && answer !== 'nochg') throw new Error(`dyndns2 server answered ${text.trim() || 'empty response'}`)
    return `dyndns2: ${answer}`
  },

  async webhook({ ip, type, options, hostname, fetchImpl }) {
    required(options, 'url')
    const fill = text => String(text ?? '')
      .replaceAll('{ip}', ip)
      .replaceAll('{type}', type)
      .replaceAll('{hostname}', hostname ?? '')
    const method = (options.method || 'GET').toUpperCase()
    const init = { fetchImpl, method }
    if (method !== 'GET' && options.body) {
      init.body = fill(options.body)
      init.headers = { 'content-type': options.contentType || 'application/json' }
    }
    const { ok, status, text } = await fetchText(fill(options.url), init)
    if (!ok) throw new Error(`webhook answered HTTP ${status}: ${text.slice(0, 120)}`)
    return `webhook HTTP ${status}`
  },
}

/** Periodically detects the public IP and pushes changes to the provider. */
export class DdnsUpdater {
  constructor({ getSettings, logger, fetchImpl = fetch, getUpnpExternalIp }) {
    this.getSettings = getSettings
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.getUpnpExternalIp = getUpnpExternalIp
    this.timer = undefined
    this.running = undefined
    this.status = { state: 'idle', publicIPv4: undefined, publicIPv6: undefined, lastUpdate: undefined, lastError: undefined, message: undefined }
    this.lastPushed = { A: undefined, AAAA: undefined }
  }

  start() {
    this.stop()
    const tick = () => {
      this.update().catch(() => {}).finally(() => {
        const interval = (this.getSettings().ddns.intervalSeconds ?? 300) * 1000
        this.timer = setTimeout(tick, interval)
        this.timer.unref?.()
      })
    }
    this.timer = setTimeout(tick, 1500)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Settings changed: forget pushed values so the next run re-pushes. */
  reset() {
    this.lastPushed = { A: undefined, AAAA: undefined }
    this.status.lastError = undefined
  }

  async update({ force = false } = {}) {
    if (this.running) return this.running
    this.running = this.#update(force).finally(() => { this.running = undefined })
    return this.running
  }

  async #update(force) {
    const { ddns } = this.getSettings()
    try {
      let ipv4 = await detectPublicIp(4, { fetchImpl: this.fetchImpl })
      if (!ipv4 && this.getUpnpExternalIp) ipv4 = await this.getUpnpExternalIp().catch(() => undefined)
      const ipv6 = ddns.ipv6 ? await detectPublicIp(6, { fetchImpl: this.fetchImpl }) : undefined
      this.status.publicIPv4 = ipv4
      this.status.publicIPv6 = ipv6
      if (!ddns.enabled || ddns.provider === 'none') {
        this.status.state = 'disabled'
        return this.status
      }
      const provider = PROVIDERS[ddns.provider]
      if (!provider) throw new Error(`unknown DDNS provider ${ddns.provider}`)
      const messages = []
      for (const [type, ip] of [['A', ipv4], ['AAAA', ipv6]]) {
        if (!ip) continue
        if (!force && this.lastPushed[type] === ip) continue
        messages.push(await provider({ ip, type, options: ddns.options, hostname: ddns.hostname, fetchImpl: this.fetchImpl }))
        this.lastPushed[type] = ip
      }
      if (!ipv4 && !ipv6) throw new Error('could not detect the public IP address')
      this.status.state = 'ok'
      this.status.lastError = undefined
      if (messages.length) {
        this.status.lastUpdate = new Date().toISOString()
        this.status.message = messages.join('; ')
        this.logger.info(`DDNS: ${this.status.message} (${[ipv4, ipv6].filter(Boolean).join(', ')})`)
      }
    } catch (error) {
      this.status.state = 'error'
      this.status.lastError = error.message
      this.logger.warn(`DDNS update failed: ${error.message}`)
    }
    return this.status
  }
}
