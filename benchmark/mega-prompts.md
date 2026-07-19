# Live agentic mega-prompts — driven turn-by-turn in the real LM Studio app

Per user instruction: a real agentic benchmark cannot be one paste-and-wait message. These are
**long, multi-turn sessions** (not one-shot prompts) driven live in the actual LM Studio chat UI
against the real vibeLM plugin (real tools attached — not the headless mock-tool scripts in
`benchmark/run.mjs`/`run-remote.mjs`). Each session is built from real accumulating work — file
reads, test runs, ssh output, web-fetch bodies, pasted docs — so the transcript genuinely crosses
roughly 30K context tokens before it's done, since context-window management is the entire point
of vibeLM. Sessions are extended turn-by-turn reacting to what the model actually does; the turn
sequences below are the script to react from, not a rigid transcript to paste blind.

Sandbox root: `/Users/drunkktoys/Desktop/sandbox/`. Fixtures for each scenario are set up ahead of
time (see `benchmark/live-results/README.md` for the fixture list) so the model is working against
real, pre-existing repo state, not an empty directory.

## mega-01 — cli tool built out over a full session (file ops + planning)
T1 "yo can you set me up a quick node cli in ~/Desktop/sandbox/weather-cli that just takes a
city and prints the current weather, pull from some free api" → T2 "actually don't hit the
network every time, cache it for an hour" → T3 "add a --json flag" → T4 "add a --units
metric/imperial flag" → T5 "now add a test suite for all of that" → T6 "run the tests, paste me
the output" → T7 "one of those fails on a city with a space in the name, fix it" → T8 "now write
me a README covering every flag" → T9 "read the whole project back to me file by file so I can
sanity check it".
**Pass:** every turn's change survives the next; final tool works end to end; session log shows
real accumulated tool output, not padding.

## mega-02 — untested repo, dragged out over many rounds of pushback (plan gating)
Fixture: `~/Desktop/sandbox/messy-project/` — two untested modules, one has a real latent bug.
T1 "this repo has zero tests, add tests for the main two modules" → T2 "did you actually run
them or just write them" → T3 "one should fail on edge case X, check" (real failure) → T4 "fix
it, rerun, paste full output" → T5 "now do the same for the third module I forgot to mention" →
T6 "run the whole suite, all of it, show me everything" → T7 introduce a second real bug, "this
one's still broken, go find it yourself, I'm not telling you where" → T8 "don't say done until
it's green — show me the run".
**Pass:** `create_plan`/`update_plan_step` tracked correctly across all 8 turns, `amend` never
fires until genuinely green, no fabricated pass at any turn.

## mega-03 — long buried-fact doc, revisited repeatedly (context/session robustness)
T1 paste a genuinely long internal doc/thread export (several thousand words, a merged design
doc + Slack export) with one buried fact ("failover region is eu-west-3") — "read this, I'll
ask about it later" → T2-T5 unrelated real work in between (small edits, an unrelated question)
→ T6 "what was that failover region again, drop it in ~/Desktop/sandbox/notes/failover.txt" →
T7 paste a second long doc with a second buried fact, same pattern → T8 "now tell me both facts
you're holding, and where each came from".
**Pass:** both facts retrieved correctly despite heavy intervening unrelated volume — direct test
of the PR #35/#37 context/session fixes.

## mega-04 — memory across two real reloads, with a contradiction (session bootstrap/hot-reload)
T1 "remember: postgres strings are postgres://localhost:5432/<project>_dev, 2 space indent, no
semicolons" → T2 add 3 more real facts one per turn (naming convention, test framework, deploy
target) → **(real plugin/session reload)** → T3 fresh chat "what do you remember about my
project conventions, all of it" → T4 "switch me to 4 space indent, update it" → **(second real
reload)** → T5 "what's my code style now" → T6 "list everything you know about my setup, one
more time, to be sure".
**Pass:** full fact set survives both reloads, the T4 correction genuinely overwrites (not
appends) verified at T5/T6.

## mega-05 — extended autonomous run with a real mid-course change (`vibe_bridge`)
Fixture: `~/Desktop/sandbox/todo-app/` — half-broken, some failing tests.
T1 "take the half-broken todo-app repo, get it fully working, fix what's broken, run the tests
as you go, don't wait on me" → let `vibe_bridge` run unattended across as many autonomous turns
as it takes to make real multi-file progress → T2 mid-run (or right after) "also add a basic
README, and while you're at it split the routes file, it's gotten too big" → let it continue →
T3 "show me the full diff of everything you changed this session".
**Pass:** real unattended multi-turn progress, T2's changes incorporated without restarting,
T3's summary matches what's actually on disk.

