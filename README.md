# R-Code

One calm, Poolside-style home for your coding agents on macOS.

- **Claude Code** and **Codex** run through the CLIs already on your Mac (via the Claude Agent SDK and `codex app-server`, the same approach T3 Code uses).
- **Pi is built in.** The open-source Pi coding agent ships inside R-Code and runs on Electron's own Node runtime. It powers every model that isn't Claude Code or Codex: Ollama and other local models, LM Studio, OpenRouter, API keys, and subscriptions. Nothing extra to install or keep updated.
- **One conversation, any agent.** Switch agent or model mid-chat and the next agent gets a digest of what the others did.
- **Agents work together.** Every agent gets R-Code tools:
  - `delegate_task` / `list_agents`: hand a side-quest to another agent or model, including free local ones.
  - `suggest_new_chat`: offer a fresh chat seeded with a summary.
  - Claude Code's and Codex's own sub-agents show nested in the timeline.
- **Built-in browser.** A real Chromium panel that you and the agents share (`browser_open`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_eval`, `browser_console`). Point it at a local dev server.
- **iOS Simulator + Xcode.** A live Simulator panel with Build & Run. Agents get `ios_build_and_run`, `ios_screenshot`, `ios_tap`, `ios_swipe`, `ios_type_text`, `ios_describe_ui`, `ios_open_url` and `ios_app_logs`. Tapping, typing and reading the UI use [AXe](https://github.com/cameroncooke/AXe), which ships inside R-Code (`npm run dist` fetches the pinned, checksum-verified release).
- **Web for the built-in agent:** `search_web` / `fetch_url`. Searches use Brave, Tavily, Ollama or SearXNG when you add a key or URL. With none set, Pi searches in a hidden background browser. Web activity shows the favicons of the sites visited.
- **On-device voice.**
  - Dictation uses OpenAI Whisper (Tiny, Base, or Small, the default) via transformers.js on WebGPU. Press ⌥Space in any chat.
  - Read-aloud uses Kokoro-82M (Apache-2.0). Models download once from Hugging Face; audio never leaves your Mac.
- **Context hygiene.** A live context meter offers Compact now or Continue in a fresh chat, with an automatic suggestion at a threshold you choose.
- **Little touches.** Language icons (Swift, Python, TS…) on every edit with +/− line counts, a plan/todo card, a git branch pill, permission modes, and a ⌘K search.

## Requirements

- macOS on Apple Silicon. Xcode is needed only for the iOS features.
- Node.js 20 or newer, to build from source.
- Optional: the Claude Code CLI, the Codex CLI and Ollama. R-Code offers to install any that are missing.

## Run it

```bash
npm install
npm run dev        # development
npm run dist       # builds release/mac-arm64/R-Code.app (ad-hoc signed) and release/R-Code-0.1.0-arm64.dmg
ditto release/mac-arm64/R-Code.app /Applications/R-Code.app   # install/update
```

The app is ad-hoc signed, not notarized. If you download a build instead of compiling it yourself, right-click it and choose Open the first time.

The first launch walks you through linking agents (with one-click install of missing CLIs and sign-in), picking default models, connecting Ollama, and voice.

## Layout

```
src/main/            Electron main process
  agents/            claude.ts (Agent SDK) · codex.ts (app-server JSON-RPC) · pi.ts (built-in, RPC mode)
  orchestrator.ts    threads, cross-agent context, queueing/steering, delegation
  bridge.ts          loopback MCP/HTTP server exposing R-Code tools to all agents
  tools/             browser.ts · ios.ts · web.ts · registry.ts
  installer.ts       CLI installs, sign-in, Ollama ↔ Pi config
src/renderer/        React UI (Tailwind v4, zustand)
  components/        Sidebar, Composer, Timeline, ModelPicker, SidePanel (browser + simulator)
  settings/          Onboarding + Settings pages
  voice/             Whisper STT + Kokoro TTS web workers
```

Data lives in `~/Library/Application Support/R-Code`. The built-in Pi shares `~/.pi/agent` with the standalone Pi CLI, so providers and logins carry over.

## Contributing

Issues and pull requests are welcome. Run `npm run typecheck` before sending a change.

## License

[MIT](LICENSE). R-Code builds on open-source work, each under its own license:

- [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (MIT), bundled
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Whisper](https://github.com/openai/whisper) (MIT) via [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0)
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) via kokoro-js
- [vscode-icons](https://github.com/vscode-icons/vscode-icons) (MIT) for file icons
- [Lucide](https://lucide.dev) (ISC) for UI icons
- [AXe](https://github.com/cameroncooke/AXe) (MIT), bundled, for iOS Simulator automation

Claude Code, Codex and Poolside are trademarks of their respective owners. R-Code is an independent project and isn't affiliated with any of them.
