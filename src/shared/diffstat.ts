/** Count added/removed lines in a unified-style diff ("+"/"-" prefixed lines). */
export function diffStats(diff: string | undefined): { added: number; removed: number } {
  let added = 0
  let removed = 0
  if (!diff) return { added, removed }
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}
