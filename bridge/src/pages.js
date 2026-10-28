// Self-contained HTML for the loopback admin page and the browser login page.
import { escapeHtml } from './util.js'

const BASE_CSS = `
:root{--bg:#f7f7f8;--panel:#fff;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#4d6bfe;--accent-weak:#eef1ff;--danger:#dc2626;--ok:#16a34a;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--panel:#1e1e21;--text:#ececf1;--muted:#a1a1aa;--border:#2e2e33;--accent:#6b84ff;--accent-weak:#23263a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:22px;margin:0 0 4px;font-weight:600}
h2{font-size:15px;margin:0 0 14px;font-weight:600}
.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:20px}
label{display:block;font-size:12px;color:var(--muted);margin:12px 0 4px}
input,select{width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);font:inherit}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
input[type=checkbox]{width:auto;margin-right:6px}
.check{display:flex;align-items:center;color:var(--text);font-size:14px}
button{border:0;border-radius:10px;padding:9px 16px;font:inherit;font-weight:500;cursor:pointer;background:var(--accent);color:#fff}
button.secondary{background:var(--accent-weak);color:var(--accent)}
button.danger{background:transparent;color:var(--danger);padding:4px 8px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.qr{display:flex;justify-content:center;background:#fff;border-radius:12px;padding:8px;margin-bottom:12px}
.qr svg{width:100%;max-width:280px;height:auto}
.code{font:600 34px/1 'SF Mono',Consolas,monospace;letter-spacing:6px;text-align:center;margin:6px 0}
.mono{font-family:'SF Mono',Consolas,monospace;font-size:12px;word-break:break-all}
.muted{color:var(--muted)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:var(--accent-weak);color:var(--accent)}
.pill.ok{background:rgba(22,163,74,.12);color:var(--ok)}
.pill.err{background:rgba(220,38,38,.12);color:var(--danger)}
table{width:100%;border-collapse:collapse}
td{padding:8px 4px;border-top:1px solid var(--border);vertical-align:top}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 16px;border-radius:10px;opacity:0;transition:opacity .2s}
.toast.show{opacity:1}
`

export function loginPageHtml({ name, next, error }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Remote</title><style>${BASE_CSS}
.box{max-width:380px;margin:12vh auto 0}.box .card{padding:28px}.err{color:var(--danger);margin-top:10px}
</style></head><body><main class="box"><div class="card">
<h1>DSH Remote</h1><p class="sub">${escapeHtml(name)}</p>
<form method="post" action="/__dsh_remote/login">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="code">配对码 / Pairing code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required autofocus>
<p class="muted" style="font-size:12px">在电脑上的 DSH 中输入 <b>/remote</b> 或打开管理页查看配对码。<br>Type <b>/remote</b> in DSH on your PC to see the code.</p>
<button type="submit" style="width:100%">连接 / Connect</button>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
</form></div></main></body></html>`
}

export function adminLockedHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Remote</title><style>${BASE_CSS}</style></head>
<body><main><div class="card"><h1>DSH Remote</h1><p class="sub">此页面需要管理员链接。请在电脑上的 DSH 对话框中输入 <b>/remote</b> 获取带令牌的链接。</p>
<p class="muted">This page needs the admin link. Type <b>/remote</b> in DSH to get it.</p></div></main></body></html>`
}

