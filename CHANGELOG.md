# Changelog

All notable changes to vibeLM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **`bash_terminal` reported genuinely installed tools (node, npm, anything managed by nvm/Homebrew/
  asdf/volta) as "not found."** Commands ran via a bare `exec()` inheriting LM Studio.app's own
  environment — launched via Launch Services (Dock/Finder), never an interactive login shell — so
  `PATH` never picked up anything a version manager adds by sourcing `.zshrc`/`.zprofile`. Live testing
  caught the agent confidently telling the user to reinstall Node.js that was already installed via
  nvm. Commands now run through `${SHELL} -ilc` (interactive + login), sourcing the same profile a
  real Terminal session would — generically, without hardcoding any tool's install path.
- **`delete_file`'s parameter was named `path` while `read_file`/`write_file` use `filePath`.** Live
  testing caught the model calling `delete_file({ filePath: ... })` — consistent with every other file
  tool in the same conversation — and getting rejected by the schema. Renamed to `filePath` for
  consistency; the tool's own inconsistency was silently degrading tool-call reliability with no
  logged bug up to now.

### Added
- **Importance-tiered context budgeting (Layer 3).** Replaces the blunt fixed limits with tiers keyed
  on importance:
  - **Tool-result retention** is no longer a flat 500-char cap for every tool. Information-bearing
    reads/searches keep up to 1500 chars, failures keep 300 (they're already distilled into a fact),
    everything else keeps 500 — so a 3 KB file read now survives on the turn log instead of losing 83%
    of itself the same way a one-line failed probe did.
  - **The pinned head (context spine) is assembled tier-by-tier under a char budget** (20% of the
    context window, so it scales with the model) instead of a fixed fact count: goal + plan are pinned
    first, then established facts fill whatever budget remains.
  - **The session goal is auto-populated into the persisted `plan` field** from the first substantive
    request, so the pinned head has a goal to anchor to even when the model never calls `create_plan`.
    `parsePersistedPlan` now accepts a goal-only plan (previously it silently dropped any plan with
    zero steps, which would have discarded the auto-goal on the next read).
  - **The working-window FIFO is now head+tail retention** — it pins the first turn (the session
    anchor) plus the most recent turns and cuts the middle, instead of rolling the oldest (the goal)
    off first.

- **Cut-the-middle context retention via a pinned "context spine".** Previously, when the LM Studio
  host rolled raw history it dropped the *oldest* turns first — the goal and everything the agent had
  established — and vibeLM only re-asserted its last directive, so early context was effectively lost
  (a rolling/tail strategy). vibeLM now rebuilds a pinned **head** from durable state — the plan
  (goal + step statuses) plus the top distilled facts — and re-injects it on resume after a detected
  roll. The head survives, the recent tail is whatever the host still holds, and the middle is
  deliberately not reproduced (only its distilled facts carry forward). Facts fall back to the most
  recent across sessions when a roll has regenerated the session id, so the "what we've learned"
  block isn't empty exactly when it's needed most.

### Changed
- **Memory now stores distilled, deduplicated facts instead of raw tool-result dumps.** Every non-read
  tool call used to append the full (truncated) result blob to memory and a contentless
  `called X — result ok=true` checkpoint, so a probing loop produced dozens of near-identical entries
  that made `search_memory` return noise and told the model nothing it could act on (observed live: 32
  blob memories + 27 empty checkpoints in one session). Results are now distilled into a compact
  one-line fact keyed by a coarse signature (shell program + outcome), and equivalent facts are
  deduped within a recent window — so 24 failing `ls <path>` probes collapse to a single
  `bash_terminal \`ls …\` → failed: …` fact, and checkpoints carry that same distilled line. The
  verbatim result is still kept on the turn entry, so recent-context fidelity is unchanged.
  Deduplication is coarse only for failures/info (the noise a probing storm produces); successful
  calls are keyed on their exact signature so distinct results (e.g. `cat a.txt` vs `cat b.txt`) are
  each retained rather than collapsed. That success key is a **hash** of the signature, never the raw
  args, so secret arguments such as `ssh_exec`'s password can't leak into the persisted `fact:`
  memory tag.

### Fixed
- **Loop guard missed semantic loops, so the agent could burn a whole session going nowhere.** The
  guard only caught a model that repeated an *identical* call verbatim; it keyed on the exact
  arguments, so a model probing the same shell program with a different argument every turn slipped
  through (observed live: 24 consecutive `ls <different node/npm path>` calls, each a distinct
  signature, none tripping the guard). A coarse guard now keys shell tools (`bash_terminal`,
  `ssh_exec`) on the program name only, so `ls A`, `ls B`, `ls C`… collapse into one family and trip
  after a few tries, with a steering message telling the model to change strategy or `amend`.
  Non-shell tools keep their exact signature, so reading distinct files is never mistaken for a loop.

## [0.2.3] - 2026-07-10

### Added
- **Plan execution** — `create_plan`, `update_plan_step`, and `get_plan` give the model a structured,
  ordered step list instead of letting it narrate a plan in prose and stop. `amend` now refuses to
  close out a session while the plan has untouched (`pending`) steps. `create_plan` can auto-start
  `vibe_bridge` so unattended ticks keep making progress on the plan's next pending step.

### Fixed
- **`reasoningEffort` was a silent no-op for most users.** `medium`/`high` produced an empty directive
  for every architecture except gpt-oss (Llama/Mistral/Gemma/DeepSeek/GLM/Phi/etc. all got nothing),
  and Qwen's `low`/`medium`/`high` all resolved to the identical `/think` — the setting only ever did
  anything for `off` vs. "on". Every level now produces a distinct directive per model family.
- **Context-roll recovery almost never worked.** vibeLM's `managedContextBlocks` recovery state (meant
  to re-assert its own instructions after the host truncates/rolls raw history) was only ever
  populated by scraping the model's own final answer for a marker it had no reason to echo back, and
  even when populated it only rehydrated if the next user message happened to match a
  continuation-style regex. It's now captured at the point vibeLM itself emits a directive, and
  rehydrates unconditionally on the very next turn after a detected roll, regardless of wording.
