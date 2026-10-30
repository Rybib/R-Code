import type { Settings } from '@shared/types'
import type { BrowserController } from './browser'
import type { ToolDef } from './registry'
import { num, str } from './registry'

// Web access for the built-in Pi agent (Claude Code and Codex bring their own).
// Search goes through a real search API when you've configured one (Brave, Tavily,
// Ollama, or your own SearXNG); otherwise the agent searches in R-Code's visible
// built-in browser, just like you would.

interface Hit {
  title: string
  url: string
  snippet: string
}

async function searchApi(settings: Settings, query: string, count: number): Promise<{ provider: string; hits: Hit[] } | null> {
  const keys = settings.searchKeys ?? {}
  const order = settings.searchProvider === 'auto' ? (['brave', 'tavily', 'ollama', 'searxng'] as const) : ([settings.searchProvider] as const)
  for (const p of order) {
    try {
      if (p === 'brave' && keys.brave) {
        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
          headers: { accept: 'application/json', 'x-subscription-token': keys.brave },
          signal: AbortSignal.timeout(15000)
        })
        const j: any = await res.json()
        return { provider: 'Brave Search', hits: (j.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: stripTags(r.description ?? '') })) }
      }
      if (p === 'tavily' && keys.tavily) {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.tavily}` },
          body: JSON.stringify({ query, max_results: count }),
          signal: AbortSignal.timeout(20000)
        })
        const j: any = await res.json()
        return { provider: 'Tavily', hits: (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? '' })) }
      }
      if (p === 'ollama' && (keys.ollama || process.env.OLLAMA_API_KEY)) {
        const res = await fetch('https://ollama.com/api/web_search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.ollama || process.env.OLLAMA_API_KEY}` },
          body: JSON.stringify({ query, max_results: count }),
          signal: AbortSignal.timeout(20000)
        })
        const j: any = await res.json()
        return { provider: 'Ollama web search', hits: (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 400) })) }
      }
      if (p === 'searxng' && settings.searxngUrl) {
        const res = await fetch(`${settings.searxngUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, { signal: AbortSignal.timeout(15000) })
        const j: any = await res.json()
        return { provider: 'SearXNG', hits: (j.results ?? []).slice(0, count).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? '' })) }
      }
    } catch {
      /* try the next provider */
    }
  }
  return null
}

/** Pulls title / URL / snippet for each organic result off a DuckDuckGo results page. */
const DDG_RESULTS_JS = `(() => [...document.querySelectorAll('article[data-testid="result"], li[data-layout="organic"]')].map((r) => {
  const a = r.querySelector('a[data-testid="result-title-a"]') || r.querySelector('h2 a');
  const snip = r.querySelector('[data-result="snippet"]') || r.querySelector('[data-testid="result-snippet"]');
  return a ? { title: (a.innerText || '').trim(), url: a.href, snippet: ((snip && snip.innerText) || '').trim().slice(0, 300) } : null;
}).filter((h) => h && /^https?:/.test(h.url) && !/duckduckgo\\.com/.test(h.url)))()`

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** Readable text from an HTML page: drops scripts/styles/nav chrome, keeps headings and links. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const main = s.match(/<(main|article)[\s\S]*?<\/\1>/i)
  if (main && main[0].length > 500) s = main[0]
  s = s
    .replace(/<h([1-6])[^>]*>/gi, (_m, l) => '\n\n' + '#'.repeat(Number(l)) + ' ')
    .replace(/<\/(p|div|section|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<a [^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => `${stripTags(text).trim()} (${href})`)
  return stripTags(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

export function webTools(getSettings: () => Settings, browser: BrowserController): ToolDef[] {
  return [
    {
      name: 'search_web',
      description:
        'Search the web. Returns titles, URLs and snippets. Follow up with fetch_url to read a result. Uses your configured search API, or a normal search in R-Code’s background browser. Does not open the browser panel; use browser_open when the user should see a page.',
      schema: { type: 'object', properties: { query: str('What to search for'), count: num('Number of results (default 8)') }, required: ['query'] },
      agents: ['pi'],
      async run(_ctx, args) {
        const query = String(args.query)
        const count = Math.min(Number(args.count) || 8, 20)
        const api = await searchApi(getSettings(), query, count)
        if (api && api.hits.length) {
          return { text: `Results from ${api.provider} for "${query}":\n\n` + api.hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n') }
        }
        // No API configured: run a normal search in R-Code's hidden background browser.
        const hits = await browser.readInBackground<Hit[]>(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, 1200, DDG_RESULTS_JS)
        if (!hits.length) return { text: `No results found for "${query}".`, isError: true }
        return {
          text:
            `Results for "${query}" (searched in the background browser; add a Brave/Tavily/Ollama key in Settings → Browser, iOS & Web for faster results):\n\n` +
            hits.slice(0, count).map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n')
        }
      }
    },
    {
      name: 'fetch_url',
      description: 'Fetch a web page (or JSON/text URL) and return its readable text. Set render=true for JavaScript-heavy sites to render it in a hidden browser instead. Does not open the browser panel.',
      schema: { type: 'object', properties: { url: str('The URL to read'), render: { type: 'boolean', description: 'Render with the built-in browser' } }, required: ['url'] },
      agents: ['pi'],
      async run(_ctx, args) {
        const url = String(args.url)
        if (!args.render) {
          try {
            const res = await fetch(url, { headers: { 'user-agent': 'R-Code/0.1 (+desktop coding agent)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
            const type = res.headers.get('content-type') ?? ''
            const body = await res.text()
            const text = type.includes('html') ? htmlToText(body) : body
            if (text.trim().length > 200 || !type.includes('html')) return { text: `${res.status} ${url}\n\n${text.slice(0, 40000)}` }
          } catch (err: any) {
            if (!/html/.test(String(err))) {
              /* fall back to the browser below */
            }
          }
        }
        const snap = await browser.readInBackground(url, 600)
        return { text: `${snap.url}\n${snap.title}\n\n${snap.text}` }
      }
    }
  ]
}