export function adminPageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Remote</title><style>${BASE_CSS}</style></head>
<body><main>
<h1>DSH Remote</h1><p class="sub" data-t="subtitle"></p>
<div class="grid">
  <section class="card">
    <h2 data-t="pairTitle"></h2>
    <div class="qr" id="qr"></div>
    <div class="code" id="code">------</div>
    <p class="muted" style="text-align:center;font-size:12px" id="expires"></p>
    <div class="row" style="justify-content:center"><button class="secondary" id="regen" data-t="regen"></button></div>
    <p class="muted" style="font-size:12px" data-t="pairHelp"></p>
  </section>
  <section class="card">
    <h2 data-t="statusTitle"></h2>
    <table id="status"></table>
  </section>
  <section class="card">
    <h2 data-t="generalTitle"></h2>
    <label data-t="name"></label><input id="s-name">
    <label data-t="port"></label><input id="s-port" type="number" min="1" max="65535">
    <label class="check"><input type="checkbox" id="s-tls"><span data-t="tls"></span></label>
    <label class="check"><input type="checkbox" id="s-mdns"><span data-t="mdns"></span></label>
    <label class="check"><input type="checkbox" id="s-upnp"><span data-t="upnp"></span></label>
    <label data-t="upnpPort"></label><input id="s-upnp-port" type="number" min="1" max="65535" placeholder="=">
    <div class="row" style="margin-top:16px"><button id="save-general" data-t="save"></button></div>
  </section>
  <section class="card">
    <h2 data-t="ddnsTitle"></h2>
    <label class="check"><input type="checkbox" id="d-enabled"><span data-t="ddnsEnabled"></span></label>
    <label data-t="provider"></label>
    <select id="d-provider">
      <option value="none">—</option><option value="duckdns">DuckDNS</option><option value="cloudflare">Cloudflare</option>
      <option value="dnspod">DNSPod (腾讯云)</option><option value="aliyun">阿里云 DNS</option>
      <option value="dyndns2">DynDNS2 (No-IP / Dynu / 花生壳)</option><option value="webhook">Webhook</option>
    </select>
    <label data-t="hostname"></label><input id="d-hostname" placeholder="myhome.duckdns.org">
    <label data-t="publicPort"></label><input id="d-port" type="number" min="1" max="65535" placeholder="=">
    <div id="d-options"></div>
    <label data-t="interval"></label><input id="d-interval" type="number" min="60" max="86400">
    <label class="check"><input type="checkbox" id="d-ipv6"><span>IPv6 (AAAA)</span></label>
    <div class="row" style="margin-top:16px"><button id="save-ddns" data-t="save"></button><button class="secondary" id="ddns-now" data-t="updateNow"></button></div>
  </section>
  <section class="card" style="grid-column:1/-1">
    <h2 data-t="devicesTitle"></h2>
    <table id="devices"></table>
  </section>
