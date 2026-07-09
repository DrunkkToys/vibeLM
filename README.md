# vibeLM

vibeLM is a local-first agentic plugin for LM Studio.

It gives a model practical tooling for real work:
- inspect and edit a workspace
- run shell commands
- search and fetch the web
- save and reload memory across sessions
- summarize long sessions into reusable memory
- keep sessions alive autonomously with self-recalling loops

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
| **Autonomy** | `vibe_bridge` — self-recalling autonomous loop for keep-alive sessions |

## Autonomous Sessions (vibe_bridge)

`vibe_bridge` keeps the session alive without user input by periodically injecting a prompt into the chat.

```bash
# Start with defaults (configured in plugin settings)
vibe_bridge({ action: "start" })

# Start with custom settings
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
| `tools.vibe_bridge` | boolean | `false` | Enable the tool |
| `tools.vibe_bridge_prompt` | string | `"Check progress to reach your goal, if you are failing adjust trajectory."` | Default injection prompt |
| `tools.vibe_bridge_interval` | number | `600` | Seconds between injections |
| `tools.vibe_bridge_maxDuration` | number | `21600` | Max total runtime in seconds (0=unlimited) |

Each keep-alive tick can call a curated set of tools (explore/list/read/write/append/search files, save/search memory, web fetch/search). `bash_terminal` is intentionally excluded from unattended ticks until it has a command allowlist (see Security below).

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
- `bash_terminal` runs with user-level permissions.
