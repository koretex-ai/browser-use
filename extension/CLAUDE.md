# CLAUDE.md

Guidance for AI coding assistants working in `extension/`.

## Project

Chrome MV3 side-panel extension for **Local Browser Use** — a vision-native browser agent that runs fully locally via Ollama. Forked from Nanobrowser but stripped to the shell: the multi-agent core, browser automation, and multi-provider LLM config were deleted. The agent core is rebuilt fresh phase by phase (see `../DESIGN.md`).

Current state: full agent — perception (shadow-DOM-aware set-of-marks + screenshots), typed executor, Planner→Executor→Validator loop on local models, Holo1.5-3B vision-grounding fallback, trajectory logging, and an optional cloud orchestrator (hybrid mode).

Hybrid mode — COMPILER ARCHITECTURE: the cloud orchestrator (default OpenRouter + GLM-5.2) compiles each task into subtask PROGRAMS — typed steps (navigate/click/type/type_focused/key/scroll/extract/harvest/wait, see `agent/program.ts`) that the harness executes deterministically with NO local planner in between. Local models are senses only: deterministic label matching (+ Holo vision fallback) resolves step targets described by text; qwen reads pages (extract); checkpoints judge post-subtask page EVIDENCE (element labels always; page-text excerpt only when `cloudExecutorEnabled`). Goal-only subtasks (no steps) fall back to the legacy qwen planner loop with the escalation ladder. Rescues prefer returning corrected programs; goal-only rescues escalate the planner. The orchestrator writes the final answer. Irreversible-action rule: the checkpoint never replans a repeat of a possibly-completed side-effectful action (post/send/purchase/delete) — it must verify first. Task-level DATA LEDGER: every extract result accumulates in the task run and flows into checkpoints/rescues/salvage and (as seed notes) later subtasks; replans must paste actual collected values into data-using subtask goals. Rescues receive a log of prior rescue decisions so strategies don't thrash. Subtasks tagged `atomic: true` perform exactly one action and stop (no improvisation budget). Repeated identical extract answers count toward the stuck streak. Local models execute browser actions by default. Escalation ladder (cheapest capability first): when the local executor gets stuck or keeps failing, rescue 1 retries the LOCAL model with the orchestrator's corrected goal; only if that fails do rescues 2 and 3 escalate the executor planner to `executorModelTier1` then `executorModelTier2`, with the cloud model driving the browser directly for that subtask. Principle: cloud models are for orchestration/planning/review; local models do the work whenever possible. Per-role orchestrator models: triage/checkpoint and the FIRST rescue of a subtask use `orchestratorModel`; later rescues (first correction already failed) and salvage use `orchestratorModelStrong`. HARD RULE: screenshots NEVER leave the machine (vision grounding is always local). Orchestrator payloads are digest-only (task text, plan state, outcome summaries, element labels on rescue); the escalated cloud executor additionally sees element labels and extracted page text — text only, and only when `cloudExecutorEnabled` is on. No API key → fully local behavior. Escalated steps are recorded with `plannerTier`/`plannerModel` in trajectory records — they are priority SFT data (strong-model actions on pages where the local model failed).

## Commands

Always use `pnpm` (v9, via corepack) with Node ≥ 22.12 (`nvm use v22.13.0`).

- `pnpm install` — install deps
- `pnpm build` — production build to `dist/`
- `pnpm dev` — watch mode with HMR
- `pnpm type-check` / `pnpm lint` / `pnpm prettier` — checks
- Workspace-scoped: `pnpm -F chrome-extension build`, `pnpm -F pages/side-panel type-check`, etc.

Load the extension: `chrome://extensions` → Developer mode → Load unpacked → `dist/`.

## Architecture

Turbo + pnpm monorepo:

- `chrome-extension/src/background/index.ts` — service worker: routes side-panel port messages (`new_task`, `follow_up_task`, `command`, `cancel_task`, `heartbeat`).
- `chrome-extension/src/background/agent/` — `loop.ts` (runAgentTask: hybrid orchestrated flow or local-only; runSubtask inner loop), `orchestrator.ts` (cloud triage/checkpoint, digest-only), `planner.ts` (local JSON-mode action selection), `grounder.ts` (Holo vision fallback), `chat.ts` (streaming chat), `prompts.ts`.
- `chrome-extension/src/background/actions/cdp.ts` — CDP escape hatch (Phase 6): trusted keyboard input via chrome.debugger for canvas editors (Google Docs/Sheets) that ignore synthetic events. KEYBOARD ONLY by design — CDP mouse is avoided because the debugger infobar reflows the viewport and would shift grounder coordinates. `type_focused` action is CDP-only; `key` is CDP-first with synthetic fallback. Attach lazily, stay attached (stable geometry), detach at task end.
- `chrome-extension/src/background/perception/` — set-of-marks extraction (innermost-interactive dedupe, open shadow roots) + downscaled screenshots. Invariant: ONE extraction per step; executor never re-perceives (see executor.ts).
- `pages/side-panel/` — React chat UI. Connects via `chrome.runtime.connect({name: 'side-panel-connection'})`. Receives `execution` events (task.start/ok/fail/cancel), `stream_chunk` deltas, and `error`.
- `pages/options/` — settings page backed by `chatSettingsStore` (Ollama base URL + model; defaults `http://localhost:11434` / `qwen3.5:4b`).
- `packages/storage` — chrome.storage wrappers: `chatHistoryStore` (sessions/messages), `chatSettingsStore`, favorites. `Actors` = system | user | assistant.
- `packages/{ui,i18n,shared,vite-config,tailwind-config,tsconfig,hmr,dev-utils,zipper}` — tooling kept from upstream.

Message/actor types double as the future training-label schema — keep them typed and stable.

## Conventions

- Prettier: 2 spaces, single quotes, semicolons, printWidth 120. ESLint with `@typescript-eslint/consistent-type-imports`.
- Components `PascalCase`, variables `camelCase`, workspace dirs `kebab-case`.
- i18n: source locale is `packages/i18n/locales/en/messages.json`; never edit generated `packages/i18n/lib/**` or `dist/**`.
- Run `pnpm type-check` before committing.
- Keep extension permissions minimal (currently: storage, tabs, activeTab, scripting, unlimitedStorage, sidePanel, debugger — the last is the CDP escape hatch for trusted input; host permissions: <all_urls> for perception/actions + localhost Ollama).
