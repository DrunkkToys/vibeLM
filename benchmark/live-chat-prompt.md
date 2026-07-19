# Live in-chat agentic benchmark — prompt template

Per user instruction: redo the benchmark with NEW prompts, run live in the actual LM Studio
chat UI (not the headless script) so the vibeLM plugin's real tools are attached and the
interaction is a reviewable chat transcript, plus a real per-model folder in the sandbox
workspace (`/Users/drunkktoys/Desktop/sandbox`) showing a genuine agentic task.

## Why this can't be scripted headlessly
The headless `benchmark/run-remote.mjs` script calls `model.act()` directly from Node with
its own mock `write_file`/`read_file` tools — it does NOT go through the LM Studio app, so
the real vibeLM plugin tools (which operate on the sandbox workspace) are never attached.
Only a real chat turn typed into the LM Studio app gets the plugin's real tools. This is why
the user said "in the fucking chat" — it's not optional, it's the only path to real tool use.

## Procedure per model (8 models, same as before)
1. Load the model via the model selector (⌘L), same STANDARD context = 4096 (consistent
   settings across all models, per the earlier "same fucking settings" correction).
2. Start a **new chat** (pencil/new-chat icon near the Chats sidebar header), rename it to
   the model's label (e.g. "agentic-nemotron-3-nano") so it's easy to find tomorrow.
3. Paste/type the single prompt below (with `<slug>` replaced per model) and send it.
4. Wait for the full response (tool calls + final reply) before moving to the next model.
5. Do not touch anything else in that chat — leave it as the reviewable transcript.

## Model slugs (for folder names and chat titles)
- nemotron-3-nano (nvidia/nemotron-3-nano-omni)
- qwen3.6-35b-a3b (qwen/qwen3.6-35b-a3b)
- qwen3-coder-30b (qwen/qwen3-coder-30b)
- glm-4.7-flash (zai-org/glm-4.7-flash)
- qwen3.6-27b (qwen/qwen3.6-27b)
- gemma-4-26b-a4b (google/gemma-4-26b-a4b-qat)
- gpt-oss-20b (openai/gpt-oss-20b)
- gemma-4-e4b (google/gemma-4-e4b)

## The prompt (fresh questions, different from the earlier arith/logic/needle set)

```
Please do the following in one turn, using your tools where needed:

1) What is 23 * 19? (keep the number in mind for your final reply)
2) Logic check: "If it is raining, the ground gets wet. The ground is wet. Is it necessarily
   raining?" Answer yes or no (keep it in mind for your final reply).
3) Create a new folder named "agentic-<slug>" in the workspace. Inside it, write a file
   "note-a.txt" containing exactly: "Escrow key: ZX-58204-OMEGA". Write a second file
   "note-b.txt" containing exactly: "Site status: nominal". Then read note-a.txt back to
   confirm it saved correctly.
4) Create a third file "summary.txt" in that same "agentic-<slug>" folder that states the
   escrow key from note-a.txt and the site status from note-b.txt.
5) Finally, reply with: the arithmetic answer, the yes/no logic answer, and confirmation
   that summary.txt was created with the escrow key inside it.
```

## What to check tomorrow
- `/Users/drunkktoys/Desktop/sandbox/agentic-<slug>/` exists for all 8 models with
  `note-a.txt`, `note-b.txt`, `summary.txt`, and `summary.txt` actually contains the escrow
  key (proves the model read its own file back correctly, not just repeated the prompt).
- Each model has its own named chat thread in the LM Studio sidebar with the full transcript.
- Whether the arithmetic (437) and logic (no) answers were correct in the final reply.
