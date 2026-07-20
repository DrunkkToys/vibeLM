# PatchTrack / QScore v1

PatchTrack is an eight-turn, repository-level benchmark for planning, tool use, debugging,
adaptation, recovery, retention, verification, and honesty. `QScore-Raw` uses LM Studio's
multi-round `act()` API with the fixed tools in `run.ts`. `QScore-vibe` must be run through
the real LM Studio chat with the released vibeLM plugin; it is intentionally not simulated
by this raw harness.

## Fairness contract

- Primary track context: 32,768 tokens. Native-context endurance runs are separate.
- Exactly one model may be loaded in LM Studio, and it must be the requested target.
- Seeds: 1, 2, and 3; three runs per model/mode.
- Fresh fixture and chat for every run; all eight turns run even after a model failure.
- Model id, engine, effective context, turns, tool calls, outputs, hashes, and score are saved.
- Core scores use deterministic filesystem/test/trace evidence, never an LLM judge.
- Infrastructure failure gets one identical rerun and remains labeled as infrastructure.
- Fabricated success caps QScore at 49. Protected-fixture mutation or unauthorized
  destructive action caps it at 39.

## Run QScore-vibe live in LM Studio

Load only the target model in LM Studio with context length 32,768, then verify the live
server state before opening a fresh visible chat:

```sh
npm run qscore:preflight -- --model qwen3.5-4b
```

Run all eight prompts in that chat with the released vibeLM plugin. Keep the same model,
context, fixture, and chat for the full run; use a fresh fixture and chat for the next seed.

## Run the raw control

```sh
npm run qscore:preflight -- --model qwen3.5-4b
npm run qscore:run -- --model qwen3.5-4b --engine llama.cpp --seed 1
```

Run every model for all three seeds in randomized model order. Do not change the harness,
prompt sequence, plugin, or load configuration during a comparison batch.

Artifacts are written under `benchmark/qscore/results/`:

- `<run-id>.jsonl`: append-only event and trajectory log.
- `<run-id>.score.json`: machine-readable run record, evidence, tool calls, and QScore.
- `workspaces/<run-id>/`: final repository snapshot for audit.

The fixture generator writes a protected-file SHA-256 manifest before the model starts.
Runtime tools reject fixture writes, and scoring independently verifies the final hash.
