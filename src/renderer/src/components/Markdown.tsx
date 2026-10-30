import { memo, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { api } from '../lib/api'

let highlighterPromise: Promise<any> | null = null
const LANGS = ['ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'shell', 'python', 'swift', 'rust', 'go', 'css', 'html', 'md', 'yaml', 'toml', 'sql', 'diff', 'java', 'kotlin', 'c', 'cpp', 'ruby', 'php']

function highlighter(): Promise<any> {
  highlighterPromise ??= import('shiki').then(({ createHighlighter }) =>
    createHighlighter({ themes: ['github-dark-default', 'github-light-default'], langs: LANGS })
  )
  return highlighterPromise
}

function isDark(): boolean {
  return document.documentElement.dataset.theme !== 'light'
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    const l = (lang ?? '').toLowerCase()
    const language = LANGS.includes(l) ? l : l === 'sh' || l === 'zsh' ? 'bash' : l === 'typescript' ? 'ts' : l === 'javascript' ? 'js' : l === 'py' ? 'python' : null
    if (!language || code.length > 60000) return
    highlighter()
      .then((h) => {
        if (alive) setHtml(h.codeToHtml(code, { lang: language, theme: isDark() ? 'github-dark-default' : 'github-light-default' }))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [code, lang])
  return (
    <div className="code-block group/code relative my-3 overflow-hidden rounded-xl border border-line-soft bg-[var(--code-bg)]">
      <div className="flex h-8 items-center justify-between border-b border-line-soft px-3 text-[11.5px] text-fg-3">
        <span className="font-mono">{lang || 'text'}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-raised-2 hover:text-fg"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {html ? (
        <div className="selectable" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="selectable">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="prose-chat selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-([\w+-]+)/.exec(className || '')
            const content = String(children ?? '')
            const isBlock = !!match || content.includes('\n')
            if (!isBlock) return <code {...props}>{children}</code>
            return <CodeBlock code={content.replace(/\n$/, '')} lang={match?.[1]} />
          },
          pre({ children }) {
            return <>{children}</>
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href) void api.openExternal(href)
                }}
              >
                {children}
              </a>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
