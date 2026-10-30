import { createServer } from 'node:http'
import type { BrowserWindow, WebContentsView } from 'electron'

// Dev-only remote control used for automated UI checks: evaluate JS in the renderer
// and capture screenshots. Enabled only for unpackaged builds with RCODE_AUTOMATION_PORT.
export function startDevAutomation(getWin: () => BrowserWindow | null, port: number, getView: () => WebContentsView | null = () => null): void {
  createServer(async (req, res) => {
    const win = getWin()
    if (!win) return res.writeHead(503).end('no window')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/shot-browser') {
        const view = getView()
        if (!view) return res.writeHead(404).end('no browser view')
        const img = await view.webContents.capturePage()
        res.writeHead(200, { 'content-type': 'image/png' }).end(img.toPNG())
      } else if (url.pathname === '/shot') {
        const img = await win.webContents.capturePage()
        res.writeHead(200, { 'content-type': 'image/png' }).end(img.toPNG())
      } else if (url.pathname === '/eval') {
        let body = ''
        for await (const chunk of req) body += chunk
        const result = await win.webContents.executeJavaScript(body, true)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? null))
      } else if (url.pathname === '/size') {
        win.setSize(Number(url.searchParams.get('w') ?? 1320), Number(url.searchParams.get('h') ?? 860))
        res.end('ok')
      } else res.writeHead(404).end()
    } catch (err) {
      res.writeHead(500).end(String(err))
    }
  }).listen(port, '127.0.0.1')
}
