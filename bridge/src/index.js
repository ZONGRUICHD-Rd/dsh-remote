// DSH Remote bridge — Cordis plugin entry.
//
// Mounted inside the DSH Desktop (or `dsh web`) process. It reaches the Web
// Host's own listener over loopback, so the phone renders exactly the UI,
// client plugins, and live session streams the desktop window shows.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RemoteBridge } from './server.js'
import { Upstream } from './upstream.js'
import { BRIDGE_VERSION, createLogger } from './util.js'

export const name = 'dsh-remote-bridge'

/** Services the bridge proxies to: the Web Host listener and its browser authentication. */
export const inject = ['webServer', 'connection']

const DEFAULTS = {
  port: 39090,
  adminPort: 39091,
  bindHost: '0.0.0.0',
  tls: true,
  mdns: true,
  name: '',
  stateDir: '',
}

function validate(value) {
  const input = value ?? {}
  const issues = []
  if (typeof input !== 'object' || Array.isArray(input)) return { issues: [{ message: 'dsh-remote-bridge config must be an object' }] }
  const out = { ...DEFAULTS }
  for (const [key, raw] of Object.entries(input)) {
    if (!(key in DEFAULTS)) {
      issues.push({ message: `unknown option "${key}"`, path: [key] })
      continue
    }
    if (raw === undefined || raw === null) continue
    if (key === 'port' || key === 'adminPort') {
      if (!Number.isInteger(raw) || raw < 0 || raw > 65535) issues.push({ message: `${key} must be a port number`, path: [key] })
      else out[key] = raw
    } else if (key === 'tls' || key === 'mdns') {
      if (typeof raw !== 'boolean') issues.push({ message: `${key} must be a boolean`, path: [key] })
      else out[key] = raw
    } else if (typeof raw !== 'string') {
      issues.push({ message: `${key} must be a string`, path: [key] })
    } else {
      out[key] = raw
    }
  }
  if (out.bindHost === '') issues.push({ message: 'bindHost must not be empty', path: ['bindHost'] })
  return issues.length ? { issues } : { value: out }
}

/**
 * Standard Schema implementation (what Cordis validates plugin config with),
 * written by hand so the package has no runtime dependencies.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-remote',
    validate,
  },
}

function stateDirFor(config) {
  if (config.stateDir) return config.stateDir
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-remote')
}

function commandText(bridge) {
  const info = bridge.pairingInfo()
  const status = bridge.status()
  const lines = [
    `DSH Remote ${BRIDGE_VERSION} — ${status.name}`,
    '',
    `配对码 Pairing code: ${info.code}`,
    `管理页（二维码 / DDNS / 设备）Admin page: ${bridge.adminUrl ?? 'unavailable'}`,
    '',
    `局域网 LAN: ${info.lan.map(ip => `${ip}:${info.port}`).join(', ') || 'no network'}`,
  ]
  if (info.remote.host) lines.push(`外网 Remote: ${info.remote.host}:${info.remote.port}`)
  if (info.fingerprint) lines.push(`证书指纹 Fingerprint: ${info.fingerprint.match(/.{1,4}/g).slice(0, 8).join(' ')} …`)
  if (status.listenError) lines.push('', `⚠ ${status.listenError}`)
  lines.push('', '在 iPhone 上打开 DSH Remote → 添加电脑 → 扫描管理页二维码，或手动输入以上地址与配对码。')
  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {typeof DEFAULTS} config
 */
export function apply(ctx, config) {
  const resolved = validate(config).value ?? { ...DEFAULTS }
  const logger = createLogger(ctx)
  const upstream = new Upstream({
    getOrigin: () => {
      const port = ctx.webServer.port
      if (!port) throw new Error('DSH web server is not listening yet')
      return `${ctx.webServer.protocol ?? 'http:'}//127.0.0.1:${port}`
    },
    authenticatedUrl: origin => ctx.connection.authenticatedUrl(origin),
    logger,
  })
  const bridge = new RemoteBridge({ config: resolved, stateDir: stateDirFor(resolved), upstream, logger })

  ctx.effect(async () => {
    try {
      await bridge.start()
    } catch (error) {
      // Never take DSH down with the bridge: report and keep the host running.
      logger.error(`DSH Remote failed to start: ${error?.stack ?? error}`)
    }
    return async () => {
      await bridge.stop().catch(error => logger.warn(`stop failed: ${error.message}`))
      upstream.close()
    }
  }, 'dsh-remote-bridge: listeners')

  // `/remote` in any DSH chat shows the pairing code and the admin link.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-remote-bridge/remote',
      name: 'remote',
      description: 'DSH Remote: show the iPhone pairing code and admin page',
      recordInput: false,
      handler: () => ({ kind: 'success', text: commandText(bridge) }),
    })
  })
}
