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
| **Workspace** | `set_workspace`, `get_config` |
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
| `tools.maxEffectiveContextTokens` | number | `0` | Optional hard cap on the budgeting window. `0` = use the model's actual loaded context length (read automatically). Raise it only if your machine can't sustain even the configured length. |
| `tools.reasoningEffort` | select | `off` | Calibrates model thinking: `off`/`low`/`medium`/`high`, each level a distinct directive. gpt-oss uses native Harmony tiers (`off` floors to `low`, Harmony has no lower tier), Qwen uses the `/no_think`·`/think` switch with a graduated brief/moderate/thorough qualifier appended, others get a graduated natural-language nudge. |
| `tools.compactionTriggerPercent` | number | `30` | How full the context gets (% of the loaded window) before vibeLM auto-compacts older history into memory (10–90). Higher keeps more live context; lower compacts earlier. |
| `tools.maxThinkingSteps` | number | `8` | Max prediction rounds per unattended `vibe_bridge` tick, so a model stuck reasoning without calling a tool can't run unbounded (1–50). |
| `tools.vibe_bridge` | boolean | `false` | Enable the tool and auto-start it with the settings below |
| `tools.vibe_bridge_prompt` | string | `"Check progress to reach your goal, if you are failing adjust trajectory."` | Default injection prompt |
| `tools.vibe_bridge_interval` | number | `600` | Seconds between injections |
| `tools.vibe_bridge_maxDuration` | number | `21600` | Max total runtime in seconds (0=unlimited) |

Each keep-alive tick can call a curated set of tools (explore/list/read/write/append/search files, save/search memory, web fetch/search). `bash_terminal` is intentionally excluded from unattended ticks until it has a command allowlist (see Security below). Each tick is capped at `Max Thinking Steps` prediction rounds (default 8, configurable via `tools.maxThinkingSteps`) and a 3-minute timeout, so a model stuck reasoning without calling a tool is canceled and counted as a failed tick rather than blocking subsequent ticks indefinitely.

## How It Works

- Workspace operations are restricted to the configured root.
- `compact_context` compresses long sessions into reusable state for memory, not live chat deletion.
- `compact_context` returns a copy-paste handoff block for starting a fresh chat with the summary.
- Code is preserved verbatim or referenced by path, never paraphrased.
- Memory entries are tagged with workspace, session, and semantic scope so you can search by `session`, `workspace`, `research`, or `all`.
- `get_config` shows the current prompt-budget estimate, safety margin, and overflow risk.
- LM Studio's plugin settings UI groups the agent controls under a `tools` section.
- `maxOrchestratorTurns` defaults to `50`, accepts values from `0` to `100`, and `0` disables the hard turn cap.
- `Rolling Window Trigger Limit (prompt tokens)` controls the maximum prompt size before vibeLM switches to rolling-window behavior. Set it to `0` to auto-derive the trigger from the selected model's context window minus a safety margin.
- vibeLM sizes its prompt budget from the model's **loaded context length** — the value you actually configure when loading the model in LM Studio (read from `loaded_context_length` in the REST API), not the model's larger max ceiling. This is what makes auto-compaction fire in time: e.g. a model loaded at 40K compacts around 12K and warns around 20K, instead of never triggering because it assumed a 256K window.
- `Max Effective Context (tokens)` is an optional hard cap on top of that. Default `0` uses the loaded window as-is. Set it only if your machine can't sustain even the configured length (e.g. a large vision model whose KV cache exhausts unified memory — note KV-cache quantization is not available for VLMs); vibeLM will then compact against this lower ceiling.
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
```

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
- LM Studio community: run `lms push` from the plugin directory after logging in to LM Studio.
- The manifest name stays `vibe-lm` because LM Studio expects kebab-case.
- If you need an organization publish target, change the `owner` field in `manifest.json` before pushing.

## Security

- File tools are sandboxed to the configured workspace.
- Traversal paths like `../` are rejected.
- Binary files are blocked from `read_file`.
- `calculate` uses `mathjs`, not raw code execution.
- `bash_terminal` runs with user-level permissions, through your login shell (`$SHELL -ilc`) so it
  sees the same `PATH` a real terminal would — including anything added by nvm, Homebrew, asdf, etc.
