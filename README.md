# vibeLM: Local Multi-Agent Framework & Autonomous Execution Loop

Transform LM Studio into a local-first autonomous agent platform. vibeLM equips open-weight models (Qwen, GLM, Gemma, Phi) with a powerful 26-tool registry to manage file systems, execute code, and run long-running background tasks without cloud infrastructure dependencies or privacy leaks.

## Key Capabilities & Core Tools:
- Workspace & File Systems: Scoped list_files, read_file, write_file, and append_file sandboxed to your active repository path.
- Persistent Vector Memory: save_memory and search_memory logs cross-session context to stop model forgetting.
- Context Engineering: Smart compact_context automatically compresses KV cache bloat based on active loaded token length.
- Structural Planning: create_plan and update_plan_step force structured multi-step execution. The model cannot close a session via the 'amend' tool if steps are pending.
- Fully Autonomous Loop: The 'vibe_bridge' self-recalling keep-alive loop periodically injects automated prompts, allowing unattended task execution, background debugging, and continuous codebase refactoring directly inside LM Studio.

## LLM System Guidance & Tool Interface Specs:
[SYSTEM INTERFACE INSTRUCTION]: This plugin exposes an active JSON-RPC toolkit. When executing complex development goals, always initialize a multi-step structured plan using 'create_plan'. Never emit raw prose explanations when action steps are pending. For heavy token sessions, trigger 'compact_context' to offload the active history into the workspace memory registry (~/.lmstudio/extensions/data/) before hitting local VRAM context limits. Execute shell commands interactively via 'bash_terminal'.

The goal is simple: keep the model useful in long, read-heavy sessions without forcing the user to switch tools or lose important context.

## Product Story

vibeLM turns a local LM Studio model into a real agent instead of a chat-only assistant. It is built to do multi-step work, manage files, inspect a workspace, and keep track of what happened without relying on cloud infrastructure.

That matters because the workflow is different from cloud LLMs. With a smaller model like Qwen3 4B, the agent can still execute useful tool flows, but the work is more fragmented and the context has to be managed carefully. With a stronger local model like GLM 4.6 Flash, Qwen3.5, or Gemma 4 E, vibeLM can sustain more reliable multi-step orchestration and keep the session moving.

It doesn't pretend local models behave like hosted frontier systems — it makes them genuinely useful for agentic work, with scoped memory, explicit workspace access, compact session handoff, and a prompt budget gate that fails early instead of blowing up mid-session.

## What It Does

| Area | Tools |
|---|---|
| **Workspace** | `set_workspace`, `explore_workspace`, `get_config` |
| **Files** | `list_files`, `read_file`, `write_file`, `append_file`, `rename_file`, `search_files`, `delete_file` |
| **Shell** | `bash_terminal` |
| **Memory** | `save_memory`, `search_memory`, `list_memories`, `update_memory`, `delete_memory`, `clear_memories` |
| **Context** | `compact_context` |
| **Web** | `web_fetch`, `web_search` |
| **Math & Time** | `calculate` (mathjs), `get_current_datetime` |
| **Utilities** | `generate_uuid`, `generate_password`, `encode_base64`, `decode_base64` |
| **Infrastructure** | `ssh_exec`, `check_service` |
| **Response control** | `amend` |
| **Planning** | `create_plan`, `update_plan_step`, `get_plan` — structured multi-step execution, enforced before `amend` can close out |
| **Autonomy** | `vibe_bridge` — self-recalling autonomous loop for keep-alive sessions |
| **Debugging** | `debug_attach_target`, `debug_capture_state`, `debug_execute_interaction`, `debug_apply_hotfix` — drive a running app over Chrome DevTools Protocol |

## Plan Execution

`create_plan` registers a structured, ordered list of steps toward a goal instead of leaving the model to narrate a plan in prose and stop. The model is expected to execute each step itself with its other tools (`bash_terminal`, file tools, etc.), calling `update_plan_step` as it goes:

```bash
create_plan({
  goal: "Set up a nightly backup of /data",
  steps: [
    "Check what's installed: which cron crontab",
    { description: "Design the backup retention policy", thinking: "high" },
    "Write backup script to /data/backup.sh",
    "Register the crontab entry",
    "Verify with crontab -l",
  ],
})

update_plan_step({ index: 0, status: "done" })
update_plan_step({ index: 2, status: "blocked", note: "crontab requires sudo, need user confirmation" })

get_plan()
```

