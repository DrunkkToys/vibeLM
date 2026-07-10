# CODEX

## Codex Rules

### Before Starting
- `git pull origin main`
- `npm install`
- `npm test` (verify clean state)

### During Development
- Write cascade test FIRST
- Implement feature
- Run `npm test` after each change
- Run `./build.sh` to verify build

### Before Committing
- Run `npm test` — all must pass
- Run `./build.sh` — must succeed
- Review `git diff` — understand changes
- Check `git status` — only intended files

### Commit Message Format
```
feat: add new feature
fix: fix bug in X
refactor: restructure Y
test: add cascade test for Z
docs: update README
```

### After Pushing
- Check CI status on GitHub (`test.yml`, Node 20 & 22)
- Wait for green
- Merge PR — `main` needs 1 review; solo repo uses an admin merge (`gh pr merge <#> --merge --admin`). If your `--admin` is blocked by the safety classifier, surface the command for the human.
- Pull latest: `git pull origin main`

### Releasing
- Publishing happens by pushing a `vX.Y.Z` tag (not by merging). The tag triggers `release.yml` → GitHub Release + npm publish.
- LM Studio Hub publish self-skips on hosted runners (no `lms` CLI); do it manually with `lms push` if needed.

## Skills

Reusable workflows live in `.claude/skills/` — use them instead of re-deriving:
- **add-setting** — add a `tools.*` plugin config setting end to end.
- **release** — the full release pipeline described above.