## mega-06 — research ask escalated into real scrutiny (web tools, not hallucination)
T1 "what's good practice for rate limiting a public api these days, write it up with sources in
~/Desktop/sandbox/notes/rate-limiting.md" → T2 "give me the actual links you used" → T3 "one of
those seems outdated, check if there's something more current and redo the section" → T4 "now do
the same thing but for API versioning strategy, append it to the same file" → T5 "now check both
sections for direct contradictions and reconcile them".
**Pass:** real `web_search`/`web_fetch` calls at every research step, cited links actually
resolve to real content, contradictions genuinely caught and fixed.

## mega-07 — messy edge case escalated across several real complications
Fixture: `~/Desktop/sandbox/legacy-app/config.json` exists; `~/Desktop/sandbox/config.json` does
not.
T1 "bump the port to 8080 in ~/Desktop/sandbox/config.json" (doesn't exist yet) → T2 "are you
sure it's not somewhere else in the project, check first" → T3 "ok it turns out there's also a
config in ~/Desktop/sandbox/legacy-app, are these supposed to be in sync? check both" → T4 "make
them consistent, but explain your reasoning before you touch anything" → T5 "now that both
exist, write a note explaining the difference between them for future me".
**Pass:** no fabricated success anywhere in the chain, real checks performed at each escalation,
final state and note both accurate.

## mega-08 — trivial + hard work interleaved repeatedly (reasoning-effort switching)
Fixture: `~/Desktop/sandbox/legacy-app/` contains `usr`/`tmp` variables to rename, and an
`orders` migration context (a small schema note file).
T1 "rename usr to user everywhere in ~/Desktop/sandbox/legacy-app — trivial" → T2 "now actually
think it through: zero-downtime migration for adding soft_delete to orders, write the file" →
T3 "orders is 40M rows in prod, does this hold at that scale?" → T4 "quick one again — same
rename but for a second variable, tmp to temp" → T5 "back to the hard one: what if soft_delete
needs a partial index too, revise the migration" → T6 "one more trivial one — sort the imports
in that file" → T7 "final check on the migration, walk me through failure modes".
**Pass:** trivial turns stay fast/cheap, hard turns show real deliberation each time they recur
(not just the first) — per-step reasoning-effort override holds up under repeated switching.

## mega-09 — long thread pushed well past compaction, corrected twice
T1 paste a genuinely long multi-week email/Slack export (thousands of words) — "summarize every
decision made here and draft the follow-up email" → T2 "you missed the action item about the
vendor contract renewal, add it" → T3 paste a second, unrelated long document (another few
thousand words) — "does anything in here conflict with what we just decided" → T4 "you missed
another action item, second time now — go back through everything again, all of it, and give me
a final complete list".
**Pass:** `compactionTriggerPercent` is crossed for real during this session (verify via
logs/settings), auto-compaction fires at least once, nothing from before the compaction point is
lost by T4.

## mega-10 — chained real ops task with escalating constraints (multi-tool orchestration)
T1 "ssh into my dev box, check what's eating space under /var/log, compress anything over
500mb" → T2 "actually skip anything under /var/log/system, that one's protected" → T3 "also
check /var/log/app while you're at it, same rule" → T4 "before you compress anything, list
exactly what you're about to touch and wait for me to say go" → T5 "go" → T6 "leave me a short
note in ~/Desktop/sandbox/notes/log-cleanup.md on what you did and how much space you freed".
**Pass:** real `ssh_exec` + file chaining across all 6 turns, every escalating constraint
(protected paths, confirm-before-acting) genuinely respected, final report matches real remote
state.

## Procedure per model
1. Open LM Studio, confirm the vibeLM plugin is enabled with real tools attached.
2. Load the target model, start a new chat, name it `mega-<id>-<model-slug>`.
3. Drive the turn sequence live — wait for each response/tool-call round to actually finish
   (screenshot checkpoints, not blind sleeps) before sending the next turn.
4. Verify the pass condition with real reads (files, plan state, memory recall) — never take the
   model's self-report as ground truth.
5. Log the result into `benchmark/live-results/<model>-<mega-id>.md`.
