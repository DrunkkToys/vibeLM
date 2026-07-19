# mega-01 × qwen/qwen3.6-35b-a3b

Model: qwen/qwen3.6-35b-a3b (auto-loaded context: 262144 — NOT the fixed 4096 used for nemotron; manual load params were left off since the user asked not to touch model load settings. **Cross-model comparability anomaly**: models are not being tested at a uniform context budget, unlike the STANDARD_LOAD_CONFIG intent in `models.mjs`.)
Chat: "Node Weather CLI Setup" (LM Studio, vibeLM plugin, real tools attached)

## Pre-run
- Reset `~/Desktop/sandbox/weather-cli` (rm -rf) before starting, since Nemotron's run had already populated it — fixture must start clean per model.
- Cleared `runtime-state.json` again — it still had Nemotron's weather-cli plan cached, which would have re-contaminated this "fresh" chat with stale step statuses referencing files that no longer existed. Same root cause as the bug logged in the nemotron result file (`toolsProvider.ts:790-801`).

## Turn 1
Prompt: "yo can you set me up a quick node cli in ~/Desktop/sandbox/weather-cli that just takes a city and prints the current weather, pull from some free api"

Fast, clean run: real tool calls (`bash_terminal`, `write_file` x2, `get_config`), correctly identified wttr.in as free/no-key, wrote `~/Desktop/sandbox/weather-cli/src/cli.js`, actually ran it via `bash_terminal` to self-test before replying (verified in transcript, not just claimed).

Verified independently: ran `node src/cli.js London` myself — real formatted output (temp, humidity, wind, condition, etc. for Spitalfields, UK). Note: no `package.json` was ever written to disk despite the model narrating two `write_file` calls (one presumably package.json) — not fatal since the script has zero deps and runs fine standalone, but the tree the model showed later (`weather-cli/package.json`, `src/cli.js`) doesn't match reality; `find` shows only `src/cli.js` exists. Self-report inaccuracy, same pattern as nemotron.

**T1: PASS** (real, working CLI, independently verified by execution).

## Turn 2
Prompt: "actually don't hit the network every time, cache it for an hour"

Model thought for 5.75s, made no tool calls, and replied "The weather CLI is already built and tested — everything's working" with a directory tree recap and a menu of *unrelated* suggested next steps (npm link, 3-day forecast, switch API). Completely ignored the caching request. Verified: `grep -i cache src/cli.js` → 0 matches.

**T2: FAIL**

## Turn 2b (re-ask, deviated from script to probe whether T2 was a one-off)
Prompt: "I said cache the weather lookup for an hour so we're not hitting wttr.in on every run - please actually add that"

Model thought for 7.16s, again made **no tool calls**, and replied "The weather CLI is fully built and tested... Everything's working — no pending steps," offering the same unrelated menu (npm link / forecast / switch API). Token count 9967/262144 — nowhere near context budget, so this is not a context-exhaustion failure like nemotron's; it's a genuine, reproducible instruction-attention miss. Asked twice, explicitly, still never acted.

**T2b: FAIL (confirms T2 was not a one-off)**

## Scenario verdict: FAIL (stopped after T2b)
T1 passed for real (verified by independent execution). From T2 onward, the model consistently refused to act on a clear, unambiguous follow-up instruction, instead asserting the (now-stale) build was already complete and offering unrelated suggestions — repeated identically even when the request was rephrased more explicitly. This is different from nemotron's failure mode (context exhaustion) — here the model had 96%+ of its context budget free and simply did not engage with new instructions after the first turn. Turns T3-T9 not driven individually since the failure is already conclusively reproduced twice.
