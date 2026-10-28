# DSH Remote

用 iPhone / iPad 远程控制电脑上的 **DSH（DeepSeek Harness Desktop）**。

> 本项目是社区项目，与 DeepSeek 官方无关；"DSH" 命名遵循 DeepSeek Harness 品牌指南。

- **界面与电脑完全一致**：手机里渲染的就是电脑上 DSH 自己提供的 Web 客户端——对话、**完整思考过程**（推理流 / trajectory）、工具调用、审批、计划、子代理、设置、插件市场全部原样呈现。
- **插件自动同步**：电脑上的 DSH 新装了插件，其客户端界面由电脑实时下发，手机刷新即同步，无需更新 App。
- **内网直连、超低延迟**：同一 Wi-Fi 下 Bonjour 自动发现、直连电脑，无中转服务器；TLS 证书固定 + TCP_NODELAY，零额外握手往返的隧道协议。
- **外网访问 + DDNS**：内置 DuckDNS / Cloudflare / DNSPod（腾讯云）/ 阿里云 DNS / DynDNS2（No-IP、Dynu、花生壳）/ Webhook，支持 UPnP 自动端口映射；App 自动在内网与外网之间切换（内网优先）。

## 组成

```
iPhone: DSH Remote App                       电脑: DSH Desktop 进程
┌──────────────────────────┐   TLS (证书固定)  ┌───────────────────────────────────────┐
│ WKWebView  → 127.0.0.1:x │ ═══════════════▶ │ dsh-remote-bridge 插件 (:39090)         │
│ 本地隧道 (Network.framework)│  "DSHR/1 设备令牌" │  ├ 配对 / 设备令牌 / 管理页 (:39091 仅本机) │
│ Bonjour 发现 / 线路竞速     │   + 原始 HTTP/WS  │  ├ mDNS 广播 · DDNS · UPnP              │
└──────────────────────────┘                  │  └ 反向代理 → DSH Web Host (127.0.0.1)   │
                                              │       (同进程取得启动令牌 → 浏览器会话)      │
                                              └───────────────────────────────────────┘
```

| 目录 | 内容 |
|---|---|
| [`bridge/`](bridge/) | Windows（及 macOS/Linux）端 DSH 插件，零依赖 Node.js（Cordis 插件 + bundle） |
| [`ios/`](ios/) | iOS App（SwiftUI + WKWebView + Network.framework），XcodeGen 工程 |
| [`.github/workflows/build.yml`](.github/workflows/build.yml) | 测试、真实 DSH 端到端测试、打包 Windows 插件与 IPA、发布 Release |

## 安装

从 [Releases](../../releases) 下载：

### 电脑端（Windows）
1. 安装 DSH Desktop，**启动一次**后从托盘**完全退出**。
2. 解压 `dsh-remote-bridge-<版本>-windows.zip`，双击 `install.cmd`。脚本会：
   - 找到 DSH Desktop 自带的 `dsh` 命令，执行 `dsh plugin --profile desktop add dsh-remote-bridge-<版本>.tgz`；
   - 请求管理员权限，放行入站 TCP 39090 与 UDP 5353（mDNS，仅专用/域网络；`-AllNetworks` 可包含公用网络）。
3. 重新打开 DSH Desktop，在任意对话中输入 **`/remote`**：显示配对码、局域网地址和**管理页链接**（含二维码、DDNS、UPnP、已配对设备）。

macOS / Linux 或 npm 版 `dsh web`：`dsh plugin --profile desktop add ./dsh-remote-bridge-<版本>.tgz`（npm CLI 用 `--profile web`）。

### iPhone
Release 中的 `DSHRemote-<版本>-unsigned.ipa` 未签名（没有 Apple 开发者证书无法直接分发），可用 AltStore / Sideloadly / TrollStore 安装；
若在仓库 Secrets 中配置 `IOS_CERT_P12_BASE64`、`IOS_CERT_PASSWORD`、`IOS_PROVISION_PROFILE_BASE64`、`IOS_TEAM_ID`，CI 会额外产出已签名 IPA（见 [`ios/scripts/sign-ipa.sh`](ios/scripts/sign-ipa.sh)）。也可以本地 `cd ios && xcodegen && open DSHRemote.xcodeproj` 用自己的账号运行。

打开 App → ＋ → **扫描二维码**（也可以用系统相机扫，会直接跳转 App），或"附近的电脑"/手动输入 IP + 配对码。

## 外网访问（DDNS）
1. 在管理页（或 App：右上角状态胶囊 → 设置 / DDNS）选择 DDNS 服务商并填写凭据，设置"外网域名"。
2. 打开 **UPnP 自动端口映射**，或在路由器上把外网端口转发到电脑的 `39090`。
3. App 会在内网不可达时自动走外网域名；状态胶囊显示当前线路（内网 / 外网）与实时延迟。

> 运营商无公网 IPv4 时可启用 IPv6（AAAA）或使用 Tailscale/ZeroTier 等组网（其地址可作为"内网地址"直连）。

## 安全模型
- 手机与插件之间：TLS 1.2+，自签证书由 App 按二维码中的 SHA-256 指纹**固定**；手动添加时显示指纹供核对。
- 配对码 6 位、一次性、10 分钟过期、错误次数限制；配对后每台设备拥有独立 256 位令牌（电脑只存哈希，手机存于钥匙串），可在管理页 / App 中随时吊销。
- 管理页只监听 `127.0.0.1`，需要 `/remote` 给出的令牌链接，并校验 Host（防 DNS 重绑定）与 Origin（防 CSRF）。
- DSH 自身的启动令牌与浏览器 Cookie 只在电脑进程内使用，**从不发给手机**；插件以本机浏览器身份访问 DSH，DSH 原有的 Host/Origin 防护保持开启。
- 获得配对的设备拥有与电脑上 DSH 窗口相同的权限（可让 Agent 执行命令），请只配对自己的设备。

## 开发
```bash
cd bridge && npm test                     # 33 个测试：隧道、代理改写、WebSocket、配对、DDNS、mDNS、QR …
node scripts/pack.mjs                     # 生成 dist/*.tgz 与 Windows 安装包目录
cd ios && xcodegen generate               # 生成 Xcode 工程（需 macOS）
```

已知限制：
- 在手机上选择"工作目录"时，若电脑端 DSH 使用原生文件夹对话框，对话框会弹在电脑上。
- iOS 在后台会挂起网络连接，回到前台后自动重连（DSH 客户端自带断线恢复）。
