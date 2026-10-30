// electron-builder afterPack hook: copies the bundled AXe CLI (see fetch-axe.mjs) into the app's
// Resources before signing. ditto keeps the frameworks' symlinks and empty folders intact,
// which electron-builder's own resource copy does not.
const { execFileSync } = require('node:child_process')
const { existsSync, rmSync } = require('node:fs')
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
}
