# Changelog

All notable changes to vibeLM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.12] - 2026-07-19

### Fixed
- **Reverted the main-chat `PredictionLoopHandler` (0.2.9–0.2.11), which broke the chat on every thinking model.** Registering `withPredictionLoopHandler` takes ownership of the whole generation loop, and the handler rendered every prediction fragment as visible assistant text without checking `fragment.reasoningType`. LM Studio's default loop uses that field to route reasoning into the collapsible thinking UI and render only `"none"` fragments as chat; without it, reasoning prose and raw `<think>`/`</think>` tags leaked straight into the chat bubble. The fragment-level regex added in 0.2.11 could not fix this — `THINK_BLOCK` requires both tags in a single string, and streaming delivers them in separate fragments. `withToolsProvider` is restored, handing rendering, reasoning-channel routing, and tool-call parsing back to LM Studio.
- The `Enforce Main Chat Bounds` setting (`tools.enforceMainChatBounds`) is removed along with the handler it gated. Bounding the main chat's loop remains an open problem; it will not be solved by owning the render loop.

## [0.2.11] - 2026-07-11

### Changed
- **Gitignore cleanup** — untracked internal files (`AGENTS.md`, `CLAUDE.md`, `CODEX.md`), `.claude/` skills directory, and `benchmark/` artifacts from git tracking. These files are no longer shipped in the plugin.

### Fixed
- **Leaked model-side tags now stripped from streaming chat output** — `<think>...</think>`, Harmony `<|channel|>...<|message|>`, and stray control tokens from the model's raw output are now filtered fragment by fragment before they render in the LM Studio chat. Previously the filter only ran on stored data; the visible chat showed raw tags.
- **appendToolResult no longer throws on every tool call** — regression caught by real test coverage.
- **Main chat thinking loop now respects maxThinkingSteps cap** — the main orchestrator route (host-assistant) now passes `maxPredictionRounds` to `model.act()` the same way vibe_bridge ticks did. A stuck model can no longer loop indefinitely on the primary chat channel.
- **The main interactive chat could ramble unbounded with no tool call, for hours, with nothing to stop it.** `Max Orchestrator Turns` and the always-reasoning token floor were only ever enforced inside `wrapTool` (which only fires when a tool is actually called) or vibe_bridge's own standalone tick — the main channel's generation loop was entirely owned by LM Studio's default handler and had no cap at all (confirmed live: a session sat silent for 5+ hours after a failed `bash_terminal` call, with zero further tool calls logged). vibeLM now registers its own `PredictionLoopHandler` for the main chat, reusing the exact tool list `toolsProvider()` already resolves, so `Max Orchestrator Turns` and the always-reasoning `maxTokens` floor genuinely bound the interactive channel too. New setting `Enforce Main Chat Bounds` (`tools.enforceMainChatBounds`, default on) is the escape hatch if the caps themselves cause problems. Live-tested end to end in LM Studio: a stuck round now gets cut off and the model hands back a final answer instead of hanging.
  - Two issues only surfaced by live testing (not reproducible in unit tests, which mock the SDK): (1) `withPredictionLoopHandler` and `withToolsProvider` are mutually exclusive — registering both crashed the plugin's `main()` outright ("PredictionLoopHandler cannot be used with a tools provider"), so `withToolsProvider` is no longer registered; the loop handler already gets its tools by calling `toolsProvider()` directly. (2) `ctl.requestConfirmToolCall()` never resolves — confirmed live as a multi-minute hang with zero model activity — so `guardToolCall` no longer routes through it and allows tool calls directly, matching pre-existing behavior (LM Studio's default loop never required per-call confirmation for vibeLM's tools either).
  - Third issue, caught on review after the above: `maxPredictionRounds` only counts ROUNDS THAT COMPLETE — a round that never emits a tool call or stop token never completes, so it never counted against that limit, meaning the exact originally-reported failure (endless rambling with zero tool calls) was still unbounded for any model architecture outside the small always-reasoning special case. `resolveMainLoopRoundMaxTokens` now applies a per-round `maxTokens` ceiling (8000, or the existing always-reasoning floor where lower) to every architecture whenever bounds are enforced, so a single stuck round is forced to end regardless of model family. Live-verified this doesn't clip normal short responses.
  - Fourth issue, only found by a longer live stress test (forcing a multi-tool-call turn): `onMessage`'s `appendToolResult` call was throwing on every single tool call ("Tool results can only be appended to tool blocks. This is a assistant block.") — the SDK requires tool results on a separate `"tool"`-role content block from the one used for `appendToolRequest`/text (`"assistant"`-role); reusing one block for both silently corrupted every tool result's rendering (this had been happening in the background through several earlier "successful" live tests too — visible only as a permanently-spinning tool-status icon, which had been mistaken for a cosmetic gap). `predictionLoopHandler` now creates a second, dedicated `"tool"`-role block for results. The unit-test mock now enforces the same role gating the real SDK does, so this class of regression fails a unit test instead of only surfacing live.

