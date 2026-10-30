// Downloads AXe (MIT, https://github.com/cameroncooke/AXe), the CLI R-Code uses to tap, swipe,
// type and read the UI of iOS Simulators, into vendor/axe so it ships inside the app.
// Pinned to the same release and checksum as AXe's official Homebrew formula.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = '1.8.0'
const URL = `https://github.com/cameroncooke/AXe/releases/download/v${VERSION}/AXe-macOS-homebrew-v${VERSION}.tar.gz`
const SHA256 = '87eb09cd49dfc74fa8f7f5a46a03dfe2f14518b01d819f6a4094eab0d344ea7f'

const root = join(import.meta.dirname, '..')
const dest = join(root, 'vendor', 'axe')
const stamp = join(dest, '.version')

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === VERSION) {
  console.log(`AXe ${VERSION} already in vendor/axe`)
  process.exit(0)
}

console.log(`Downloading AXe ${VERSION}…`)
const res = await fetch(URL, { redirect: 'follow' })
if (!res.ok) throw new Error(`AXe download failed: ${res.status} ${res.statusText}`)
const data = Buffer.from(await res.arrayBuffer())
const sum = createHash('sha256').update(data).digest('hex')
if (sum !== SHA256) throw new Error(`AXe checksum mismatch: expected ${SHA256}, got ${sum}`)

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
const archive = join(dest, 'axe.tar.gz')
writeFileSync(archive, data)
execFileSync('tar', ['-xzf', archive, '-C', dest])
rmSync(archive)
if (!existsSync(join(dest, 'axe'))) throw new Error('AXe archive did not contain the axe binary')
// Ad-hoc sign the frameworks and binary, as the Homebrew formula's post_install does.
for (const fw of readdirSync(join(dest, 'Frameworks')).filter((f) => f.endsWith('.framework'))) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', join(dest, 'Frameworks', fw)])
}
execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', join(dest, 'axe')])
writeFileSync(stamp, VERSION)
console.log(`AXe ${VERSION} ready in vendor/axe (sha256 verified)`)