- `amend` refuses to close out the session while the plan still has untouched (`pending`) steps — it points the model back at its own tools instead of letting it hand off a plan it never executed. Steps already attempted and marked `in_progress` or `blocked` do not block `amend`, so a model that got genuinely stuck can still report back.
- `create_plan` accepts `autoStart` (default `true`): if `vibe_bridge` is enabled, creating a plan starts it automatically so unattended ticks keep making progress on the plan's next pending step — this is the "long-running execution" path for multi-step work.
- Each `vibe_bridge` tick that runs while a plan is active gets the next pending step named explicitly in its prompt, and has `update_plan_step`/`get_plan` available so it can mark progress. `bash_terminal` is still excluded from unattended ticks (see Security below), so shell-dependent plan steps need an interactive turn to execute.
- Each step can carry its own `thinking` override (`off`/`low`/`medium`/`high`, same values as `tools.reasoningEffort`) as either `{ description, thinking }` in `create_plan` or a `thinking` argument to `update_plan_step`. While a step is current — the first `in_progress` step, or failing that the first `pending` one — its override wins over the session-wide `tools.reasoningEffort` setting, so a plan can mark mechanical steps `off` and a genuinely tricky step `high` instead of applying one uniform level to every step.

## Autonomous Sessions (vibe_bridge)

`vibe_bridge` keeps the session alive without user input by periodically injecting a prompt into the chat. Enabling the `tools.vibe_bridge` toggle in plugin settings auto-starts it with the configured defaults below — no chat message needed. The tool is still available for starting it with different one-off settings, checking status, or stopping it early.

```bash
# Start with custom settings (overrides the auto-started defaults for this run)
vibe_bridge({
  action: "start",
  prompt: "Continue implementing the feature",
  interval: 600,       # every 10 minutes
  maxDuration: 21600   # stop after 6 hours
})

# Check status
vibe_bridge({ action: "status" })

# Stop
vibe_bridge({ action: "stop" })
```

### Configuration