## [0.2.9] - 2026-07-11

### Fixed
- **Main chat's thinking loop had no cap — only vibe_bridge ticks did.** Previously only the bridge had a prediction round limit; the primary chat could loop forever producing reasoning chains without calling a tool. Imported the shared `capPredictionRounds` into the main orchestrator loop so the host-assistant route also respects `maxThinkingSteps`.
- **`appendToolResult` was throwing on every tool call** — a regression that silently broke tool result rendering post-call. Real regression tests now cover this path.
- **`maxPredictionRounds` alone didn't bound the originally-reported failure** — the fix needed to apply at every model.act() call site, not only the one gating the tick channel.

## [0.2.8] - 2026-07-11

### Fixed
- **Plan steps never get created, starving vibe_bridge ticks of context** — real models reproducibly never call `create_plan` from either the interactive or tick channel (confirmed across 4 days of live session logs), so the auto-seeded goal-only plan sat with `steps: []` forever. `bootstrapSessionState` now forces a `create_plan` directive on the next goal-like turn, and the tick directive itself also tells the model to call `create_plan` when steps are empty. The tick tool list now includes `create_plan` so it can be called from the unattended path too.

### Changed
- Update README.md


## [0.2.7] - 2026-07-11

### Fixed
- **Expand literal `~` in file-tool paths** instead of treating it as a directory name — a model passing `filePath: '~/Desktop/...'` now correctly resolves the home directory instead of writing into a literal `~/` subdirectory within the workspace.

### Changed
- Ignore `.claude/` and `.agents/` directories in `.gitignore`.

## [0.2.6] - 2026-07-11

### Fixed
- **Plan state no longer bleeds across chats.** `bootstrapSessionState` now detects when a new
  conversation is dramatically shorter than the previously persisted history length and discards the
  stale plan instead of carrying it forward. Previously, a brand-new chat could inherit an unrelated
  plan from `runtime-state.json`.
- **New instructions no longer silently die after a fully-completed plan.** When every step in a
  plan reads "done" and the user sends a new goal, `preprocessMessageCore` now auto-appends a new
  pending step so the model actually executes it instead of replying in plain text and stopping.

## [0.2.5] - 2026-07-11

### Added
- **Plan steps can now override the session's `reasoningEffort` setting individually.** `create_plan`
  accepts either a plain string or `{ description, thinking }` per step (`thinking` is
  `"off"|"low"|"medium"|"high"`), and `update_plan_step` can set/change it later. When resolving the
  thinking directive for a bridge tick, the current step's override (the first `in_progress` step, or
  failing that the first `pending` one) wins over the session-wide config. This lets one plan mark
  mechanical steps "off" and a tricky step "high" instead of applying one uniform reasoning level to
  every step — the per-model-family directive mapping (`reasoningDirectiveFor`) already handled Qwen's
  binary `/think`/`/no_think` switch, gpt-oss's native Harmony tiers, and a generic natural-language
  fallback for everything else, so this only needed a new *source* for which effort to apply, not new
  per-family logic.

