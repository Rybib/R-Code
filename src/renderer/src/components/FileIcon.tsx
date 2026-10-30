import { Icon } from '@iconify/react/offline'
import { EXT_ICON, FILE_ICONS, NAME_ICON } from '../lib/file-icons.gen'

export function iconNameFor(path: string | undefined): string {
  if (!path) return 'default-file'
  const base = path.split('/').pop()!.toLowerCase()
  if (NAME_ICON[base]) return NAME_ICON[base]
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  return EXT_ICON[ext] ?? 'default-file'
}

/** Language/file-type icon (Swift bird, Python snake, …) for a file path. */
export function FileIcon({ path, size = 14, className }: { path?: string; size?: number; className?: string }): React.JSX.Element {
  const data = FILE_ICONS[iconNameFor(path)] ?? FILE_ICONS['default-file']
  return <Icon icon={data} width={size} height={size} className={className} />
}

export function DiffCounts({ added, removed, className }: { added?: number; removed?: number; className?: string }): React.JSX.Element | null {
  if (!added && !removed) return null
  return (
    <span className={`font-mono text-[11.5px] tabular-nums ${className ?? ''}`}>
      <span className="text-ok">+{added ?? 0}</span> <span className="text-danger">−{removed ?? 0}</span>
    </span>
  )
}
