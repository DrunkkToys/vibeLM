# mega-01 × qwen/qwen3.5-9b

**BLOCKED — model failed to load.**

LM Studio error: `Failed to load model: ValueError: The mlx-vlm batched vision path does not support KV cache quantization yet.`

Same real environment/framework limitation as `gemma-4-26b-a4b-qat` (both are MLX vision-capable models hitting the same MLX/LM Studio KV-cache-quantization incompatibility). Not fixable from the chat UI without changing model load parameters, which the user explicitly instructed not to touch. Not retried with different load settings for that reason.

**Verdict: BLOCKED, not run.**