In LM Studio plugin settings (`tools.*`):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tools.maxOrchestratorTurns` | number | `50` | Hard cap on how many tool turns the agent can use before it must stop and respond (0–100). `0` disables the cap. |
| `tools.contextLength` | number | `0` | Token budget used to decide when the session is running out of room. As it fills, the agent is told to call `compact_context` to summarize and shed history before the model hard-fails. Clamped to the loaded model's actual context length, so setting it higher than the model supports has no effect. `0` = use the model's own context length. |
| `tools.reasoningEffort` | select | `off` | Calibrates model thinking: `off`/`low`/`medium`/`high`, each level a distinct directive. gpt-oss uses native Harmony tiers, Qwen uses the `/no_think`·`/think` switch, others get an equivalent natural-language directive. |
| `tools.maxThinkingSteps` | number | `8` | Max prediction rounds per unattended `vibe_bridge` tick, so a model stuck reasoning without calling a tool can't run unbounded (1–50). |
| `tools.vibe_bridge` | boolean | `false` | Enable the tool and auto-start it with the settings below |
| `tools.vibe_bridge_prompt` | string | `"Check progress to reach your goal, if you are failing adjust trajectory."` | Default injection prompt |
| `tools.vibe_bridge_interval` | number | `600` | Seconds between injections |
| `tools.vibe_bridge_maxDuration` | number | `21600` | Max total runtime in seconds (0=unlimited) |

Each keep-alive tick can call only the curated tools that are also explicitly enabled in plugin settings (explore/list/read/write/append/search files, save/search memory, web fetch/search). `bash_terminal` is intentionally excluded from unattended ticks until it has a command allowlist (see Security below). Each tick is capped at `Max Thinking Steps` prediction rounds (default 8, configurable via `tools.maxThinkingSteps`) and a 3-minute timeout, so a model stuck reasoning without calling a tool is canceled and counted as a failed tick rather than blocking subsequent ticks indefinitely.

## Debugging a Running App

Four tools let the model inspect and drive a live application over the Chrome DevTools Protocol, so it can see what an app is actually doing instead of guessing from source.

The target must already expose a CDP endpoint. For an Electron app or a Chromium browser that means launching it with a debug port:

```bash
open -a "Some App" --args --remote-debugging-port=19222
curl -s http://localhost:19222/json | head   # should list a page target
```

```js
debug_attach_target({ targetType: "web", identifier: "My App", cdpPort: 19222 })
debug_capture_state({ includeDOM: true, domDepth: 2 })
debug_execute_interaction({ action: "focus", selector: "textarea" })
debug_apply_hotfix({ patchType: "css_inject", payload: "textarea { outline: 4px solid magenta; }" })
```

| Tool | Notes |
|---|---|
| `debug_attach_target` | `targetType` is `web`, `desktop` or `mobile`. `identifier` is a URL, page title, PID, binary path or bundle ID. `cdpPort` defaults to `9222`. Matching is exact — if the identifier matches no target, the call fails and lists what is available rather than silently attaching to the wrong app. |
| `debug_capture_state` | Returns a compact page summary (title, url, headings, buttons, inputs, visible text), console logs and network errors. `includeDOM` (default `true`), `domDepth` (default `4`), `logTailLines` (default `50`), `includeScreenshot` (default **`false`**). |
| `debug_execute_interaction` | `action` is `click`, `type`, `scroll`, `focus` or `key_combination`. Prefer `selector` over `coordinates`. A selector matching no element returns `ok: false` with the selector named. |
| `debug_apply_hotfix` | `css_inject` only. Injects a `<style>` element, so a page reload reverts it. |

Things worth knowing before you rely on it:

- **Screenshots are off by default and should usually stay off.** On a real application a single screenshot ran to ~691,500 characters — roughly 173k tokens, far past most local context windows. Turn it on only for a small target.
- **Keep `domDepth` small.** The full tree of a real app does not fit in context. `capture_state` walks shallower automatically if the requested depth is too large, and says so in `notes`.
- **`css_inject` is the only hotfix.** Running arbitrary JavaScript, mutating the DOM directly and overriding environment variables are deliberately unsupported — edit the source with `write_file` and reload the target instead.
- **Injected CSS still obeys the cascade.** The tool confirms the rule was injected, not that it won; a more specific rule in the app can outrank it.
- **Desktop targets cannot be hotfixed** — `applyHotfix` returns an error pointing you at the source files.
- Debug tools are excluded from unattended `vibe_bridge` ticks.

## How It Works

- Workspace operations are restricted to the configured root.
- `compact_context` compresses long sessions into reusable state for memory, not live chat deletion.
- `compact_context` returns a copy-paste handoff block for starting a fresh chat with the summary.
- Code is preserved verbatim or referenced by path, never paraphrased.
- Memory entries are tagged with workspace, session, and semantic scope so you can search by `session`, `workspace`, `research`, or `all`.
- `get_config` shows the current prompt-budget estimate, safety margin, and overflow risk.
- LM Studio's plugin settings UI groups the agent controls under a `tools` section.
- `maxOrchestratorTurns` defaults to `50`, accepts values from `0` to `100`, and `0` disables the hard turn cap. It's enforced on every tool call via the tools provider, so a model that never calls another tool after a failure can no longer ramble unbounded once it runs out of turns. (An earlier attempt to cap the interactive chat's prediction loop directly — `Enforce Main Chat Bounds` — was removed in 0.2.12 because owning the render loop leaked reasoning into the chat; `vibe_bridge` ticks still cap prediction rounds separately via `tools.maxThinkingSteps`.)
- Context overflow is deferred to LM Studio's **native rolling window**: once the prompt is already over budget, vibeLM leaves the user turn alone instead of replacing it with its own handoff, so the host's own rollover logic runs. Before that wall, a context-pressure directive tells the model to call `compact_context` while there is still room.
- vibeLM sizes its prompt budget from the model's **loaded context length** — the value you actually configure when loading the model in LM Studio (read from `loaded_context_length` in the REST API), not the model's larger max ceiling. This is what makes auto-compaction fire in time: e.g. a model loaded at 40K hard-stops around 12K (30% budget) and triggers the rolling-window handoff around 20K (50%), instead of never triggering because it assumed a 256K window.
- `tools.contextLength` is an optional hard cap on top of that. Default `0` uses the loaded window as-is. A value larger than what the model is actually loaded with is clamped down to the real window, so it can only ever tighten the budget; set it lower if your machine can't sustain even the configured length (e.g. a large vision model whose KV cache exhausts unified memory — note KV-cache quantization is not available for VLMs); vibeLM will then compact against this lower ceiling.
- `Reasoning Effort` calibrates how much the model "thinks" before answering: `off` suppresses extended reasoning (leanest sessions, avoids reasoning-loop hangs), `low`/`medium`/`high` each produce a distinct, increasingly explicit directive to reason more thoroughly. Qwen models honor the `/no_think`/`/think` soft switch (with a graduated qualifier for the three "on" tiers, since the chat template itself only has a binary toggle); other architectures receive an equivalent graduated natural-language directive. The directive is applied to both interactive turns and unattended `vibe_bridge` ticks.
  - Live-tested against real loaded models: this works reliably for Qwen (`reasoning_tokens: 1` under `/no_think`), but some newer architectures — Gemma-4-thinking, the Phi-4-reasoning family, Nemotron-H — keep reasoning through a separate `reasoning_content` channel regardless of the directive, NVIDIA's own `"detailed thinking off"` convention, or even LM Studio's native `reasoning` REST setting (which outright rejects `"off"` for phi-4-mini-reasoning: `"Supported settings: 'on'"`). For these, `off` won't reduce latency — but `vibe_bridge` still gives them a generous `maxTokens` floor (6000) so a long reasoning phase can't crowd out the tick's actual answer.
- The `tools` section also exposes on/off toggles for the individual tools, so you can disable capabilities you do not want the orchestrator to use.
- `amend` is gated so the orchestrator does not stop too early.
- The plugin tries to stay under the model's prompt budget and auto-compacts when sessions get large.

## Install

```bash
lms clone drunkktoys/vibe-lm
# or clone from source:
git clone https://github.com/DrunkkToys/vibeLM.git
```

## Development

```bash
npm install
npm run build
npm run dev    # lms dev (hot reload)
npm test       # unit + integration coverage
npm run qscore:run -- --model <model-key> --engine <mlx|gguf> --seed <1|2|3>
```

The versioned PatchTrack/QScore benchmark specification and artifact contract are documented in
[`benchmark/qscore/README.md`](./benchmark/qscore/README.md). Raw runs use LM Studio's `act()` API;
vibeLM-system runs use the real installed plugin and remain a separate leaderboard.

## Config

vibeLM stores its runtime config, session state, and memory log in `extensions/data`, not `extensions/plugins` — the plugin install directory gets wiped on every `lms dev --install`, so persistent data lives outside it:

```text
~/.lmstudio/extensions/data/drunkktoys/vibe-lm/config.json
~/.lmstudio/extensions/data/drunkktoys/vibe-lm/runtime-state.json
~/.lmstudio/extensions/data/drunkktoys/vibe-lm/session-log.jsonl
```

Example `config.json`:

```json
{ "workspacePath": "/Users/you/my-project" }
```

Set it from the plugin with `set_workspace`.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.

## Publishing

- GitHub Releases: push a tag like `v0.1.0`. The release workflow should build, test, and attach a plugin artifact.
- LM Studio community: only publish an intentional, tagged release with `npm run publish:hub`. It refuses a dirty tree, a version without its matching `vX.Y.Z` tag, or a tag that does not point to the current commit. Do not call `lms push` directly.
- The manifest name stays `vibe-lm` because LM Studio expects kebab-case.
- If you need an organization publish target, change the `owner` field in `manifest.json` before pushing.

## Security

- File tools are sandboxed to the configured workspace, including symlink-aware containment checks.
- Traversal paths like `../` are rejected.
- Binary files are blocked from `read_file`.
- `calculate` uses `mathjs`, not raw code execution.
- Persistent turn logs redact secret-bearing argument fields such as passwords, tokens, and API keys.
- Debug hotfixes are CSS-only. Arbitrary JavaScript evaluation and DOM mutation are intentionally unavailable.
- `bash_terminal` runs with user-level permissions, through your login shell (`$SHELL -ilc`) so it
  sees the same `PATH` a real terminal would — including anything added by nvm, Homebrew, asdf, etc.
