# vibeLM

vibeLM is a local-first agentic plugin for LM Studio.

It gives a model practical tooling for real work:
- inspect and edit a workspace
- run shell commands
- search and fetch the web
- save and reload memory across sessions
- summarize long sessions into reusable memory
- delegate harder work to a sub-agent

The goal is simple: keep the model useful in long, read-heavy sessions without forcing the user to switch tools or lose important context.

## Product Story

vibeLM turns a local LM Studio model into a real agent instead of a chat-only assistant. It is built to do multi-step work, manage files, inspect a workspace, and keep track of what happened without relying on cloud infrastructure.

That matters because the workflow is different from cloud LLMs. With a smaller model like Qwen3 4B, the agent can still execute useful tool flows, but the work is more fragmented and the context has to be managed carefully. With a stronger local model like GLM 4.6 Flash, Qwen3.5, or Gemma 4 E, vibeLM can sustain more reliable multi-step orchestration and keep the session moving.

The point is not to pretend local models behave like hosted frontier systems. The point is to make local models genuinely useful for agentic work, with scoped memory, explicit workspace access, compact session handoff, and a prompt budget gate that fails early instead of blowing up mid-session.

## What It Does

| Area | Tools |
|---|---|
| **Workspace** | `set_workspace`, `pick_workspace` (macOS Finder), `get_config` |
| **Files** | `list_files`, `read_file`, `write_file`, `append_file`, `rename_file`, `search_files`, `delete_file` |
| **Shell** | `bash_terminal` |
| **Memory** | `save_memory`, `search_memory`, `list_memories`, `update_memory`, `delete_memory`, `clear_memories` |
| **Context** | `compact_context` |
| **Web** | `web_fetch`, `web_search` |
| **Math & Time** | `calculate` (mathjs), `get_current_datetime` |
| **Utilities** | `generate_uuid`, `generate_password`, `encode_base64`, `decode_base64` |
| **Sub-agent** | `consult_expert` (coder, debugger, architect, reviewer, writer, analyst, researcher, data_scientist, knowledge_keeper) |
| **Response control** | `respond_to_user` |

## How It Works

- Workspace operations are restricted to the configured root.
- `compact_context` compresses long sessions into reusable state for memory, not live chat deletion.
- `compact_context` returns a copy-paste handoff block for starting a fresh chat with the summary.
- Code is preserved verbatim or referenced by path, never paraphrased.
- Memory entries are tagged with workspace, session, and semantic scope so you can search by `session`, `workspace`, `research`, or `all`.
- `get_config` shows the current prompt-budget estimate, safety margin, and overflow risk.
- LM Studio’s plugin settings UI exposes `maxOrchestratorTurns`, which defaults to `50` and controls how many tool turns the orchestrator can use before it must stop.
- LM Studio’s plugin settings UI also exposes `Rolling Window Trigger Tokens`, which controls how early vibeLM treats the session as near the context limit.
- `respond_to_user` is gated so the orchestrator does not stop too early.
- The plugin tries to stay under the model’s prompt budget and auto-compacts when sessions get large.

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

vibeLM stores its config in:

```text
~/.lmstudio/extensions/plugins/drunkktoys/vibe-lm/config.json
```

Example:

```json
{ "workspacePath": "/Users/you/my-project" }
```

Set it from the plugin with `set_workspace`, or use `pick_workspace` on macOS.
The plugin keeps the LM Studio install path in kebab-case for compatibility, but the product name shown in prompts and docs is `vibeLM`.

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
