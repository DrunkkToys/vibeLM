# vibeLM

**26 agentic tools for LM Studio** — file operations, bash terminal, web search/fetch, math evaluation, persistent knowledge base, sub-agent delegation, utilities, and more.

## Tools

| Category | Tools |
|---|---|
| **Workspace** | `set_workspace`, `pick_workspace` (macOS Finder), `get_config` |
| **File** | `list_files`, `read_file`, `write_file`, `append_file`, `rename_file`, `search_files`, `delete_file` |
| **Shell** | `bash_terminal` |
| **Knowledge** | `save_memory`, `search_memory`, `list_memories`, `update_memory`, `delete_memory`, `clear_memories` |
| **Web** | `web_fetch`, `web_search` |
| **Math & Time** | `calculate` (mathjs), `get_current_datetime` |
| **Generate** | `generate_uuid`, `generate_password` |
| **Encode** | `encode_base64`, `decode_base64` |
| **Sub-agent** | `consult_expert` (coder, debugger, architect, reviewer, writer, analyst, researcher, data_scientist, knowledge_keeper) |

## Install

```bash
lms clone drunkktoys/vibe-lm
# or clone from source:
git clone https://github.com/DrunkkToys/vibeLM.git
```

## Publishing

- GitHub Releases: push a tag like `v1.0.0`. The release workflow runs tests, builds the plugin, and uploads a zip artifact.
- LM Studio community: run `lms push` from the plugin directory after logging in to LM Studio. The manifest name stays `vibe-lm` because LM Studio requires kebab-case.
- If you need to publish to an organization, change the `owner` field in `manifest.json` before pushing.

## Development

```bash
npm install
npm run build
npm run dev    # lms dev (hot reload)
npm test       # 30+ unit tests
```

## Security

- File tools sandboxed to workspace — paths with `../` traversal rejected
- Binary extensions (`.png`, `.pdf`, `.exe`, etc.) blocked from `read_file`
- `calculate` uses **mathjs** (safe expression parser, no code execution)
- Password generation uses `crypto.randomInt` (no modulo bias)
- `bash_terminal` executes with user-level permissions

## Config

`~/.lmstudio/extensions/plugins/drunkktoys/vibe-lm/config.json`

```json
{ "workspacePath": "/Users/you/my-project" }
```

Set via `set_workspace` tool or `pick_workspace` (macOS native folder picker).
