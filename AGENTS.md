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
11. **Make sure CI is green** — check GitHub Actions
12. **Merge** — merge PR after CI passes
13. **Create skills** — document the pipeline for training

## Test Types

- **Cascade test** — integration test that tests full plugin flow
- **Contract test** — verifies tool definitions match expected schema
- **Unit test** — tests individual functions

## CI Requirements

- All tests must pass
- TypeScript must compile without errors
- Build must succeed
- Plugin must install correctly