- **`vibe_bridge` ticks now give a generous `maxTokens` floor (6000) to architectures whose reasoning
  can't actually be turned off**, instead of leaving it uncapped or subject to whatever ambient
  per-model limit LM Studio applies. Live-tested against real loaded models across gpt-oss-20b,
  qwen3-4b, google/gemma-4-e4b, microsoft/phi-4-mini-reasoning, and nvidia/nemotron-3-nano-omni:
  qwen3's native `/no_think` switch works correctly (`reasoning_tokens: 1`), but gemma-4 and
  Nemotron-H kept producing full `reasoning_content` regardless of vibeLM's directive *or* NVIDIA's
  own documented `"detailed thinking off"`/`<thought off>` conventions, and LM Studio's own native
  `reasoning` REST setting (`/api/v1/chat`) outright rejected `"off"` for phi-4-mini-reasoning with
  `"Supported settings: 'on'"` — i.e. LM Studio itself confirms there is no off-switch for that model.
  Under a tight token budget this reasoning can consume the entire allowance before the model reaches
  its answer — reproduced live on phi-4-mini-reasoning, which returned empty `content` with
  `finish_reason: "length"` after burning 396 of 400 tokens on reasoning alone. `resolveBridgeTickMaxTokens(arch)`
  now detects this class of architecture (`gemma.?4|phi.?[34]|nemotron`) and gives it explicit headroom
  so a verbose reasoning phase can't silently starve the tick of room for its actual answer/tool call.

### Fixed
- **A mid-conversation `lms dev` hot reload (or plugin process restart) could silently drop an
  in-progress plan instead of resuming it.** `bootstrapSessionState()` had two paths for "the raw
  conversation history can't be matched against what was persisted": one for "history exists but its
  fingerprint doesn't match" (already correctly carried the last-known `plan`/`managedContextBlocks`
  forward) and one for "no history could be read at all" (hard-reset to a blank session, no carryover).
  The second path fires whenever the very first bootstrap call after a reload comes from a controller
  with no `pullHistory()` — which is exactly what happens when `vibe_bridge`'s background tick runs
  before any real `preprocessMessage()` call re-establishes history. Caught live: editing `toolsProvider.ts`
  while a real `vibe_bridge`-driven session was mid-plan triggered esbuild's watch rebuild, and the next
  tick came up with a brand-new `sessionId` and an empty plan — even though the plan was still sitting in
  `runtime-state.json` on disk the whole time. The no-history path now carries over the persisted plan
  and `managedContextBlocks` the same way the fingerprint-mismatch path already did.

- **Every real conversation turn silently started a brand-new session, resetting `turnCounter` to 0 and
  making auto-compaction, session-scoped fact-dedup, and the context-spine resume mechanism unreachable
  in production.** `toolsProvider()` forced a session-state re-bootstrap on every call using its own
  `ToolsProviderController`, which — unlike the `PromptPreprocessorController` — has no `pullHistory()`
  method (confirmed against the SDK's own type definitions). The forced bootstrap's history read always
  silently failed, so it always concluded "history unreadable, must be a fresh/rolled session" and
  manufactured a new random `sessionId`, discarding whatever `preprocessMessage()` had correctly
  established moments earlier in the same turn. Caught live driving a real multi-turn LM Studio
  conversation: `runtime-state.json`'s `sessionId` changed on every single turn and `turnCounter` never
  advanced past 0, even though the working-window/spine/compaction machinery all assume `sessionId`
  identifies one whole conversation, not one exchange. `toolsProvider()` no longer forces the bootstrap;
  it reuses the state `preprocessMessage()` already established for the turn.

### Known follow-up (not yet resolved)
- Live re-testing after the fix above still showed `sessionId` changing across some turns even without a
  process reload. Suspected contributing factors, not yet isolated: `vibe_bridge`'s background tick
  shares the same module-level session state via its own separate `model.act()` call (built from a
  minimal handover summary, not the real conversation history), and/or having two plugin instances
  (a `lms dev` instance and a stale production install) simultaneously enabled in LM Studio, each with
  independent in-memory state. Needs a clean, uncounfounded live session (fresh chat, `vibe_bridge`
  disabled from the start, single plugin instance) to isolate further.

## [0.2.4] - 2026-07-10

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

[Unreleased]: https://github.com/DrunkkToys/vibeLM/compare/v0.2.11...HEAD
[0.2.11]: https://github.com/DrunkkToys/vibeLM/compare/v0.2.10...v0.2.11
[0.2.9]: https://github.com/DrunkkToys/vibeLM/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/DrunkkToys/vibeLM/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/DrunkkToys/vibeLM/compare/v0.2.6...v0.2.7
[0.2.0]: https://github.com/DrunkkToys/vibeLM/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/DrunkkToys/vibeLM/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DrunkkToys/vibeLM/releases/tag/v0.1.0
