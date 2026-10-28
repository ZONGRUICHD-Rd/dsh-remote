## DSH Remote v{{VERSION}}

用 iPhone / iPad 远程控制电脑上的 DSH（DeepSeek Harness Desktop）。界面就是电脑上 DSH 自己的 Web 客户端：对话、完整思考过程、工具调用、审批、设置、插件界面全部一致；电脑上新装的插件，手机刷新即同步。

### 下载
| 文件 | 用途 |
|---|---|
| `dsh-remote-bridge-{{VERSION}}-windows.zip` | **Windows 端插件**：解压后双击 `install.cmd` 安装到 DSH Desktop |
| `dsh-remote-bridge-{{VERSION}}.tgz` | 插件包本体（macOS/Linux 或 npm CLI：`dsh plugin --profile desktop add ./dsh-remote-bridge-{{VERSION}}.tgz`） |
| `DSHRemote-{{VERSION}}-unsigned.ipa` | **iOS App**（未签名）：用 AltStore / Sideloadly / TrollStore 等自签安装 |

### 快速开始
1. 安装 DSH Desktop 并启动一次后**完全退出**，双击 `install.cmd`。
2. 重新打开 DSH Desktop，在任意对话里输入 `/remote`，打开给出的管理页链接。
3. iPhone 上打开 DSH Remote → ＋ → 扫描二维码。

- **内网直连**：手机与电脑同一 Wi-Fi 时自动直连（Bonjour 发现 + TLS 证书固定，TCP_NODELAY）。
- **外网访问**：在管理页或 App「设置 / DDNS」中配置 DDNS（DuckDNS / Cloudflare / DNSPod / 阿里云 / No-IP 等）并开启 UPnP 或在路由器上映射端口 `39090`。
