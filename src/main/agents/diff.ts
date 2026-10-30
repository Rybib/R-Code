import { existsSync, readFileSync, statSync } from 'node:fs'
import { structuredPatch } from 'diff'

/** A compact unified diff (hunks only) between two texts. */
export function unifiedDiff(oldText: string, newText: string, context = 2): string {
  const patch = structuredPatch('a', 'b', oldText, newText, '', '', { context })
  return patch.hunks
    .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines.filter((l) => !l.startsWith('\\'))].join('\n'))
    .join('\n')
}

/** Current contents of a file (for diffing a full overwrite), or '' if missing/too big. */
export function currentContents(path: string | undefined): string {
  try {
    if (!path || !existsSync(path) || statSync(path).size > 2_000_000) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
