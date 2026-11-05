import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron'
import type { ToolDef, ToolResult } from './registry'
import { bool, num, str } from './registry'

// R-Code's built-in browser: a real Chromium view docked in the right panel. The user can
// browse in it, and agents drive the same view through the browser_* tools — great for
// checking a local dev server, reading docs, or verifying UI work.

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type Notify = (channel: string, payload: unknown) => void

const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],summary,[onclick]';
  let n = 0; const lines = [];
  document.querySelectorAll('[data-rcode-ref]').forEach(e => e.removeAttribute('data-rcode-ref'));
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const ref = 'e' + (++n); el.setAttribute('data-rcode-ref', ref);
    const tag = el.tagName.toLowerCase(); const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const extra = tag === 'input' ? ' type=' + (el.type || 'text') : tag === 'a' ? ' href=' + (el.getAttribute('href') || '').slice(0, 80) : '';
    lines.push('[' + ref + '] ' + role + ' "' + label + '"' + extra);
    if (n >= 250) break;
  }
  const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 12000);
  return { title: document.title, url: location.href, elements: lines.join('\\n'), text };
})()`

/** executeJavaScript never settles if the page is hung or sitting on an alert(); don't let a tool call hang with it. */
function runJs<T>(wc: Electron.WebContents, code: string, ms = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`The page did not respond within ${Math.round(ms / 1000)}s (it may be busy or showing a dialog).`)), ms)
    wc.executeJavaScript(code, true).then(
      (v) => (clearTimeout(t), resolve(v as T)),
      (e) => (clearTimeout(t), reject(e))
    )
  })
}

export class BrowserController {
  view: WebContentsView | null = null
  private bounds: Rectangle | null = null
  /** The window the view is attached to (on macOS the window can close and reopen while the app lives on). */
  private attachedTo: BrowserWindow | null = null
  private consoleLog: string[] = []

  private get visible(): boolean {
    return !!this.attachedTo && !this.attachedTo.isDestroyed()
  }

  constructor(
    private getWin: () => BrowserWindow | null,
    private notify: Notify
  ) {}

  private ensure(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const view = new WebContentsView({ webPreferences: { partition: 'persist:rcode-browser', sandbox: true, contextIsolation: true } })
    view.setBackgroundColor('#ffffff')
    const wc = view.webContents
    const push = (): void => this.notify('browser-state', this.state())
    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    wc.on('did-navigate', push)
    wc.on('did-navigate-in-page', push)
    wc.on('page-title-updated', push)
    wc.on('console-message', (e: any) => {
      this.consoleLog.push(`[${e.level}] ${e.message}`)
      if (this.consoleLog.length > 200) this.consoleLog.shift()
    })
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    // A crashed page leaves a dead view; reload it rather than leaving agents and the user stuck.
    wc.on('render-process-gone', (_e, details) => {
      this.consoleLog.push(`[error] The page's renderer process ended (${details.reason}); reloading.`)
      if (details.reason !== 'clean-exit') setTimeout(() => !wc.isDestroyed() && wc.reload(), 300)
    })
    this.view = view
    return view
  }

  state(): BrowserState {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed()) return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  /** Renderer reports where the panel's viewport is; null hides the view. */
  setBounds(bounds: Rectangle | null): void {
    const win = this.getWin()
    if (!win) return
    this.bounds = bounds
    if (!bounds || bounds.width < 2) {
      if (this.view && this.visible) this.attachedTo!.contentView.removeChildView(this.view)
      this.attachedTo = null
      return
    }
    const view = this.ensure()
    if (this.attachedTo !== win) {
      if (this.visible) this.attachedTo!.contentView.removeChildView(view)
      win.contentView.addChildView(view)
      this.attachedTo = win
    }
    view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) })
  }

  async navigate(url: string): Promise<void> {
    const view = this.ensure()
    let target = url.trim()
    if (!/^[a-z]+:/i.test(target)) {
      target = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(target) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(target) ? `http://${target}` : `https://duckduckgo.com/?q=${encodeURIComponent(target)}`
    }
    try {
      await view.webContents.loadURL(target)
    } catch (err: any) {
      // ERR_ABORTED happens on redirects; anything else is real.
      if (!/ERR_ABORTED/.test(String(err?.message))) throw err
    }
  }

  back(): void {
    this.view?.webContents.navigationHistory.goBack()
  }
  forward(): void {
    this.view?.webContents.navigationHistory.goForward()
  }
  reload(): void {
    this.view?.webContents.reload()
  }

  private async waitIdle(ms = 8000): Promise<void> {
    const wc = this.view?.webContents
    if (!wc || !wc.isLoading()) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      wc.once('did-stop-loading', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  async snapshot(): Promise<{ title: string; url: string; elements: string; text: string }> {
    this.ensure()
    await this.waitIdle()
    return runJs(this.view!.webContents, SNAPSHOT_JS)
  }

  async eval(js: string): Promise<unknown> {
    this.ensure()
    return runJs(this.view!.webContents, js)
  }

  async screenshot(): Promise<string> {
    const view = this.ensure()
    if (!this.visible) this.notify('panel-open', 'browser')
    await new Promise((r) => setTimeout(r, this.visible ? 50 : 600))
    await this.waitIdle()
    const img = await view.webContents.capturePage()
    const size = img.getSize()
    const scaled = size.width > 1280 ? img.resize({ width: 1280 }) : img
    return scaled.toPNG().toString('base64')
  }

  consoleMessages(): string {
    return this.consoleLog.slice(-60).join('\n') || '(no console messages)'
  }

  private bg: WebContentsView | null = null

  /**
   * Load a page in a hidden browser (same profile/cookies as the visible one) and read it.
   * Used for plain web searches and page reads, so they don't pop the browser panel open or
   * navigate away from whatever the user has there.
   */
  async readInBackground<T = { title: string; url: string; elements: string; text: string }>(url: string, settleMs = 0, script = SNAPSHOT_JS): Promise<T> {
    if (!this.bg || this.bg.webContents.isDestroyed()) {
      this.bg = new WebContentsView({ webPreferences: { partition: 'persist:rcode-browser', sandbox: true, contextIsolation: true, backgroundThrottling: false } })
      this.bg.webContents.setAudioMuted(true)
      this.bg.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    }
    const wc = this.bg.webContents
    try {
      await wc.loadURL(url)
    } catch (err: any) {
      if (!/ERR_ABORTED/.test(String(err?.message))) throw err
    }
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 8000)
        wc.once('did-stop-loading', () => (clearTimeout(t), resolve()))
      })
    }
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs))
    return runJs<T>(wc, script)
  }
}

