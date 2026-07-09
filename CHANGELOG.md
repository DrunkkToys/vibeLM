# Changelog

All notable changes to vibeLM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-07-09

### Fixed
- `vibe_bridge`'s keep-alive tick called `model.act(chat, bridgeTickTools)` as a standalone call
  outside the main orchestrator, so it never inherited `maxOrchestratorTurns` and had no round or
  time cap of its own. A model that got stuck reasoning without calling a tool could loop
  indefinitely — confirmed live, one tick ran 43 minutes straight on repeating "Plan... Wait...
  Actually..." text after a `set_workspace` error it never recovered from, blocking all subsequent
  ticks. The tick now passes `maxPredictionRounds` (8) and a 3-minute timeout signal, so a stuck
  generation is canceled and flows into the existing consecutive-failure handling instead of
  hanging.

## [0.2.0] - 2026-07-09

### Added
- `vibe_bridge` tool for autonomous session keep-alive via self-recalling timer loop
  - Configurable prompt, interval (5-3600s), max duration, max iterations
  - GUI toggle in LM Studio plugin settings
  - Reads defaults from plugin config (`tools.vibe_bridge.*`)

### Fixed
- `vibe_bridge`'s keep-alive tick called `model.act(chat, [])` with an empty tools array, so it
  ran on schedule but could never actually call a tool — confirmed live, the autonomous loop was
  functionally inert. It now gets a curated tool set (workspace explore/list/read/write/append/
  search, memory save/search, web fetch/search); `bash_terminal` stays excluded pending a command
  allowlist.
- `config.json`, `runtime-state.json`, and `session-log.jsonl` lived inside the plugin's own
  install directory, which `lms dev --install` wipes on every deploy — a routine rebuild was
  silently destroying all persisted memory, session state, and the configured workspace path.
  Persistent data now lives under `extensions/data`, outside the path that gets wiped.
- `npm test` was independently corrupting the same real, production runtime files on every run
  (deleting the live `runtime-state.json`, overwriting the live `config.json` with test fixtures
  and never restoring it). Tests now use an isolated `VIBE_LM_DATA_DIR` override.
- Typo in the default `vibe_bridge` prompt ("adjast" → "adjust").

### Changed
- Bridge timer now calls `model.complete()` for handover summarization and `model.act()` to drive
  autonomous responses, using a rolling window of the last 5 user messages as context, instead of
  passive prompt injection.

## [0.1.1] - 2025-07-08

### Added
- `explore_workspace` command for quick workspace inspection
- Restart-safe session state with persistent session tracking
- Rolling window trigger token-based setting
- Cleanup entry error logging

### Fixed
- Memory leak in JSONL cache — streaming index, limit search scope, reduce max file size
- Restore tool toggles, remove duplicate tools, rename `respond_to_user` to `amend`
- Remove duplicate tool toggle checkboxes from configSchematics
- Wire `PROMPT_BUDGET_RATIO` into `hardPromptBudgetLimit`, remove dead `isReadOnlyTool`, fix `appendBatch` offset bug
- Dedupe resumed chat history
- Require explicit workspace path (no silent defaults)

### Changed
- Optimize context management — tighten constants, adaptive checkpoint max 10, selective memory, rolling window 3K, read-only skip
- Remove 7 dead functions and 2 orphaned constants

## [0.1.0] - 2025-07-07

### Added
- Initial release with 26 agentic tools:
  - **Workspace**: `set_workspace`, `get_config`
  - **Files**: `list_files`, `read_file`, `write_file`, `append_file`, `rename_file`, `search_files`, `delete_file`
  - **Shell**: `bash_terminal`
  - **Memory**: `save_memory`, `search_memory`, `list_memories`, `update_memory`, `delete_memory`, `clear_memories`
  - **Context**: `compact_context`
  - **Web**: `web_fetch`, `web_search`
  - **Math & Time**: `calculate`, `get_current_datetime`
  - **Utilities**: `generate_uuid`, `generate_password`, `encode_base64`, `decode_base64`
  - **Infrastructure**: `ssh_exec`, `check_service`
  - **Sub-agent**: `consult_expert` (coder, debugger, architect, reviewer, writer, analyst, researcher, data_scientist, knowledge_keeper)
  - **Response control**: `respond_to_user` (later renamed to `amend`)
- Prompt preprocessor for tool hints and workspace detection
- Strategic context injection with system prompt and loop detection
- Session logging and managed context reload
- Hard compact with GLM vision model guard
- Rolling window trigger setting
- Cascade tests, contract tests, and user journey e2e coverage

### Fixed
- Garbage output detection and retry
- Force `tool_choice` required to prevent garbage output
- Memory auto-save findings and summarize pruned turns
- Memory save all tool results across turns
- SSD memory architecture — save to SSD, keep minimum in RAM
- Smart truncation with offset for `read_file`
- Context window cleanup
- `requireWorkspace` guard + remove hardcoded workspace
- `orchestratorLoop` `finalText` now includes tool results
- Stack overflow in `requireWorkspace` infinite recursion

[Unreleased]: https://github.com/DrunkkToys/vibeLM/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DrunkkToys/vibeLM/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/DrunkkToys/vibeLM/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DrunkkToys/vibeLM/releases/tag/v0.1.0
