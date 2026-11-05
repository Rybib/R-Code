// electron-builder afterPack hook: copies the bundled AXe CLI (see fetch-axe.mjs) and the
// computer-control helper (see build-computer-helper.mjs) into the app's Resources before signing. ditto keeps the frameworks' symlinks and empty folders intact,
// which electron-builder's own resource copy does not.
const { execFileSync } = require('node:child_process')
const { chmodSync, existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const src = join(context.packager.projectDir, 'vendor', 'axe')
  if (!existsSync(join(src, 'axe'))) throw new Error('vendor/axe is missing; run `npm run fetch:axe` first')
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const dest = join(app, 'Contents', 'Resources', 'axe')
  rmSync(dest, { recursive: true, force: true })
  execFileSync('ditto', [src, dest])
  rmSync(join(dest, '.version'), { force: true })

  const helper = join(context.packager.projectDir, 'vendor', 'rcode-computer', 'rcode-computer')
  if (!existsSync(helper)) throw new Error('vendor/rcode-computer is missing; run `npm run build:computer` first')
  execFileSync('ditto', [helper, join(app, 'Contents', 'Resources', 'rcode-computer')])

  // The terminal's PTY helper must be executable, and npm doesn't always keep the bit
  // ("posix_spawnp failed" otherwise). Fix it here, before signing, rather than at runtime.
  const prebuilds = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const spawnHelper = join(prebuilds, dir, 'spawn-helper')
      if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755)
    }
  }
}
