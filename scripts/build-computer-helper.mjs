// Compiles native/rcode-computer.swift, the small helper behind the agents' `computer` tool (mouse,
// keyboard and permission checks), into vendor/rcode-computer so it ships inside the app.
// Needs Xcode or its Command Line Tools. With --optional (used by `npm run dev`) a missing
// compiler only disables computer control instead of stopping the build.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const optional = process.argv.includes('--optional')
const root = join(import.meta.dirname, '..')
const src = join(root, 'native', 'rcode-computer.swift')
const dest = join(root, 'vendor', 'rcode-computer')
const bin = join(dest, 'rcode-computer')
const stamp = join(dest, '.source-hash')

const hash = createHash('sha256').update(readFileSync(src)).digest('hex')
if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash) {
  console.log('rcode-computer is up to date')
  process.exit(0)
}

try {
  mkdirSync(dest, { recursive: true })
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos13`, src, '-o', bin], { stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', bin])
  writeFileSync(stamp, hash)
  console.log('Built vendor/rcode-computer/rcode-computer')
} catch (err) {
  if (!optional) throw err
  console.warn('Could not build the computer-control helper (it needs Xcode or its Command Line Tools). Computer control is unavailable in this dev build.')
}
