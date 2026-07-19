# Agents

## Pipeline Rules

1. **Start from last master** — always `git pull origin main` before starting
2. **Create new branch** — `git checkout -b feature/description`
3. **Create cascade test** — write `tests/cascade.test.ts` first
4. **Wire cascade test** — ensure `npm test` runs it
5. **Code prompt** — implement the feature
6. **Review what you have done** — run `npm test`, check output
7. **Amend** — `git add . && git commit --amend` if needed
8. **Create PR** — `gh pr create` with description
9. **Commit** — `git add . && git commit -m "feat: description"`
10. **Push** — `git push origin feature/description`
11. **Make sure CI is green** — `test.yml` runs on Node 20 & 22
12. **Merge** — after CI passes. `main` needs 1 review; on this solo repo use an admin merge (`gh pr merge <#> --merge --admin`). Agents: `--admin` is blocked by the safety classifier — surface the command for the human.
13. **Release** — publishing happens by pushing a `vX.Y.Z` tag, which triggers `release.yml` (GitHub Release + npm). Not by merging.

## Skills

Reusable workflows are captured under `.claude/skills/` — use them instead of re-deriving the steps:

- **add-setting** — add a `tools.*` plugin config setting end to end (config field → resolver → wire → cascade test → README + CHANGELOG).
- **release** — full release pipeline: preflight → bump → CHANGELOG/README → PR → CI → merge → tag → npm/GitHub publish (LM Studio Hub step self-skips on hosted runners).

## Test Types

- **Cascade test** — integration test that tests full plugin flow
- **Contract test** — verifies tool definitions match expected schema
- **Unit test** — tests individual functions

## CI Requirements

- All tests must pass
- TypeScript must compile without errors
- Build must succeed
- Plugin must install correctly
