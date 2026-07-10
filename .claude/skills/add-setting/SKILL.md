---
name: add-setting
description: Add a new user-facing configuration setting to the vibeLM LM Studio plugin, end to end. Use this whenever the user wants to add, expose, or make configurable a setting, config option, toggle, knob, threshold, or limit in the plugin settings — e.g. "let users set X", "make X configurable", "add a setting for X", "why is X hardcoded". Covers the config schema field, the resolver, wiring it into behavior, a cascade test, and README + CHANGELOG updates.
---

# Add a vibeLM plugin setting

Every user-tunable behavior in vibeLM follows the same five-part pattern. Settings live under the `tools` scope in the LM Studio plugin config. Follow all five parts — a setting that isn't read, tested, and documented is not done.

## 1. Declare the field — `src/config.ts`

Add a `.field(...)` to the `tools` scope in `configSchematics`. The SDK supports these value types (`createConfigSchematics().field(key, type, params, default)`):

- `numeric` — params: `int`, `min`, `max`, `slider: { min, max, step }`. For counts, thresholds, token limits.
- `boolean` — on/off toggles.
- `select` — params: `options: (string | { value, displayName })[]`. For enumerated choices (e.g. an effort level).
- `string` — free text; `isParagraph`, `placeholder` available.

Write the `subtitle` to explain the trade-off and *why* the user would change it, not just what it is. Mirror an existing field (e.g. `maxOrchestratorTurns` for numeric, `reasoningEffort` for select) for exact shape.

## 2. Add a resolver — `src/toolsProvider.ts`

Add a `resolve<Name>(ctl)` next to the other resolvers (`resolveMaxOrchestratorTurns`, `resolveReasoningEffort`, `resolveCompactionTriggerRatio`, `resolveMaxThinkingSteps`). Read via the shared helper and validate/clamp, falling back to a `DEFAULT_*` constant:

```ts
function resolveThing(ctl?: any): number {
  const raw = readPluginConfigValue(ctl, ["tools.thing", "thing"]);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(MIN, Math.min(MAX, Math.floor(raw)));
  }
  return DEFAULT_THING;
}
```

- Always pass both key forms `["tools.thing", "thing"]` — `readPluginConfigValue` tries them in order and tolerates a missing `getPluginConfig`.
- Keep the hardcoded value you're replacing as the `DEFAULT_*` constant so behavior is unchanged when unset.
- **Export the resolver** if you want to unit-test it directly (the cascade tests import resolvers by name).

## 3. Wire it into behavior

Replace the hardcoded constant at the call site with the resolver, threading `ctl`/`ctx` through if needed. Prefer a **single chokepoint**: e.g. context-window budgeting all flows through `getContextWindow`, so capping there covers every consumer. If the consuming function can't reach `ctl`, add an optional parameter defaulting to the constant and pass the resolved value from the caller that does have `ctl`.

## 4. Cascade test — `tests/cascade.test.ts`

Add a test in cascade style (`node:test`). For a pure/exported resolver, mock `ctl` inline — no need to touch the shared `makeCtl`:

```ts
it("resolveThing reads config, clamps, and defaults", async () => {
  const { resolveThing } = await import("../src/toolsProvider");
  const ctl = (v: unknown) => ({ getPluginConfig: () => ({ get: (k: string) => (k.endsWith("thing") ? v : undefined) }) } as any);
  assert.equal(resolveThing(ctl(50)), 50);
  assert.equal(resolveThing(ctl(9999)), MAX);   // clamps
  assert.equal(resolveThing({} as any), DEFAULT_THING); // default when unset
});
```

For settings that change orchestrator/bridge behavior, extend the relevant test harness's config mock (see `makeCtl` in `tests/vibe-bridge.test.ts`) and assert the effect (e.g. the value reaches `model.act`'s options).

## 5. Document — README.md + CHANGELOG.md

- **README.md** — add a row to the settings table (`| tools.thing | type | default | one-line description |`) and, if the behavior is subtle, a bullet in "How It Works" explaining the trade-off and how it relates to adjacent settings (avoid leaving the user with overlapping dials they can't reason about).
- **CHANGELOG.md** — add the setting under `### Added` in the `[Unreleased]` (or current) version section.

## Verify

```bash
npm test && ./build.sh
```

Both must pass. New settings default to preserving existing behavior, so no other test should change.

## Then

Adding a setting is usually part of a release — hand off to the `release` skill when the user wants to ship it.
