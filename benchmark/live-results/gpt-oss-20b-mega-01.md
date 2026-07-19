# mega-01 × openai/gpt-oss-20b

Model: openai/gpt-oss-20b (auto-loaded context: 131072)
Chat: "Quick Node Weather CLI" (LM Studio, vibeLM plugin, real tools attached)
Note: this run happened after PR #39's two bug fixes were built and deployed locally.

## Pre-run anomalies
- Reset `~/Desktop/sandbox/weather-cli` and cleared `runtime-state.json` before starting.
- Waited for full turn settlement (send button showing up-arrow, verified via zoom) before sending T2, avoiding the abort-race error seen with other models.

## Turn 1
Prompt: "yo can you set me up a quick node cli in ~/Desktop/sandbox/weather-cli that just takes a city and prints the current weather, pull from some free api"

Wrote `weather-cli/index.js` using native `fetch()` against wttr.in (free, no API key), `format=3` short output.

Verified independently: ran `node index.js London` myself → real output `London: ☀️ +28°C`.

**T1: PASS.**

## Turn 2
Prompt: "actually don't hit the network every time, cache it for an hour"

Model's response (after ~40s "thinking"): opened with "Your CLI is already there – just tweak it so it works for multi-word city names and gives a clean 'usage' message," then produced a multi-step writeup (fix multi-word city args, `chmod +x`, optional `npm link` global install, a "sanity test" section) — **never mentioned or implemented caching at all**.

Verified against real disk state: `cat ~/Desktop/sandbox/weather-cli/index.js` shows the file is **byte-identical to the original T1 version** — no multi-word-arg fix, no chmod, no caching. `grep -i cache index.js` → 0 matches. The model never called `write_file` or `bash_terminal` in this turn at all; the entire elaborate response (code blocks, chmod commands, npm link instructions) was text-only output that was never executed.

Checked `runtime-state.json`: `plan.steps` is `[]` (empty) — this model, like qwen3.6-27b, never called `create_plan` with real tracked steps. PR #39's Bug-2 fix only engages when `plan.steps.length > 0`, so it correctly did not fire here — there was no tracked "done" state to reopen, because none was ever tracked.

**T2: FAIL** — same category as qwen3.6-27b's failure (no plan tooling used → fix's guard doesn't apply), but a more extreme variant: the model didn't even re-verify existing files via tool calls this time, it fabricated an entire "fix" narrative with code samples that were never written to disk.

## Scenario verdict: FAIL (stopped after T2)
T1 passed cleanly (real free API, verified working). T2 failed — instruction ignored, and unlike other FAILs in this benchmark, the model's response text described tool actions (chmod, npm link) that never actually happened on disk. Confirms the broader limitation already flagged for qwen3.6-27b: PR #39's fix only helps models that use plan/step tracking; models that skip it (majority of local models tested so far) still fail here through the pre-existing, unaddressed root cause.
