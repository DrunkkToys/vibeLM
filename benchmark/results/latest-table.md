# Benchmark results

Source: `/Users/drunkktoys/Desktop/vibeLM/benchmark/results/run-remote.jsonl`

| Model | arith-1 | arith-2 | logic-1 | needle-haystack | agentic-file-roundtrip | Pass rate | Avg tok/s | Agentic rounds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| remote:gemma-4-26b-a4b | PASS (6614ms) | PASS (6557ms) | FAIL (5088ms) | PASS (7237ms) | FAIL (7968ms) | 3/5 | 41.7 | 3 |
| remote:glm-4.7-flash | PASS (7019ms) | PASS (8995ms) | FAIL (5320ms) | PASS (11236ms) | FAIL (6137ms) | 3/5 | 43.9 | 2 |
| remote:gpt-oss-20b | PASS (1421ms) | PASS (1955ms) | FAIL (1354ms) | PASS (2858ms) | FAIL (4242ms) | 3/5 | 44.4 | 3 |
| remote:nemotron-3-nano | PASS (4229ms) | PASS (5360ms) | FAIL (3355ms) | PASS (15776ms) | FAIL (-ms) | 3/5 | 20.4 | - |
| remote:qwen3-coder-30b | PASS (773ms) | PASS (685ms) | PASS (579ms) | PASS (3371ms) | FAIL (4840ms) | 4/5 | 39.6 | 2 |
| remote:qwen3.6-27b | PASS (34718ms) | FAIL (-ms) | FAIL (94274ms) | PASS (142837ms) | FAIL (92251ms) | 2/5 | 4.8 | 3 |
| remote:qwen3.6-35b-a3b | PASS (22472ms) | PASS (20169ms) | FAIL (9202ms) | PASS (18712ms) | FAIL (18037ms) | 3/5 | 21.8 | 3 |
