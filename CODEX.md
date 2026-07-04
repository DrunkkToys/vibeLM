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
- Check CI status on GitHub
- Wait for green
- Merge PR
- Pull latest: `git pull origin main`
