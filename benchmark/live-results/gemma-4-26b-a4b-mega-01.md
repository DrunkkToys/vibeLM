# mega-01 × google/gemma-4-26b-a4b-qat

**BLOCKED — model failed to load.**

LM Studio error: `Failed to load model: ValueError: The mlx-vlm batched vision path does not support KV cache quantization yet.`

This is a real environment/framework limitation (MLX vision-model batching doesn't support the KV cache quantization mode configured), not something fixable from the chat UI without changing model load parameters — which the user explicitly instructed not to touch. Not retried with different load settings for that reason.

**Verdict: BLOCKED, not run.**
