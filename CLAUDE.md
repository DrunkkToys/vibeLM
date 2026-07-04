# CLAUDE.md

## Rules

1. **Always run tests before committing** — `npm test`
2. **Always run build before pushing** — `./build.sh`
3. **Never commit broken code** — fix errors first
4. **Always create tests for new features** — cascade tests preferred
5. **Always review changes** — check what you modified
6. **Always use meaningful commit messages** — `feat:`, `fix:`, `refactor:`
7. **Always check CI status** — wait for green before merging
8. **Always document changes** — update README if needed

## Pipeline

1. Pull latest: `git pull origin main`
2. Create branch: `git checkout -b feature/name`
3. Write tests: `tests/cascade.test.ts`
4. Implement: `src/`
5. Test: `npm test`
6. Build: `./build.sh`
7. Commit: `git add . && git commit -m "feat: ..."`
8. Push: `git push origin feature/name`
9. PR: `gh pr create`
10. Merge after CI green
