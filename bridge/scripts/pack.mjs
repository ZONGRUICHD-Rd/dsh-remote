// Build release artifacts into bridge/dist:
//   dsh-remote-bridge-<version>.tgz            (npm/pnpm package for `dsh plugin add`)
//   dsh-remote-bridge-<version>-windows/       (tgz + install/uninstall scripts; zipped by CI)
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
copyFileSync(join(root, '..', 'LICENSE'), join(root, 'LICENSE'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['pack', '--pack-destination', dist], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
const tgz = `dsh-remote-bridge-${version}.tgz`
const win = join(dist, `dsh-remote-bridge-${version}-windows`)
mkdirSync(win)
copyFileSync(join(dist, tgz), join(win, tgz))
for (const file of ['install.ps1', 'install.cmd', 'uninstall.ps1', 'uninstall.cmd']) copyFileSync(join(root, 'windows', file), join(win, file))
writeFileSync(join(win, 'README.txt'), [
  `DSH Remote bridge ${version} for DSH Desktop (Windows)`,
  '',
  '安装 / Install:',
  '  1. 安装并至少启动一次 DSH Desktop，然后完全退出它（托盘 → 退出）。',
  '     Install DSH Desktop, launch it once, then quit it completely.',
  '  2. 双击 install.cmd。 Double-click install.cmd.',
  '  3. 重新打开 DSH Desktop，在对话框输入 /remote 获取配对码和管理页链接。',
  '     Reopen DSH Desktop and type /remote to get the pairing code and admin link.',
  '  4. 在 iPhone 的 DSH Remote 中扫描管理页二维码。 Scan the QR code with the DSH Remote iOS app.',
  '',
  'npm CLI (`dsh web`) users: install.ps1 -DshProfile web',
  'Uninstall: uninstall.cmd',
  '',
].join('\r\n'))
console.log(`packed ${tgz} and ${win}`)