- **Leaked model-side tags (gpt-oss Harmony `<|channel|>...`, GLM/Qwen `<think>...</think>`) could
  pollute vibeLM's own stored/reused data** — the `vibe_bridge` tick handover summary, `amend`
  handoffs, and `save_memory` content. Added `stripModelArtifacts` and applied it at those call sites.
  (The chat-bubble leak itself is LM Studio's own Harmony-parser bug and out of this plugin's reach —
  it has no hook into the assistant-response render path.)

## [0.2.2] - 2026-07-10

### Added
- **`reasoningEffort` setting** (`off`/`low`/`medium`/`high`) — calibrates model thinking, mapped per
  model family: gpt-oss uses its native Harmony `Reasoning: low/medium/high` tiers, Qwen uses the
  `/no_think`·`/think` soft switches, and other models get an equivalent natural-language directive.
  Applied to both interactive turns and unattended `vibe_bridge` ticks.
- **`compactionTriggerPercent` setting** (10–90, default 30) — how full the context gets before vibeLM
  auto-compacts older history into memory. Higher keeps more live context; lower compacts earlier.
- **`maxThinkingSteps` setting** (1–50, default 8) — the per-tick prediction-round cap for `vibe_bridge`
  is now user-configurable (previously hardcoded at 8).
- **`maxEffectiveContextTokens` setting** (default 0 = disabled) — optional hard cap on the token budget
  vibeLM plans against, for machines that can't sustain even the configured loaded context length.

### Fixed
- Prompt budgeting and auto-compaction now size from the model's actual **loaded context length**
  (`loaded_context_length`, read from LM Studio's REST API) instead of its larger max ceiling.
  Previously a model loaded at ~40K but reporting a 256K max was budgeted against 256K, so
  auto-compaction (30% trigger) and the budget warning (50%) never fired before the session overflowed
  its real window and died — confirmed live on a remote M5 around 40–60K tokens.

## [0.2.1] - 2026-07-09

### Changed
- `vibe_bridge` now auto-starts as soon as the "Vibe Bridge" toggle is enabled in plugin settings,
  using the configured default prompt/interval/maxDuration — no chat message needed to explicitly
  call `vibe_bridge({action:"start"})` first. An already-running bridge is left alone if the tool
  provider is invoked again (e.g. a new session on an already-running plugin process).

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
