# Local Browser Use — extension

Chrome MV3 side-panel extension for the local browser-use agent. Chat runs fully locally against an Ollama model; browser perception/action arrives in later phases (see `../DESIGN.md`).

Forked from [Nanobrowser](https://github.com/nanobrowser/nanobrowser) (Apache-2.0), stripped to the side-panel shell + message plumbing; the agent core is being rebuilt fresh.

## Prerequisites

- Node ≥ 22.12 and pnpm 9 (`corepack enable`)
- [Ollama](https://ollama.com) ≥ 0.30 running on `localhost:11434` with the chat model pulled:
  ```bash
  ollama pull qwen3.5:4b
  ```

## Build & load

```bash
pnpm install
pnpm build        # outputs to dist/
```

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select the `dist/` directory
3. Click the extension icon to open the side panel and chat

`pnpm dev` gives watch mode with HMR. Model/URL are configurable in the extension's options page.

## Layout

- `chrome-extension/` — manifest + background service worker (Ollama chat router)
- `pages/side-panel/` — React chat UI
- `pages/options/` — settings (Ollama URL, model)
- `packages/` — shared build tooling, storage, UI, i18n
