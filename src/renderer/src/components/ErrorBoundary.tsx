import { Component, type ErrorInfo, type ReactNode } from 'react'

// Last line of defence: if any part of the UI throws while rendering, show what happened
// and a way back instead of an empty window.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[R-Code] UI crashed', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return <CrashScreen message={error.message} detail={error.stack} onRetry={() => this.setState({ error: null })} />
  }
}

export function CrashScreen({ message, detail, onRetry }: { message: string; detail?: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="drag flex h-full items-center justify-center bg-frame p-8">
      <div className="no-drag w-full max-w-[520px] rounded-2xl border border-line bg-panel p-6 text-fg">
        <div className="text-[16px] font-semibold">Something went wrong</div>
        <p className="mt-1.5 text-[13px] text-fg-3">R-Code hit an unexpected error. Your conversations are saved — reloading usually fixes it.</p>
        <pre className="selectable mt-4 max-h-48 overflow-auto rounded-lg bg-field p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{detail || message}</pre>
        <div className="mt-5 flex justify-end gap-2">
          {onRetry && (
            <button onClick={onRetry} className="h-8 rounded-lg px-3 text-[13px] text-fg-2 hover:bg-frame-hover">
              Try again
            </button>
          )}
          <button onClick={() => location.reload()} className="h-8 rounded-lg bg-[var(--accent)] px-3.5 text-[13px] font-medium text-white">
            Reload R-Code
          </button>
        </div>
      </div>
    </div>
  )
}