export function browserTools(b: BrowserController, notify: Notify): ToolDef[] {
  const show = (): void => notify('panel-open', 'browser')
  const page = async (prefix: string): Promise<ToolResult> => {
    const s = await b.snapshot()
    return { text: `${prefix}\nURL: ${s.url}\nTitle: ${s.title}\n\nInteractive elements (use the [ref] with browser_click / browser_type):\n${s.elements || '(none)'}\n\nPage text:\n${s.text}` }
  }
  return [
    {
      name: 'browser_open',
      description:
        "Open a URL in R-Code's built-in browser (visible to the user in the side panel). Works with local dev servers (http://localhost:3000), file:// URLs and the web. Returns the page's text and its interactive elements with [ref] ids. Use it when the user should see a page or for interactive web tasks; for plain lookups (searching, reading docs), use your web search/fetch tools, which don't open the panel.",
      schema: { type: 'object', properties: { url: str('URL to open, e.g. http://localhost:5173') }, required: ['url'] },
      async run(_ctx, args) {
        show()
        await b.navigate(String(args.url))
        return page('Opened.')
      }
    },
    {
      name: 'browser_snapshot',
      description: 'Read the current page in the built-in browser: URL, title, visible text and interactive elements with [ref] ids.',
      schema: { type: 'object', properties: {} },
      async run() {
        return page('Current page.')
      }
    },
    {
      name: 'browser_click',
      description: 'Click an element in the built-in browser by its [ref] from browser_snapshot/browser_open, or by visible text.',
      schema: { type: 'object', properties: { ref: str('Element ref like e12'), text: str('Alternatively, visible text of the element to click') } },
      async run(_ctx, args) {
        show()
        const ok = await b.eval(`(() => {
          const ref = ${JSON.stringify(args.ref ?? '')}; const text = ${JSON.stringify(args.text ?? '')};
          let el = ref ? document.querySelector('[data-rcode-ref="' + ref + '"]') : null;
          if (!el && text) el = [...document.querySelectorAll('a,button,[role=button],input[type=submit],summary,label')].find(e => (e.innerText || e.value || '').trim().toLowerCase().includes(text.toLowerCase()));
          if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true;
        })()`)
        if (!ok) return { text: 'Element not found. Call browser_snapshot to get fresh refs.', isError: true }
        await new Promise((r) => setTimeout(r, 400))
        return page('Clicked.')
      }
    },
    {
      name: 'browser_type',
      description: 'Type into an input/textarea in the built-in browser (by [ref]), optionally pressing Enter to submit.',
      schema: { type: 'object', properties: { ref: str('Element ref like e3'), text: str('Text to enter'), submit: bool('Press Enter afterwards') }, required: ['ref', 'text'] },
      async run(_ctx, args) {
        show()
        const ok = await b.eval(`(() => {
          const el = document.querySelector('[data-rcode-ref="${String(args.ref).replace(/"/g, '')}"]');
          if (!el) return false; el.focus();
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (el.isContentEditable) el.textContent = ${JSON.stringify(String(args.text))}; else if (setter) setter.call(el, ${JSON.stringify(String(args.text))}); else el.value = ${JSON.stringify(String(args.text))};
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          if (${args.submit ? 'true' : 'false'}) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); el.form?.requestSubmit?.(); }
          return true;
        })()`)
        if (!ok) return { text: 'Element not found. Call browser_snapshot to get fresh refs.', isError: true }
        await new Promise((r) => setTimeout(r, args.submit ? 800 : 150))
        return page('Typed.')
      }
    },
    {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the built-in browser so you can see the page visually (layout, styling, rendering bugs).',
      schema: { type: 'object', properties: {} },
      async run() {
        const data = await b.screenshot()
        const s = b.state()
        return { text: `Screenshot of ${s.url}`, image: { data, mimeType: 'image/png' } }
      }
    },
    {
      name: 'browser_eval',
      description: 'Run JavaScript in the current page of the built-in browser and return the JSON-serializable result. Use for inspecting the DOM or app state.',
      schema: { type: 'object', properties: { code: str('A JS expression or IIFE; its value is returned') }, required: ['code'] },
      async run(_ctx, args) {
        const res = await b.eval(String(args.code))
        let text: string
        try {
          text = JSON.stringify(res, null, 2) ?? 'undefined'
        } catch {
          text = String(res)
        }
        return { text: text.slice(0, 20000) }
      }
    },
    {
      name: 'browser_console',
      description: 'Recent console messages (errors, warnings, logs) from the page in the built-in browser.',
      schema: { type: 'object', properties: { _: num('unused') } },
      async run() {
        return { text: b.consoleMessages() }
      }
    }
  ]
}