</div>
<div class="toast" id="toast"></div>
</main>
<script>
const zh = (navigator.language || '').toLowerCase().startsWith('zh')
const T = {
  subtitle: ['用 iPhone 远程控制这台电脑上的 DSH。', 'Control DSH on this PC from your iPhone.'],
  pairTitle: ['配对新设备', 'Pair a device'],
  regen: ['刷新配对码', 'New code'],
  pairHelp: ['在 DSH Remote App 中点「添加电脑」并扫描二维码；或手动输入电脑 IP、端口和配对码。配对码一次有效、10 分钟过期。', 'In the DSH Remote app tap "Add computer" and scan the code, or enter the IP, port and code manually. Codes are single-use and expire after 10 minutes.'],
  statusTitle: ['状态', 'Status'],
  generalTitle: ['连接设置', 'Connection'],
  name: ['显示名称', 'Display name'], port: ['端口', 'Port'],
  tls: ['TLS 加密（推荐，App 会固定证书指纹）', 'TLS encryption (recommended, pinned by the app)'],
  mdns: ['局域网自动发现（Bonjour/mDNS）', 'LAN discovery (Bonjour/mDNS)'],
  upnp: ['UPnP 自动端口映射（外网访问）', 'UPnP router port mapping (internet access)'],
  upnpPort: ['UPnP 外部端口（留空=同端口）', 'UPnP external port (empty = same)'],
  save: ['保存', 'Save'], updateNow: ['立即更新', 'Update now'],
  ddnsTitle: ['DDNS 动态域名', 'Dynamic DNS'], ddnsEnabled: ['启用 DDNS', 'Enable DDNS'],
  provider: ['服务商', 'Provider'], hostname: ['外网域名（App 外网连接用）', 'Public host name (used by the app)'],
  publicPort: ['外网端口（留空=自动）', 'Public port (empty = automatic)'], interval: ['检查间隔（秒）', 'Check interval (seconds)'],
  devicesTitle: ['已配对设备', 'Paired devices'], revoke: ['移除', 'Revoke'], none: ['暂无', 'None yet'],
  saved: ['已保存', 'Saved'], expiresIn: ['过期于 ', 'Expires '],
  listening: ['监听', 'Listening'], lan: ['局域网地址', 'LAN addresses'], fingerprint: ['证书指纹', 'Certificate fingerprint'],
  dsh: ['DSH 主机', 'DSH host'], upnpState: ['UPnP', 'UPnP'], ddnsState: ['DDNS', 'DDNS'], publicIp: ['公网 IP', 'Public IP'],
  remote: ['外网入口', 'Remote endpoint'], lastSeen: ['最后在线', 'Last seen'],
}
const t = k => (T[k] ? T[k][zh ? 0 : 1] : k)
document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t) })
const PROVIDER_FIELDS = {
  none: [], duckdns: [['domains', 'Domains (myhome)'], ['token', 'Token', 1]],
  cloudflare: [['apiToken', 'API Token (Zone.DNS edit)', 1], ['zone', 'Zone (example.com or zone id)'], ['record', 'Record (home.example.com)']],
  dnspod: [['tokenId', 'Token ID'], ['token', 'Token', 1], ['domain', 'Domain (example.com)'], ['subDomain', 'Sub domain (home / @)']],
  aliyun: [['accessKeyId', 'AccessKey ID'], ['accessKeySecret', 'AccessKey Secret', 1], ['domain', 'Domain (example.com)'], ['rr', 'RR (home / @)']],
  dyndns2: [['server', 'Server (dynupdate.no-ip.com)'], ['username', 'Username'], ['password', 'Password', 1], ['hostname', 'Hostname']],
  webhook: [['url', 'URL ({ip} {type} {hostname})'], ['method', 'Method (GET/POST)'], ['body', 'Body template']],
}
let settings
const $ = id => document.getElementById(id)
const toast = (msg) => { const el = $('toast'); el.textContent = msg; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2200) }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
async function api(path, init) {
  const res = await fetch('/api/' + path, { headers: { 'content-type': 'application/json' }, ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body
}
function renderOptions() {
  const p = $('d-provider').value
  const opts = settings.ddns.provider === p ? settings.ddns.options : {}
  $('d-options').innerHTML = PROVIDER_FIELDS[p].map(([key, label, secret]) =>
    '<label>' + esc(label) + '</label><input data-opt="' + key + '" ' + (secret ? 'type="password" ' : '') + 'value="' + esc(opts[key] ?? '') + '">').join('')
}
async function loadSettings() {
  settings = await api('settings')
  $('s-name').value = settings.name; $('s-port').value = settings.port
  $('s-tls').checked = settings.tls; $('s-mdns').checked = settings.mdns
  $('s-upnp').checked = settings.upnp.enabled; $('s-upnp-port').value = settings.upnp.externalPort ?? ''
  $('d-enabled').checked = settings.ddns.enabled; $('d-provider').value = settings.ddns.provider
  $('d-hostname').value = settings.ddns.hostname; $('d-port').value = settings.ddns.publicPort ?? ''
  $('d-interval').value = settings.ddns.intervalSeconds; $('d-ipv6').checked = settings.ddns.ipv6
  renderOptions()
}
async function loadPairing() {
  const p = await api('pairing')
  $('qr').innerHTML = p.qrSvg; $('code').textContent = p.code
  $('expires').textContent = t('expiresIn') + new Date(p.expiresAt).toLocaleTimeString()
}
const pill = (ok, text) => '<span class="pill ' + (ok ? 'ok' : 'err') + '">' + esc(text) + '</span>'
async function loadStatus() {
  const s = await api('status')
  const rows = [
    [t('listening'), s.listening ? pill(true, (s.tls ? 'TLS ' : 'TCP ') + s.port) : pill(false, s.listenError || 'off')],
    [t('dsh'), s.upstream.ok ? pill(true, 'OK') : pill(false, s.upstream.error || 'offline')],
    [t('lan'), s.lan.map(a => esc(a.address) + ' <span class="muted">' + esc(a.interface) + '</span>').join('<br>') || '—'],
    [t('fingerprint'), '<span class="mono">' + esc(s.fingerprint || '—') + '</span>'],
    [t('publicIp'), esc(s.ddns.publicIPv4 || '—') + (s.ddns.publicIPv6 ? '<br>' + esc(s.ddns.publicIPv6) : '')],
    [t('ddnsState'), s.ddns.state === 'ok' ? pill(true, s.ddns.message || 'OK') : s.ddns.state === 'error' ? pill(false, s.ddns.lastError) : '<span class="pill">' + esc(s.ddns.state) + '</span>'],
    [t('upnpState'), s.upnp.state === 'mapped' ? pill(true, s.upnp.externalPort + ' → ' + s.upnp.internalPort) : s.upnp.state === 'error' ? pill(false, s.upnp.error) : '<span class="pill">' + esc(s.upnp.state) + '</span>'],
    [t('remote'), s.remote.host ? esc(s.remote.host + ':' + s.remote.port) : '—'],
  ]
  $('status').innerHTML = rows.map(([k, v]) => '<tr><td class="muted" style="width:38%">' + k + '</td><td>' + v + '</td></tr>').join('')
}
async function loadDevices() {
  const list = await api('devices')
  $('devices').innerHTML = list.length ? list.map(d => '<tr><td><b>' + esc(d.name) + '</b><br><span class="muted">' + esc(d.lastAddress) + '</span></td><td class="muted">' + t('lastSeen') + '<br>' + new Date(d.lastSeenAt).toLocaleString() + '</td><td style="text-align:right"><button class="danger" data-id="' + d.id + '">' + t('revoke') + '</button></td></tr>').join('') : '<tr><td class="muted">' + t('none') + '</td></tr>'
  $('devices').querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => { await api('devices/' + b.dataset.id, { method: 'DELETE' }); loadDevices() })
}
async function save(patch) {
  try { await api('settings', { method: 'PUT', body: JSON.stringify(patch) }); toast(t('saved')); await loadSettings(); await loadStatus(); await loadPairing() }
  catch (e) { toast(e.message) }
}
$('d-provider').onchange = renderOptions
$('regen').onclick = async () => { await api('pairing/regenerate', { method: 'POST' }); loadPairing() }
$('save-general').onclick = () => save({ name: $('s-name').value, port: Number($('s-port').value), tls: $('s-tls').checked, mdns: $('s-mdns').checked, upnp: { enabled: $('s-upnp').checked, externalPort: $('s-upnp-port').value || null } })
$('save-ddns').onclick = () => {
  const options = {}
  document.querySelectorAll('[data-opt]').forEach(i => { options[i.dataset.opt] = i.value })
  save({ ddns: { enabled: $('d-enabled').checked, provider: $('d-provider').value, hostname: $('d-hostname').value, publicPort: $('d-port').value || null, intervalSeconds: Number($('d-interval').value), ipv6: $('d-ipv6').checked, options } })
}
$('ddns-now').onclick = async () => { try { await api('ddns/update', { method: 'POST' }); await loadStatus() } catch (e) { toast(e.message) } }
loadSettings().then(loadPairing).then(loadStatus).then(loadDevices).catch(e => toast(e.message))
setInterval(() => { loadPairing().catch(() => {}); loadStatus().catch(() => {}); loadDevices().catch(() => {}) }, 5000)
</script></body></html>`
}
