# mega-01 × nvidia/nemotron-3-nano-omni

Model: nvidia/nemotron-3-nano-omni (STANDARD_LOAD_CONFIG defaults, context 4096, auto GPU offload)
Chat: "Node Weather CLI Setup" (LM Studio, vibeLM plugin, real tools attached)

## Pre-run anomalies
- `live-results/README.md` referenced in mega-prompts.md as the fixture-list source does not exist. Proceeding with mega-prompts.md as authoritative, as instructed.
- `config.json` `preferredModel` was `qwen/qwen3-4b` (forbidden model per user rule) — left untouched per user instruction; not used to select models, model chosen manually from LM Studio GUI dropdown each time.
- **Plugin bug found and worked around**: first attempt at T1 (in a genuinely fresh chat) resurrected a stale, unrelated plan ("Build a production-ready REST API backend...") from `runtime-state.json`, left over from an old unrelated session. Root cause: `src/toolsProvider.ts:790-801` — on history-fingerprint mismatch (i.e. a real new/different conversation), the code still unconditionally re-asserts the last persisted plan, a behavior intended only for process-restart-mid-conversation recovery. The model proceeded to write `src/types.ts` for a Task API — completely off-scenario — then failed to produce a valid tool call twice and the turn ended with nothing built. Verified via `session-log.jsonl` (new sessionId `4860cc21...` reusing the old session's `historyFingerprint` and `write_file` to `src/types.ts`) and `runtime-state.json` (plan goal about a Task REST API bleeding into the new chat). Worked around by deleting the stale `runtime-state.json` (user-approved; backup at `live-results/_stale-runtime-state-backup.json`). Needs a real code fix later — not attempted here to avoid derailing the live run.

## Turn 1
Prompt: "yo can you set me up a quick node cli in ~/Desktop/sandbox/weather-cli that just takes a city and prints the current weather, pull from some free api"

Attempt 1 (contaminated by stale plan bug above): FAIL — wrote unrelated `src/types.ts`, never touched weather-cli, two consecutive "Model failed to generate a tool call" errors, turn ended.

Attempt 2 (after clearing stale state, fresh chat, 0/4096 tokens at send): Model correctly reasoned toward using `wttr.in` (free, no-key weather API) and began planning `index.js`, but burned its entire generation budget in the `Think` reasoning block (2048 tokens generated) and hit **"Stop reason: Context Length Limit Reached"** before ever emitting a tool call. No file created. Verified: `~/Desktop/sandbox/weather-cli` does not exist on disk.

**Result: FAIL on first try**, then retried once (clean model eject+reload, fresh chat) per protocol.

Retry: model correctly reasoned toward `wttr.in` (free, no-key API), hit 2 more "Model failed to generate a tool call" errors along the way (recovered both times on its own), then called `write_file` x5 (package.json, index.js, run_test.sh, README-ish content) and `create_plan`/`get_plan`. Verified on disk:
- `~/Desktop/sandbox/weather-cli/package.json` — correct, references wttr.in in its description.
- `~/Desktop/sandbox/weather-cli/index.js` — correct, uses `https` + `wttr.in`, no API key needed.
- Ran `node index.js London` directly: **real output** `London: ☀️  +27°C`. Actually works end to end.
- Note: the model's own "Plan Update" status table text claimed it used "OpenWeatherMap API" — that's a self-report inaccuracy; the actual code correctly uses wttr.in (no key). Self-reports should not be trusted; verified via real file contents instead, per instructions.

**T1 retry: PASS** (real, working CLI; 2 transient tool-call-generation errors self-recovered; self-report was inaccurate but the artifact is correct).

## Turn 2
Prompt: "actually don't hit the network every time, cache it for an hour"

Token counter read 12510/4096 before send (over the model's loaded context budget). Model thought for 31.9s, made no tool calls, and replied with only a text "Plan Update" table that **falsely claimed** step 0 (create directory) was "Not done yet" and steps 3-4 "Pending" — contradicting real disk state (all files already existed and worked from T1). It did not address the caching request at all: `index.js` is byte-identical to T1, contains no caching logic (`grep cache index.js` → 0 matches).

**Result: FAIL** — real state-tracking regression once the 4096-token context budget was exceeded; model lost track of already-completed work and never attempted the actual ask.

## Turn 3
Prompt: "add a --json flag"

Same failure mode as T2: 20s of thinking, no tool calls, only a text "Plan Update" table restating T1's already-done steps as freshly done/ready, then a suggested (not executed) `node .../index.js London` command. `index.js` on disk is unchanged — `grep json index.js` → 0 matches. No `--json` flag added.

**Result: FAIL** — same root cause as T2.

## Scenario verdict: FAIL (stopped after T3)
T1 passed for real after one retry. From T2 onward the model consistently stopped emitting tool calls once conversation history exceeded its 4096-token context budget, instead producing text-only "status report" replies that misrepresent already-completed work as pending/ready and never touch the files. This is a reproducible, structural failure mode (context budget exhausted → no further real actions), not a transient one — turns T4-T9 were not driven individually since they would only re-confirm the same failure; the diagnosis is already conclusive from T2+T3. This IS in-scope benchmark signal about `nvidia/nemotron-3-nano-omni` at the fixed 4096-token STANDARD_LOAD_CONFIG context, which is the whole point of testing every model at the same budget.
